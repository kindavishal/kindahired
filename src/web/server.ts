import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { env, loadProfile, TIMEZONE } from "../config.ts";
import { outreachForOpportunity } from "../db/contacts.ts";
import { all, get, nowIso, run } from "../db/index.ts";
import { getOpportunity, updateOpportunity, type Opportunity } from "../db/opportunities.ts";
import { completeAction, dueActions, reconcileActions, remindAgain, snoozeAction, stalledRoles, type ActionRow } from "../loops/engine.ts";
import { BOARD_LABEL, boardUrl, describeCompanyScan, getCompany, knownPeopleAt, listCompanies, removeCompany, setCompanyStatus, type CompanyScan } from "../pipeline/companies.ts";
import { getBrief, type HiringBrief } from "../pipeline/hiring-brief.ts";
import { keepsInTouch, loadRelationships, logTouch, setStayInTouch, type Relationship } from "../pipeline/relationships.ts";
import { DEFAULT_TIMERS, getTimers, resetTimers, setTimers, TIMER_SPECS, type TimerKey } from "../loops/timers.ts";
import { NOT_A_POSTING } from "../notify/messages.ts";
import { rebuildResume } from "../pipeline/pack.ts";
import { applyEdits, blanksIn, type Edits } from "../resume/edit.ts";
import { renderResumePdf, resumeHtml } from "../resume/render.ts";
import type { Resume } from "../resume/schema.ts";
import { describeResult, getSource, listSources, removeSource, setSourceStatus, type ScanResult } from "../pipeline/sources.ts";
import {
  STATUS, badge, closesLabel, copyBlock, day, daysFrom, dueLabel, emptyState, esc, fitBadge, icon, linkButton, page, plural,
  postButton, setNavCounts, setShellPort, sourceLabel, statusBadge,
} from "./ui.ts";
import { isLink, searchAll, searchPageBody } from "./search.ts";
import { handleWorker } from "../worker/routes.ts";
import { interviewCard, interviewPage, interviewsPage, upcomingCount, upcomingInterviews } from "./interviews.ts";
import { clearOpened, directActions, markOpened, openedTasks, type Direct } from "./actions.ts";
import { telegramConnectRoute } from "./telegram-connect.ts";
import { desktopConnectRoute } from "./desktop-connect.ts";
import { googleConnectRoute } from "./google-connect.ts";
import { setupCallout, setupRoute } from "./setup.ts";
import { setupProfileRoute } from "./setup-profile.ts";
import { setupPlaybookRoute } from "./setup-playbook.ts";
import { setupKeysRoute } from "./setup-keys.ts";
import { setupExportRoute } from "./setup-export.ts";
import {
  alertFunnel, clearStaleDrafts, interviewStats, isLead, outreachStats, pct, readyIcRoles, replyWindow, splitStories,
  stageCounts, waitingForReply, weeklyPace, type Split,
} from "./insights.ts";

type Hooks = {
  addLink: (url: string, note?: string) => Promise<string>;
  watchPage: (url: string, opts: { label?: string; intervalHours?: number; via: string }) => Promise<{ text: string; id?: number }>;
  scanNow: (id: number, opts?: { report?: boolean; force?: boolean }) => Promise<unknown>;
  addCompanies?: (text: string, via: string) => Promise<{ lines: string[]; ids: number[] }>;
  scanCompany?: (id: number, opts?: { report?: boolean }) => Promise<unknown>;
  research?: (id: number) => Promise<boolean>;
};

/** Local dashboard at http://127.0.0.1:4321. Same actions as the Telegram buttons. Look: DESIGN.md. */

const ACTIVE = ["found", "decide", "ready", "applied", "interviewing", "offer"] as const;
const CLOSED = ["rejected", "dropped", "skipped"] as const;

// ---------- Today ----------

/** Action kinds grouped by what the person has to do, in the order they should do it. */
const GROUPS: { key: string; tab: string; one: string; many: string; kinds: string[]; done: string; doneMsg: string }[] = [
  { key: "interview", tab: "Interviews", one: "interview to prepare for", many: "interviews to prepare for", kinds: ["interview"], done: "Mark as done", doneMsg: "Marked as done." },
  { key: "reply", tab: "Replies", one: "conversation is waiting for your reply", many: "conversations are waiting for your reply", kinds: ["reply"], done: "Mark as replied", doneMsg: "Marked as replied. The follow-up timer starts now." },
  { key: "apply", tab: "Applications", one: "application to complete", many: "applications to complete", kinds: ["apply", "deadline"], done: "Mark as done", doneMsg: "Marked as done." },
  { key: "send", tab: "Notes", one: "message is yet to be sent", many: "messages are yet to be sent", kinds: ["send_note", "send_dm"], done: "Mark as sent", doneMsg: "Marked as sent." },
  { key: "follow", tab: "Follow-ups", one: "follow-up is due", many: "follow-ups are due", kinds: ["follow_up"], done: "Mark as done", doneMsg: "Marked as done." },
  { key: "decide", tab: "Decisions", one: "role needs your decision", many: "roles need your decision", kinds: ["decide"], done: "Mark as done", doneMsg: "Marked as done." },
  { key: "other", tab: "Other", one: "other task", many: "other tasks", kinds: [], done: "Mark as done", doneMsg: "Marked as done." },
];
const groupOf = (kind: string) => GROUPS.find((g) => g.kinds.includes(kind)) ?? GROUPS[GROUPS.length - 1];
const SHOW_FIRST = 5;
const STAGE_DOT: Record<string, string> = { ready: "info", interviewing: "ok", offer: "ok", decide: "warn" };
const STAGE_LABEL: Record<string, string> = { found: "Found", decide: "Decide", ready: "Ready to apply", applied: "Applied", interviewing: "Interview", offer: "Offer" };

const DANGER_ICON = `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.5v4.2" stroke="var(--surface)" stroke-width="1.6"/><circle cx="8" cy="11.2" r=".9" fill="var(--surface)"/></svg>`;
const WARN_ICON = `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15.2 14.5H.8z" fill="var(--warn-dot)"/><path d="M8 6v4" stroke="#0a0a0a" stroke-width="1.4"/><circle cx="8" cy="12" r=".8" fill="#0a0a0a"/></svg>`;

type HomeCtx = { stages: Map<number, { status: string; role: string }>; ic: Split | undefined; lead: Split | undefined; notes: { sent: number; replied: number }; direct: Map<number, Direct> };

/** The button that does the task: opens the application, the thread or LinkedIn, copying a draft first when there is one. */
function directButton(a: ActionRow, d: Direct | undefined, cls: string) {
  if (!d) return "";
  return `<a class="${cls}" href="${esc(d.href)}"${d.external ? ` target="_blank" rel="noopener"` : ""} data-open="/a/${a.id}/opened"${d.countsOnOpen ? " data-counts" : ""}${d.copy ? ` data-copy-text="${esc(d.copy)}"` : ""}>${esc(d.label)}${d.external ? icon("external") : ""}</a>`;
}

/** The fallback for when a task happened somewhere the sync cannot see. */
function doneMenu(a: ActionRow, size = "sm") {
  return `<details class="pop"><summary class="btn quiet ${size} icon-only" aria-label="More options">${icon("more")}</summary><div class="menu">
<form method="post" action="/a/${a.id}/done" data-inline data-act="done"><button class="menu-item"><span>I already did this</span>${icon("check")}</button></form>
<form method="post" action="/a/${a.id}/drop" data-inline data-act="drop" data-confirm="Remove this task? ${a.opportunity_id ? "The role stays open." : ""}"><button class="menu-item tone-danger"><span>Remove this task</span>${icon("trash")}</button></form>
</div></details>`;
}

function hintFor(a: ActionRow, c: HomeCtx): string {
  const opp = a.opportunity_id ? c.stages.get(a.opportunity_id) : undefined;
  if ((a.kind === "send_note" || a.kind === "send_dm") && c.notes.sent >= 3) return `${c.notes.replied} of the ${c.notes.sent} notes you sent got a reply.`;
  if (opp && ["apply", "deadline", "decide"].includes(a.kind)) {
    const lead = isLead(opp.role);
    const s = lead ? c.lead : c.ic;
    if (s && s.b >= 3) return `${lead ? "Lead role" : "Individual role"}. ${s.a} of your ${s.b} such applications got an interview.`;
  }
  return "";
}

function taskRow(a: ActionRow, c: HomeCtx) {
  const g = groupOf(a.kind);
  const due = dueLabel(a.due_at);
  const opp = a.opportunity_id ? c.stages.get(a.opportunity_id) : undefined;
  const hint = hintFor(a, c);
  const detailId = `d-${a.id}`;
  const dueIcon = due.tone === "danger" ? DANGER_ICON : due.tone === "warn" ? WARN_ICON : icon("clock");
  const title = a.opportunity_id ? `<a class="row-title" href="/o/${a.opportunity_id}">${esc(a.title)}</a>` : `<span class="row-title">${esc(a.title)}</span>`;
  const later = (hours: number, label: string, meta: string) =>
    `<form method="post" action="/a/${a.id}/snooze" data-inline><input type="hidden" name="hours" value="${hours}"><button class="menu-item"><span>${label}</span><span class="menu-meta">${meta}</span></button></form>`;
  const when = (d: number) => new Date(Date.now() + d * 86_400_000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const toMonday = ((8 - new Date().getDay()) % 7 || 7) * 24;
  return `<li class="row" data-row data-aid="${a.id}" data-kind="${g.key}"${due.tone === "danger" ? " data-pending" : ""}>
<div class="row-grid">
<button type="button" class="btn quiet sm icon-only row-toggle" aria-expanded="false" aria-controls="${detailId}" aria-label="Show details">${icon("chevron")}</button>
<input class="row-chk" type="checkbox" aria-label="Select: ${esc(a.title)}">
<div class="row-main">${title}
<span class="row-meta"><span class="due ${due.tone === "danger" ? "danger" : ""}">${dueIcon}${esc(due.text)}</span>${a.urgent ? badge("Urgent", "danger") : ""}${opp && STAGE_LABEL[opp.status] ? `<span class="stage"><span class="dot ${STAGE_DOT[opp.status] ?? ""}"></span>${STAGE_LABEL[opp.status]}</span>` : ""}</span>
${hint ? `<span class="row-hint">${icon("chart")}${esc(hint)}</span>` : ""}
</div>
<div class="row-actions">
${directButton(a, c.direct.get(a.id), "btn sm")}
<span class="splitbtn">
<form method="post" action="/a/${a.id}/snooze" data-inline data-act="snooze"><input type="hidden" name="hours" value="24"><button class="btn sm">Later</button></form>
<details class="pop"><summary class="btn sm" aria-label="Choose when to remind">${icon("chevron-down")}</summary>
<div class="menu"><p class="menu-label">Remind me</p>${later(24, "Tomorrow", when(1))}${later(72, "After 3 days", when(3))}${later(toMonday, "Next Monday", when(toMonday / 24))}</div></details>
</span>
${doneMenu(a)}
</div>
</div>
<div class="row-detail" id="${detailId}">${a.detail ? `<p>${esc(a.detail.trim())}</p>` : ""}${a.opportunity_id ? `<div class="row-links"><a href="/o/${a.opportunity_id}">Open the role</a></div>` : ""}</div>
</li>`;
}

/** A compact action row for the role page's "Up next" list. */
function actionItem(a: ActionRow) {
  const g = groupOf(a.kind);
  const due = dueLabel(a.snoozed_until && a.snoozed_until > a.due_at ? a.snoozed_until : a.due_at);
  return `<li class="item" data-row><div class="item-main"><span class="item-title">${esc(a.title)}</span>
${a.detail ? `<p class="item-detail clamp">${esc(a.detail.trim())}</p>` : ""}
<div class="item-meta"><span class="due ${due.tone === "danger" ? "danger" : ""}">${icon("clock")}${esc(due.text)}</span></div></div>
<div class="item-actions">${postButton(`/a/${a.id}/done`, g.done, { inline: true })}${postButton(`/a/${a.id}/snooze`, "Later", { inline: true, variant: "quiet" })}</div></li>`;
}

const DECK_ICON: Record<string, string> = { interview: "users", reply: "chat", apply: "briefcase", send: "send", follow: "clock", decide: "check", other: "check" };
const DECK_DEPTH = 12;

/** One card stack per type of work: the most urgent task on top; clearing it brings up the next. */
function deck(g: (typeof GROUPS)[number], items: ActionRow[], c: HomeCtx) {
  const cards = items.slice(0, DECK_DEPTH).map((a) => {
    const due = dueLabel(a.due_at);
    const opp = a.opportunity_id ? c.stages.get(a.opportunity_id) : undefined;
    const hint = hintFor(a, c);
    const dueIcon = due.tone === "danger" ? DANGER_ICON : due.tone === "warn" ? WARN_ICON : icon("clock");
    const detail = a.detail?.trim().split("\n")[0] ?? "";
    return `<li class="deck-card" data-aid="${a.id}">
<div class="deck-meta"><span class="due ${due.tone === "danger" ? "danger" : ""}">${dueIcon}${esc(due.text)}</span>${opp && STAGE_LABEL[opp.status] ? `<span class="stage"><span class="dot ${STAGE_DOT[opp.status] ?? ""}"></span>${STAGE_LABEL[opp.status]}</span>` : ""}</div>
${a.opportunity_id ? `<a class="deck-title" href="/o/${a.opportunity_id}">${esc(a.title)}</a>` : `<p class="deck-title">${esc(a.title)}</p>`}
${detail ? `<p class="deck-detail">${esc(detail)}</p>` : ""}
${hint ? `<span class="row-hint">${icon("chart")}${esc(hint)}</span>` : ""}
<div class="deck-actions">
${directButton(a, c.direct.get(a.id), "btn primary sm")}
<form method="post" action="/a/${a.id}/snooze" data-inline data-act="snooze"><input type="hidden" name="hours" value="24"><button class="btn sm">Later</button></form>
<button type="button" class="btn quiet sm deck-skip" data-skip>Skip${icon("chevron")}</button>
</div></li>`;
  }).join("");
  const more = Math.max(0, items.length - DECK_DEPTH);
  return `<section class="deck" data-deck="${g.key}" aria-label="${esc(g.tab)}">
<header class="deck-head"><span class="deck-kind">${icon(DECK_ICON[g.key] ?? "check")}${esc(g.tab)}</span><span class="deck-left"><span class="num" data-deck-left>${items.length}</span> left</span></header>
<ol class="deck-stack">${cards}</ol>
<p class="deck-empty"${items.length ? " hidden" : ""}>${more ? `The rest are in the list below.` : `All clear here.`}</p>
</section>`;
}

function taskGroup(g: (typeof GROUPS)[number], items: ActionRow[], c: HomeCtx) {
  const first = items.slice(0, SHOW_FIRST).map((a) => taskRow(a, c)).join("");
  const rest = items.slice(SHOW_FIRST);
  return `<section data-group="${g.key}"><h2 class="group-head" data-one="${esc(g.one)}" data-many="${esc(g.many)}">${items.length} ${esc(items.length === 1 ? g.one : g.many)}</h2>
<ul class="list">${first}</ul>${rest.length ? `<details class="overflow"><summary>Show ${rest.length} more</summary><ul class="list">${rest.map((a) => taskRow(a, c)).join("")}</ul></details>` : ""}</section>`;
}

const TILE_FILTERS: Record<string, (a: ActionRow) => boolean> = {
  pending: (a) => dueLabel(a.due_at).tone === "danger",
  applications: (a) => a.kind === "apply" || a.kind === "deadline",
  interviews: (a) => a.kind === "interview",
};

/** A role still in play with no reminder: bring one back or close the role. */
function stalledRow(r: { id: number; role: string; company: string }) {
  return `<li class="row" data-row><div class="row-grid"><span></span><span></span><div class="row-main"><a class="row-title" href="/o/${r.id}">${esc(r.role)}</a>
<span class="row-meta"><span>${esc(r.company.replace(/\s*\(.*\)\s*$/, ""))}</span><span>You removed its reminders. Bring one back, or close the role.</span></span></div>
<div class="row-actions"><form method="post" action="/o/${r.id}/remind"><button class="btn sm">Remind me</button></form><form method="post" action="/o/${r.id}/drop" data-confirm="${esc(`Close ${r.role} at ${r.company}?`)}"><button class="btn quiet sm">Close role</button></form></div></div></li>`;
}

// ---------- Home: what to do now, in order ----------

type Ranked = { a: ActionRow; score: number; why: string };
const KIND_WEIGHT: Record<string, number> = { interview: 100, reply: 80, apply: 60, deadline: 60, send_note: 50, send_dm: 50, follow_up: 45, decide: 40 };

/**
 * One order for everything due. Interviews first, then people waiting on you, then roles that
 * close soon or are likely to lead to an interview, then the rest by how long they have waited.
 * Every task carries the reason it sits where it does.
 */
function rankTasks(due: ActionRow[], opps: Map<number, { status: string; role: string; closes_on: string | null }>, ic: Split | undefined): Ranked[] {
  return due.map((a) => {
    const opp = a.opportunity_id ? opps.get(a.opportunity_id) : undefined;
    const pendingDays = Math.max(0, -daysFrom(a.due_at));
    const closesIn = opp?.closes_on ? daysFrom(opp.closes_on) : null;
    const icRole = opp && (a.kind === "apply" || a.kind === "deadline") && !isLead(opp.role);
    // Waiting adds weight for two weeks; past a month a task is likely stale, so it drops back.
    let score = (KIND_WEIGHT[a.kind] ?? 30) + Math.min(pendingDays, 14) - (pendingDays > 30 ? 20 : 0) + (a.urgent ? 25 : 0);
    if (closesIn !== null && closesIn >= 0) score += closesIn <= 3 ? 40 : closesIn <= 10 ? 20 : 0;
    if (icRole) score += 10;
    const why =
      a.kind === "interview" ? "An interview is coming up. Get ready first."
      : a.kind === "reply" ? (pendingDays >= 2 ? `Someone has been waiting ${plural(pendingDays, "day")} for your reply.` : "Someone is waiting for your reply.")
      : closesIn !== null && closesIn >= 0 && closesIn <= 10 ? (closesIn === 0 ? "The role closes today." : `The role closes in ${plural(closesIn, "day")}.`)
      : icRole && ic && ic.b >= 3 ? `Individual roles work best for you: ${ic.a} of ${ic.b} got an interview.`
      : a.urgent ? "Marked urgent."
      : pendingDays > 30 ? "Pending for over a month. Do it or remove it."
      : pendingDays >= 7 ? `Pending for ${pendingDays} days.`
      : dueLabel(a.due_at).tone === "warn" ? "Due today." : "Due now.";
    return { a, score, why };
  }).sort((x, y) => y.score - x.score || x.a.due_at.localeCompare(y.a.due_at));
}

const FOCUS_DEPTH = 12;

function waitingRow(a: ActionRow, at: string) {
  return `<li class="later-item waiting-item" data-aid="${a.id}"><span class="wait-main"><span class="mini-title">${esc(a.title)}</span><span class="mini-sub">Opened ${new Date(at).toLocaleString("en-GB", { weekday: "short", hour: "numeric", minute: "2-digit" })}</span></span>
<form method="post" action="/a/${a.id}/unopen" data-inline data-quiet><button class="btn quiet sm">Not done yet</button></form>${doneMenu(a)}</li>`;
}

function focusItem(r: Ranked, c: HomeCtx) {
  const { a } = r;
  const g = groupOf(a.kind);
  const due = dueLabel(a.due_at);
  const opp = a.opportunity_id ? c.stages.get(a.opportunity_id) : undefined;
  const detail = a.detail?.trim().split("\n")[0] ?? "";
  const title = a.opportunity_id ? `<a class="focus-title" href="/o/${a.opportunity_id}">${esc(a.title)}</a>` : `<span class="focus-title">${esc(a.title)}</span>`;
  return `<li class="focus-item" data-row data-aid="${a.id}">
<div class="focus-main">
<p class="focus-why">${esc(r.why)}</p>
${title}
<span class="row-meta"><span class="chip">${esc(g.tab)}</span><span class="due ${due.tone === "danger" ? "danger" : ""}">${due.tone === "danger" ? DANGER_ICON : due.tone === "warn" ? WARN_ICON : icon("clock")}${esc(due.text)}</span>${opp && STAGE_LABEL[opp.status] ? `<span class="stage"><span class="dot ${STAGE_DOT[opp.status] ?? ""}"></span>${STAGE_LABEL[opp.status]}</span>` : ""}</span>
${detail ? `<p class="focus-detail">${esc(detail)}</p>` : ""}
</div>
<div class="focus-actions">
${directButton(a, c.direct.get(a.id), "btn primary")}
<form method="post" action="/a/${a.id}/snooze" data-inline data-act="snooze"><input type="hidden" name="hours" value="24"><button class="btn">Later</button></form>
${doneMenu(a)}
</div>${c.direct.get(a.id)?.note ? `<p class="focus-note">${esc(c.direct.get(a.id)!.note!)}</p>` : ""}</li>`;
}

function home(q: URLSearchParams) {
  reconcileActions();
  const due = dueActions();
  const ids = [...new Set(due.map((a) => a.opportunity_id).filter((x): x is number => !!x))];
  const opps = new Map(ids.length ? all<{ id: number; status: string; role: string; closes_on: string | null }>(
    `SELECT id, status, role, closes_on FROM opportunities WHERE id IN (${ids.join(",")})`).map((r) => [r.id, r]) : []);
  const st = interviewStats();
  const o = outreachStats();
  const ic = st.level.find((x) => x.label === "Individual roles");
  const ctx: HomeCtx = { stages: opps, ic, lead: st.level.find((x) => x.label !== "Individual roles"), notes: { sent: o.sent, replied: o.replied }, direct: directActions(due) };
  const opened = openedTasks();
  const fresh = (id: number) => { const at = opened.get(id); return !!at && Date.now() - new Date(at).getTime() < 48 * 3_600_000; };
  const ranked = rankTasks(due, opps, ic).map((r) => {
    const at = opened.get(r.a.id);
    return at && !fresh(r.a.id) ? { ...r, why: `You opened this on ${day(at)}. It clears on its own once it is seen to be done.` } : r;
  });
  // An interview in the next 14 days sits above everything (emphasised from 3 days out), so its prep task leaves the queue.
  const nextInterview = upcomingInterviews().find((m) => new Date(m.start_at).getTime() - Date.now() < 14 * 86_400_000);
  const shownElsewhere = (a: ActionRow) => !!nextInterview && a.rule_key === `loop:prep:${nextInterview.event_id}`;
  const queue = ranked.filter((r) => !fresh(r.a.id) && !shownElsewhere(r.a)).slice(0, FOCUS_DEPTH);
  const waiting = ranked.filter((r) => fresh(r.a.id));
  const rest = Math.max(0, due.length - waiting.length - 5);

  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const name = (() => { try { return loadProfile().name.split(" ")[0]; } catch { return ""; } })();
  const lede = !due.length ? "Nothing is due right now. New tasks come here as soon as they are due."
    : `Do these in order. Clear the first one and the next moves up.${rest ? ` The other ${rest} can wait.` : ""}`;

  const closing = get<{ n: number }>("SELECT count(*) n FROM opportunities WHERE status IN ('found','decide','ready') AND closes_on BETWEEN date('now') AND date('now', '+14 days')")!.n;
  const late = waitingForReply().filter((w) => w.late && !w.reminded).length;
  const week = get<{ n: number }>("SELECT count(*) n FROM actions WHERE status = 'open' AND max(due_at, coalesce(snoozed_until, '')) > $now AND max(due_at, coalesce(snoozed_until, '')) <= $week",
    { now: nowIso(), week: new Date(Date.now() + 7 * 86_400_000).toISOString() })!.n;
  const later = [
    rest ? `<a class="later-item" href="/tasks"><span class="later-num num" data-later-rest>${rest}</span><span>more tasks, by type of work</span>${icon("chevron")}</a>` : "",
    closing ? `<a class="later-item" href="/tasks#closing"><span class="later-num num">${closing}</span><span>${closing === 1 ? "role closes" : "roles close"} in the next 2 weeks</span>${icon("chevron")}</a>` : "",
    late ? `<a class="later-item" href="/progress"><span class="later-num num">${late}</span><span>${late === 1 ? "application has" : "applications have"} had no reply for a long time</span>${icon("chevron")}</a>` : "",
    week ? `<a class="later-item" href="/tasks#coming-up"><span class="later-num num">${week}</span><span>${week === 1 ? "task comes" : "tasks come"} up this week</span>${icon("chevron")}</a>` : "",
  ].filter(Boolean).join("");

  return page("Home · Job hunt", `
<div class="focus">
<div><h1>${hello}${name ? `, ${esc(name)}` : ""}.</h1><p class="lede">${esc(nextInterview ? `Your interview comes first. ${lede}` : lede)}</p></div>
${setupCallout()}
${nextInterview ? interviewCard(nextInterview) : ""}
${queue.length ? `<section aria-labelledby="h-now"><h2 id="h-now" class="sr">Do these in order</h2>
<ol class="focus-list" data-due="${due.length - waiting.length}">${queue.map((r) => focusItem(r, ctx)).join("")}</ol>
<div class="focus-done" hidden><p class="card-title">That is the top of your list done.</p><p class="card-sub">Reload for the next most important tasks, or open the full list.</p><div class="btn-row"><a class="btn primary" href="/">Show the next ones</a><a class="btn" href="/tasks">Open all tasks</a></div></div>
</section>` : `<div class="panel">${emptyState("You are clear for now.", "New replies, follow-ups and deadlines come here when they are due.")}</div>`}
<section class="vstack section-stack" aria-labelledby="h-wait" data-waiting${waiting.length ? "" : " hidden"}><div class="section-title-row"><h2 id="h-wait" class="later-title">Waiting to confirm</h2><p class="card-sub">You opened these. Each clears on its own when the email or LinkedIn sync sees it happen.</p></div>
<ul class="later waiting-list">${waiting.map((r) => waitingRow(r.a, opened.get(r.a.id)!)).join("")}</ul></section>
${later ? `<section class="vstack section-stack" aria-labelledby="h-later"><h2 id="h-later" class="later-title">When you are done</h2><nav class="later" aria-label="Everything else">${later}</nav></section>` : ""}
</div>`, { tab: "home", flash: q.get("flash"), meta: new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) });
}

/** Every due task: filter tiles, one card stack per type of work, the full table and the time-sensitive cards. */
function tasksPage(q: URLSearchParams) {
  reconcileActions();
  const now = nowIso();
  const due = dueActions();
  const counts = stageCounts();
  const filter = TILE_FILTERS[q.get("filter") ?? ""] ? q.get("filter")! : "";
  const kind = GROUPS.some((g) => g.key === q.get("kind")) ? q.get("kind")! : "";
  const shown = due.filter((a) => (!filter || TILE_FILTERS[filter](a)) && (!kind || groupOf(a.kind).key === kind));

  const ids = [...new Set(due.map((a) => a.opportunity_id).filter((x): x is number => !!x))];
  const stages = new Map(ids.length ? all<{ id: number; status: string; role: string }>(`SELECT id, status, role FROM opportunities WHERE id IN (${ids.join(",")})`).map((r) => [r.id, r]) : []);
  const st = interviewStats();
  const o = outreachStats();
  const ctx: HomeCtx = { stages, ic: st.level.find((x) => x.label === "Individual roles"), lead: st.level.find((x) => x.label !== "Individual roles"), notes: { sent: o.sent, replied: o.replied }, direct: directActions(due) };

  const pending = due.filter(TILE_FILTERS.pending);
  const oldest = pending.reduce<ActionRow | null>((m, a) => (!m || a.due_at < m.due_at ? a : m), null);
  const appsDue = due.filter(TILE_FILTERS.applications);
  const interviews = due.filter(TILE_FILTERS.interviews);
  const nextInterview = all<ActionRow>("SELECT * FROM actions WHERE status = 'open' AND kind = 'interview' ORDER BY due_at LIMIT 1")[0];
  const href = (f: string, k = kind) => { const p = new URLSearchParams(); if (f) p.set("filter", f); if (k) p.set("kind", k); const s = p.toString(); return s ? `/tasks?${s}` : "/tasks"; };
  const tile = (f: string, label: string, value: number, help: string, danger = false) =>
    `<a class="tile" href="${href(filter === f ? "" : f)}"${filter === f ? ` aria-current="true"` : ""}><span class="tile-label">${label}</span><span class="tile-value${danger ? " danger" : ""}"${f === "" ? " data-total" : f === "pending" ? " data-pending-total" : ""}>${value}</span><span class="tile-help">${esc(help)}</span></a>`;
  const tiles = `<nav class="tiles" aria-label="Filter the list">
${tile("", "Things to do", due.length, `Across ${new Set(due.map((a) => groupOf(a.kind).key)).size} types of work`)}
${tile("pending", "Pending", pending.length, oldest ? `From earlier days. Oldest: ${day(oldest.due_at)}` : "Nothing from earlier days", pending.length > 0)}
${tile("applications", "Applications due", appsDue.length, `${counts.ready ?? 0} roles are ready to apply`)}
${tile("interviews", "Interviews", interviews.length, nextInterview ? `Next: ${day(nextInterview.due_at)}` : "None scheduled")}
</nav>`;

  const groups = GROUPS.map((g) => ({ g, items: shown.filter((a) => groupOf(a.kind).key === g.key) })).filter((x) => x.items.length);
  const tabCount = (k: string) => due.filter((a) => (!filter || TILE_FILTERS[filter](a)) && (!k || groupOf(a.kind).key === k)).length;
  const tabs = `<nav class="ktabs" aria-label="Type of work">${[{ key: "", tab: "All" }, ...GROUPS.filter((g) => due.some((a) => groupOf(a.kind).key === g.key))].map((g) =>
    `<a class="ktab" href="${href(filter, g.key)}"${kind === g.key ? ` aria-current="page"` : ""}>${g.tab}<span class="ktab-count" data-tab-count="${g.key || "all"}">${tabCount(g.key)}</span></a>`).join("")}</nav>`;

  const stalled = stalledRoles();
  const stalledHtml = !filter && !kind && stalled.length ? `<section data-group="stalled"><h2 class="group-head">${plural(stalled.length, "role has", "roles have")} no next step</h2>
<ul class="list">${stalled.slice(0, 3).map((r) => stalledRow(r)).join("")}</ul>${stalled.length > 3 ? `<details class="overflow"><summary>Show ${stalled.length - 3} more</summary><ul class="list">${stalled.slice(3).map((r) => stalledRow(r)).join("")}</ul></details>` : ""}</section>` : "";

  const table = `<div class="tasks">
<div class="tasks-head"><span></span><input class="row-chk" type="checkbox" aria-label="Select all" data-select-all><span>What to do</span><span></span></div>
${groups.length ? groups.map(({ g, items }) => taskGroup(g, items, ctx)).join("")
    : emptyState(filter || kind ? "Nothing here right now." : "You are clear for today.", filter || kind ? `<a href="/tasks">Show all tasks</a>` : "New replies, follow-ups and deadlines will come here when they are due.")}
${stalledHtml}</div>
<p class="tasks-foot">Shortcuts: <kbd class="kbd">J</kbd> <kbd class="kbd">K</kbd> move, <kbd class="kbd">X</kbd> select, <kbd class="kbd">E</kbd> done, <kbd class="kbd">H</kbd> later, <kbd class="kbd">⌘K</kbd> add a link</p>`;

  const closing = all<{ id: number; role: string; company: string; closes_on: string }>(
    "SELECT id, role, company, closes_on FROM opportunities WHERE status IN ('found','decide','ready') AND closes_on >= date('now') ORDER BY closes_on LIMIT 3",
  );
  const late = waitingForReply().filter((w) => w.late).sort((a, b) => b.days - a.days).slice(0, 3);
  const w = replyWindow();
  const upcoming = all<ActionRow>(
    `SELECT * FROM actions WHERE status='open' AND (due_at > $now OR snoozed_until > $now) AND max(due_at, coalesce(snoozed_until, '')) <= $week
     ORDER BY max(due_at, coalesce(snoozed_until, '')) LIMIT 4`, { now, week: new Date(Date.now() + 7 * 86_400_000).toISOString() },
  );
  const aside = `<aside class="home-aside" aria-label="Time-sensitive">
<section class="card" id="closing"><div class="card-head"><h2 class="card-title">Apply before these close</h2><p class="card-sub">Roles with a closing date that you have not applied to yet.</p></div>
${closing.length ? `<ul class="mini-list">${closing.map((r) => { const left = daysFrom(r.closes_on); return `<li class="mini-row"><span><a class="mini-title" href="/o/${r.id}">${esc(r.role)}</a><span class="mini-sub">${esc(r.company.replace(/\s*\(.*\)\s*$/, ""))} · closes ${day(r.closes_on)}</span></span><span class="chip${left <= 10 ? " warn" : ""}">${left === 0 ? "Closes today" : plural(left, "day") + " left"}</span></li>`; }).join("")}</ul>`
    : `<p class="card-sub">No open role has a closing date right now.</p>`}</section>
<section class="card"><div class="card-head"><h2 class="card-title">No reply for a long time</h2><p class="card-sub">Most companies reply in ${w.lo} to ${w.hi} days.</p></div>
${late.length ? `<ul class="mini-list">${late.map((r) => `<li class="mini-row"><span><a class="mini-title" href="/o/${r.id}">${esc(r.company)}</a><span class="mini-sub">Applied ${plural(r.days, "day")} ago</span></span>${r.reminded ? `<span class="chip">Reminder set</span>` : `<form method="post" action="/o/${r.id}/followup" data-inline><button class="btn sm">Follow up</button></form>`}</li>`).join("")}</ul>`
    : `<p class="card-sub">Every application is still inside the usual reply time.</p>`}
<a class="link-subtle" href="/progress">See all applications waiting for a reply</a></section>
<section class="card" id="coming-up"><h2 class="card-title">Coming up this week</h2>
${upcoming.length ? `<ol class="timeline">${upcoming.map((a, i) => { const at = a.snoozed_until && a.snoozed_until > a.due_at ? a.snoozed_until : a.due_at; return `<li class="tl-item"><span class="tl-dot${i >= 2 ? " later" : ""}"></span><span class="tl-date">${new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</span><span class="mini-title">${a.opportunity_id ? `<a href="/o/${a.opportunity_id}">${esc(a.title)}</a>` : esc(a.title)}</span>${a.detail ? `<span class="mini-sub">${esc(a.detail.split("\n")[0].slice(0, 90))}</span>` : ""}</li>`; }).join("")}</ol>`
    : `<p class="card-sub">Nothing is scheduled for the next 7 days.</p>`}</section>
</aside>`;

  const deckGroups = GROUPS.map((g) => ({ g, items: due.filter((x) => groupOf(x.kind).key === g.key) })).filter((x) => x.items.length);
  const decks = !filter && !kind && deckGroups.length ? `<section class="vstack section-stack home-decks" aria-labelledby="h-next">
<div class="section-title-row"><h2 id="h-next">Up next</h2><p class="card-sub">One card for each type of work. Clear the top card and the next one comes up.</p></div>
<div class="decks">${deckGroups.map(({ g, items }) => deck(g, items, ctx)).join("")}</div></section>` : "";

  const bar = `<div class="action-bar" role="toolbar" aria-label="Selected tasks" hidden>
<span class="action-bar-count"><span data-sel-count>0</span> selected<button type="button" class="btn quiet sm icon-only" data-batch="clear" aria-label="Clear selection">${icon("x")}</button></span>
<span class="action-bar-sep"></span>
<button type="button" class="btn quiet" data-batch="done">Mark as done<kbd class="kbd">E</kbd></button>
<button type="button" class="btn quiet" data-batch="snooze">Remind tomorrow<kbd class="kbd">H</kbd></button>
<button type="button" class="btn danger" data-batch="drop">Remove</button></div>`;

  return page("Tasks · Job hunt", `
<div class="vstack home-head"><div><h1>All tasks</h1><p class="lede">Everything that is due, by type of work. Home shows only the few that matter most.</p></div>${tiles}</div>
<div class="home-grid">
${decks}${aside}
<section class="vstack section-stack home-list" aria-labelledby="h-all"><div class="section-title-row"><h2 id="h-all">Full list</h2>${!filter && !kind ? `<p class="card-sub">The cards above show the top task of each type. Everything due is here.</p>` : ""}</div>${tabs}${table}</section>
</div>${bar}`,
    { tab: "tasks", flash: q.get("flash") });
}

// ---------- What is working ----------

function insightsPage(q: URLSearchParams) {
  const st = interviewStats();
  const story = splitStories(st);
  const bars = (rows: Split[]) => {
    const best = Math.max(...rows.map((r) => (r.b ? r.a / r.b : 0)));
    return `<ul class="bars">${rows.map((r) => `<li class="bar-row"><span>${esc(r.label)}</span><span class="bar-val"><strong>${r.a}</strong> of ${r.b}</span><span class="meter"><span class="meter-fill${r.b && r.a / r.b === best && best > 0 ? "" : " mid"}" style="width:${Math.max(2, Math.min(100, pct(r.a, r.b) * 2))}%"></span></span></li>`).join("")}</ul>`;
  };
  const cell = (head: string, say: string, rows: Split[]) =>
    `<article class="cell"><div class="card-head"><h3 class="card-title">${esc(head)}</h3><p class="card-sub">${esc(say)}</p></div>${rows.length ? bars(rows) : `<p class="card-sub">No applications yet.</p>`}</article>`;
  const r = readyIcRoles();
  const o = outreachStats();
  const g = alertFunnel();
  const totalOut = o.sent + o.drafted || 1;
  const funnel = [["Alerts received", g.total], ["Passed first check", g.passed], ["You applied", g.applied], ["Got an interview", g.interviews]] as const;

  return page("What is working · Job hunt", `
<div class="vstack page-stack">
<div><h1>What your job search is telling you</h1><p class="lede">These come from your own data. The numbers are still small, so treat them as hints, not rules.</p></div>
<section class="vstack section-stack" aria-labelledby="h-int">
<div><h2 id="h-int">Which applications get you interviews</h2><p class="section-desc">${st.interviews} of your ${st.total} applications reached an interview or an offer. Each bar shows how many got one.</p></div>
<div class="hairline cols-3">${cell(story.levelHead, story.levelSay, st.level)}${cell(story.familyHead, story.familySay, st.family)}${cell(story.sourceHead, story.sourceSay, st.source.slice(0, 4))}</div>
${r.ic.length ? `<div class="callout"><p><strong>What to do:</strong> ${r.ic.length} of your ${r.ready} ready roles are individual roles${r.companies.length ? `, at ${esc(r.companies.slice(0, 4).join(", "))}` : ""}. Apply to these first.</p><a class="btn primary" href="/list?status=ready">Show ready roles</a></div>` : ""}
</section>
<div class="two-up">
<article class="card"><div class="card-head"><h2 class="card-title lg">${o.sent && o.replied ? "Your notes get replies." : "Your notes are waiting to go out."}${o.drafted > o.sent ? " Most are not sent yet." : ""}</h2>
<p class="card-desc">You sent ${plural(o.sent, "note")} and ${plural(o.replied, "person", "people")} replied${o.fast ? `, ${o.fast} within a day` : ""}.${o.accepted || o.notAccepted ? ` ${o.accepted} accepted your connection${o.notAccepted ? `; ${o.notAccepted} have not accepted yet` : ""}.` : ""} ${plural(o.drafted, "note is", "notes are")} still drafts${o.draftsReady ? `, and ${o.draftsReady} of them are for roles you are ready to apply to` : ""}.</p></div>
<div><div class="stacked" role="img" aria-label="${o.replied} replied, ${o.waiting} waiting, ${o.drafted} not sent"><span class="seg-strong" style="width:${(o.replied / totalOut) * 100}%"></span><span class="seg-mid" style="width:${(o.waiting / totalOut) * 100}%"></span></div>
<div class="legend"><span><span class="swatch"></span>${o.replied} replied</span><span><span class="swatch mid"></span>${o.waiting} waiting</span><span><span class="swatch soft"></span>${o.drafted} not sent</span></div></div>
<div class="card-actions"><a class="btn primary" href="/?kind=send">Send the notes</a>${o.draftsClosed ? postButton("/insights/clear-drafts", `Remove ${plural(o.draftsClosed, "old draft")}`, { inline: true, confirm: `Mark ${plural(o.draftsClosed, "draft")} for closed roles as skipped?` }) : ""}</div>
<p class="card-note">${o.draftsClosed ? `${plural(o.draftsClosed, "draft is", "drafts are")} for rejected or removed roles. ` : ""}Based on ${plural(o.sent, "sent note")}.</p></article>
<article class="card"><div class="card-head"><h2 class="card-title lg">${g.total && g.passed / g.total < 0.5 ? "Most job alerts are not a match" : "How your job alerts turn into interviews"}</h2>
<p class="card-desc">${g.total ? `${pct(g.passed, g.total)}% of Gmail alerts pass the first check.` : "No Gmail alerts yet."}${g.interviews ? ` ${plural(g.interviews, "interview")} came from them.` : ""}</p></div>
<ul class="funnel">${funnel.map(([label, n], i) => `<li class="funnel-row"><span class="funnel-label">${label}</span><span><span class="funnel-bar${i === 0 ? " first" : i === 3 ? " last" : ""}" style="width:${g.total ? Math.max(3, Math.round((n / g.total) * 100)) : 3}%"></span></span><span class="funnel-val">${n}</span></li>`).join("")}</ul>
<div class="card-actions"><a class="btn" href="/sources">Review watched pages and alerts</a></div>
${g.lowMatch ? `<p class="card-note">${plural(g.lowMatch, "alert was", "alerts were")} marked a low match at the first check.</p>` : ""}</article>
</div></div>`, { tab: "insights", flash: q.get("flash"), meta: "Updated with every sync" });
}

// ---------- Progress ----------

function progressPage(q: URLSearchParams) {
  const c = stageCounts();
  const open = ACTIVE.reduce((s, k) => s + (c[k] ?? 0), 0);
  const notes: Record<string, string> = { found: "Not checked by you yet", decide: "Partial match", ready: "Pack is ready", applied: "Waiting for a reply", interviewing: "In interviews", offer: "Decide on these" };
  const max = Math.max(1, ...ACTIVE.map((k) => c[k] ?? 0));
  const p = weeklyPace();
  const peak = Math.max(1, ...p.weeks.map((w) => w.n));
  const w = replyWindow();
  const allWaits = waitingForReply().sort((a, b) => b.days - a.days);
  const waits = allWaits.slice(0, 5);
  const span = Math.max(30, ...waits.map((x) => x.days + 4));
  const lates = waits.filter((x) => x.late);
  return page("Progress · Job hunt", `
<div class="vstack page-stack-sm">
<div><h1>Where your job search stands</h1><p class="lede">${plural(open, "role is", "roles are")} still open. You are in interviews for ${c.interviewing ?? 0} and have ${plural(c.offer ?? 0, "offer")}.${p.thisWeek > p.beforeSum && p.thisWeek ? " This week you applied to more roles than in the six weeks before it together." : ""}</p></div>
<section class="card" aria-labelledby="h-st"><div class="card-head"><h2 id="h-st">Open roles at each stage</h2><p class="card-sub">Select a stage to see its roles.</p></div>
<div class="hairline cols-6">${ACTIVE.map((k) => `<a class="stage-cell" href="/list?status=${k}"><span class="stage-label">${esc(STATUS[k].label)}</span><span class="stage-value">${c[k] ?? 0}</span><span class="meter thin"><span class="meter-fill${k === "interviewing" || k === "offer" ? " ok" : ""}" style="width:${Math.max(3, Math.round(((c[k] ?? 0) / max) * 100))}%"></span></span><span class="stage-note">${notes[k]}</span></a>`).join("")}</div>
<p class="card-sub">Closed so far: ${c.rejected ?? 0} rejected, ${c.dropped ?? 0} removed by you and ${c.skipped ?? 0} skipped at the first check.</p></section>
<div class="two-up">
<section class="card" aria-labelledby="h-wk"><div class="card-head"><h2 id="h-wk">Applications every week</h2>
<p class="card-desc">${p.thisWeek ? `${p.thisWeek} this week${p.today ? `, ${p.today} of them today` : ""}.` : "No applications yet this week."}${p.range ? ` Most replies come ${w.lo} to ${w.hi} days later, so expect them between ${p.range}.` : ""}</p></div>
<div class="columns" role="img" aria-label="Applications per week: ${p.weeks.map((x) => `${x.label} ${x.n}`).join(", ")}. Replies are likely in the next two weeks.">
${p.weeks.map((x) => `<span class="col${x.current ? " current" : ""}"><span class="col-val">${x.n}</span><span class="col-bar" style="height:${Math.max(2, Math.round((x.n / peak) * 130))}px"></span><span class="col-label">${x.label}</span></span>`).join("")}
${p.forecast.map((x) => `<span class="col forecast"><span class="col-val"></span><span class="col-bar" style="height:40px"></span><span class="col-label">${x.label}</span></span>`).join("")}</div>
<div class="legend"><span><span class="swatch"></span>Applied</span><span><span class="swatch dashed"></span>Replies likely</span></div></section>
<section class="card" aria-labelledby="h-wait"><div class="card-head"><h2 id="h-wait">Applications waiting for a reply</h2>
<p class="card-desc">Most replies come ${w.lo} to ${w.hi} days after you apply${w.known ? "" : " (a starting guess until you have more replies)"}.${lates.length ? ` ${lates.map((x) => x.company).slice(0, 2).join(" and ")}${lates.length > 2 ? ` and ${lates.length - 2} more` : ""} ${lates.length === 1 ? "is" : "are"} well past that. Send one follow-up. If there is no reply in a week, close the role.` : ""}</p></div>
${waits.length ? `<div class="timing">${waits.map((x) => `<div class="timing-row"><span><a class="mini-title" href="/o/${x.id}">${esc(x.company)}</a><span class="mini-sub">${plural(x.days, "day")} ago</span></span>
<span class="track" role="img" aria-label="${esc(x.company)}: applied ${x.days} days ago"><span class="track-band" style="left:${(w.lo / span) * 100}%;width:${((w.hi - w.lo) / span) * 100}%"></span><span class="track-dot${x.late ? " late" : ""}" style="left:${Math.min(98, (x.days / span) * 100)}%"></span></span>
<span class="timing-end">${x.late ? (x.reminded ? `<span class="chip">Reminder set</span>` : `<form method="post" action="/o/${x.id}/followup" data-inline><button class="btn sm">Follow up</button></form>`) : "Still normal"}</span></div>`).join("")}
<div class="timing-axis"><span></span><span><span>Day 0</span><span class="legend flush"><span><span class="swatch band"></span>Usual reply time</span></span><span>Day ${span}</span></span><span></span></div></div>
${allWaits.length > waits.length ? `<a class="link-subtle" href="/list?status=applied">See all ${allWaits.length} applications waiting for a reply</a>` : ""}`
    : `<p class="card-sub">No application is waiting for a reply.</p>`}</section>
</div></div>`, { tab: "progress", flash: q.get("flash"), meta: "Since your first application" });
}

// ---------- Roles ----------

const FILTERS: { key: string; label: string; where: string }[] = [
  { key: "active", label: "Active", where: `status IN (${ACTIVE.map((s) => `'${s}'`).join(",")})` },
  ...ACTIVE.map((s) => ({ key: s, label: STATUS[s].label, where: `status = '${s}'` })),
  { key: "saved", label: "Saved on LinkedIn", where: "saved_on_linkedin = 1" },
  { key: "closed", label: "Closed", where: `status IN (${CLOSED.map((s) => `'${s}'`).join(",")})` },
  ...CLOSED.map((s) => ({ key: s, label: STATUS[s].label, where: `status = '${s}'` })),
  { key: "all", label: "All", where: "1" },
];
const TABS = ["active", ...ACTIVE, "saved", "closed", "all"];

function list(q: URLSearchParams) {
  const source = q.get("source");
  const key = q.get("saved") ? "saved" : q.get("status") ?? "active";
  const filter = FILTERS.find((f) => f.key === key) ?? FILTERS[0];
  const rows = source
    ? all<Opportunity>("SELECT * FROM opportunities WHERE source = $s ORDER BY updated_at DESC", { s: source })
    : all<Opportunity>(`SELECT * FROM opportunities WHERE ${filter.where} ORDER BY updated_at DESC`);
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, get<{ n: number }>(`SELECT count(*) n FROM opportunities WHERE ${f.where}`)!.n]));
  const heading = source ? `From ${sourceLabel(source)}` : "Roles";

  const tabs = source ? `<a class="back" href="/list">${icon("back")}All roles</a>`
    : `<nav class="seg" aria-label="Filter by stage">${TABS.map((k) => {
      const f = FILTERS.find((x) => x.key === k)!;
      return `<a href="/list?status=${k}"${k === filter.key ? ` aria-current="page"` : ""}>${esc(f.label)} <span class="c">${counts[k]}</span></a>`;
    }).join("")}</nav>`;

  const body = rows.map((o) => {
    const closes = closesLabel(o.closes_on);
    const packing = o.pack_status === "queued" || o.pack_status === "building";
    return `<tr data-row data-text="${esc(`${o.role} ${o.company} ${sourceLabel(o.source)}`.toLowerCase())}">
<td class="c-role"><a class="cell-title" href="/o/${o.id}">${esc(o.role)}</a><span class="cell-sub">${esc(o.company)}</span></td>
<td data-label="Status"><div class="btn-row" style="gap:6px">${statusBadge(o.status)}${packing ? badge("Pack building", "accent") : ""}</div></td>
<td data-label="Fit">${fitBadge(o.fit_verdict)}</td>
<td data-label="Closes" class="c-meta ${closes?.tone ? `tone-${closes.tone}` : ""}">${closes ? esc(closes.text) : ""}</td>
<td data-label="Source" class="c-meta muted">${esc(sourceLabel(o.source))}</td>
<td data-label="Updated" class="c-meta muted num">${day(o.updated_at)}</td></tr>`;
  }).join("");

  return page(`${heading} · Job hunt`, `
<div class="page-head"><div><h1>${esc(heading)}</h1><p aria-live="polite"><span class="num" data-filter-count>${rows.length}</span> ${source ? "roles" : `${esc(filter.label.toLowerCase())} role${rows.length === 1 ? "" : "s"}`}</p></div></div>
<div class="filters">${tabs}
<div class="search">${icon("search")}<label class="sr" for="role-q">Search roles</label><input id="role-q" type="search" placeholder="Search role or company  /" data-filter="tbody tr[data-row]" autocomplete="off" value="${esc(q.get("q") ?? "")}"></div></div>
<div class="panel">${rows.length ? `<table class="stack-table"><thead><tr><th>Role</th><th>Status</th><th>Fit</th><th>Closes</th><th>Source</th><th>Updated</th></tr></thead><tbody>${body}</tbody></table>
<div data-filter-empty hidden>${emptyState("No roles match that search", "Try a company name or part of the title.")}</div>`
    : emptyState(`No ${filter.label.toLowerCase()} roles`, `Paste a job link in the bar above, or <a href="/list?status=all">see every role</a>.`)}</div>`,
    { tab: "roles" });
}

// ---------- Role ----------

const PART_LABEL: Record<string, string> = {
  hiring_manager: "Hiring manager", recruiter: "Recruiter", team_lead: "Leads the team", team_member: "On the team",
  job_poster: "Posted the role", founder: "Founder", referrer: "Could refer you",
};
const CONF: Record<string, [string, string]> = { high: ["Confirmed", "ok"], medium: ["Likely", "accent"], low: ["Worth checking", "muted"] };

/** Who's hiring: people with how sure and why, the team, signals, people I know, related openings. */
function hiringSection(o: Opportunity, pending: boolean): string {
  const b: HiringBrief | null = getBrief(o);
  const button = postButton(`/o/${o.id}/research`, b ? `${icon("refresh")}Research again` : "Research who's hiring", { variant: b ? "quiet" : "default" });
  const head = `<div class="section-head"><h2>Who's hiring</h2>${b ? `<span class="tail small muted">Researched ${day(b.researched_at)}${b.sources.length ? ` from ${esc(b.sources.join(", "))}` : ""}</span>` : ""}</div>`;
  if (pending) return `<section class="block">${head}<div class="callout accent" role="status">Researching who's hiring. This takes a few minutes; reload the page to see it.</div></section>`;
  if (!b) return `<section class="block">${head}<div class="panel">${emptyState("Not researched yet", `It runs on its own for roles you're about to apply to or have applied to. ${button}`)}</div></section>`;
  const link = (url: string | null, label: string) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a>` : "");
  const people = b.people.map((p) => `<li class="person"><div class="person-head"><span class="who">${esc(p.name)}</span>${badge(PART_LABEL[p.part] ?? p.part, "neutral")}${badge(CONF[p.confidence][0], CONF[p.confidence][1])}</div>
${p.title ? `<p class="small muted">${esc(p.title)}</p>` : ""}<p class="small" style="margin-top:6px">${esc(p.evidence)}</p>
<p class="small" style="margin-top:4px;display:flex;gap:12px;flex-wrap:wrap">${link(p.linkedin_url, "LinkedIn profile")}${link(p.source_url, "Source")}</p></li>`).join("");
  const list = (title: string, items: string[]) => (items.length ? `<div style="padding:12px 16px;border-top:1px solid var(--line)"><h3 class="small" style="font-weight:600;margin-bottom:6px">${title}</h3><ul class="small" style="margin:0;padding-left:18px;line-height:22px">${items.join("")}</ul></div>` : "");
  return `<section class="block">${head}<div class="panel">
${people ? `<ul class="list">${people}</ul>` : emptyState("No one named yet", "The sources didn't name anyone with enough evidence.")}
${b.team ? `<div style="padding:12px 16px;border-top:1px solid var(--line)"><h3 class="small" style="font-weight:600;margin-bottom:4px">Team</h3><p class="small">${esc(b.team)}</p></div>` : ""}
${list("You already know", b.known.map((k) => `<li>${esc(k.name)} (${esc(k.how)})</li>`))}
${list("Signals", b.signals.map((x) => `<li>${esc(x.what)}${x.date ? ` <span class="muted">· ${esc(x.date)}</span>` : ""}${x.source_url ? ` ${link(x.source_url, "link")}` : ""}</li>`))}
${list("Related openings there", b.related.map((r) => `<li>${link(r.url, esc(r.title))}${r.location ? ` <span class="muted">· ${esc(r.location)}</span>` : ""}</li>`))}
${list("Angles for your application", b.angles.map((a) => `<li>${esc(a)}</li>`))}
${list("Still unknown", b.open_questions.map((q) => `<li>${esc(q)}</li>`))}
<div style="padding:12px 16px;border-top:1px solid var(--line)">${button}</div></div></section>`;
}

const researchingRoles = new Set<number>();

const OUTREACH: Record<string, { label: string; tone: string }> = {
  drafted: { label: "Not sent", tone: "neutral" },
  note_sent: { label: "Note sent", tone: "accent" },
  dm_sent: { label: "DM sent", tone: "accent" },
  replied: { label: "Replied", tone: "ok" },
  conversation: { label: "In conversation", tone: "ok" },
  skipped: { label: "Skipped", tone: "muted" },
};

function detail(id: number, q: URLSearchParams) {
  const o = getOpportunity(id);
  if (!o) return null;
  const people = outreachForOpportunity(id);
  const threads = all<{ id: number; channel: string; subject: string; last_from: string; last_message_at: string; last_snippet: string }>("SELECT * FROM threads WHERE opportunity_id = $id ORDER BY last_message_at DESC", { id });
  const prose = (title: string, text: string | null) => (text ? `<section class="block"><h2>${title}</h2><div class="prose">${esc(text.trim())}</div></section>` : "");
  const fold = (title: string, text: string | null) => (text ? `<details class="fold"><summary>${title}</summary><div class="prose">${esc(text.trim())}</div></details>` : "");
  const closes = closesLabel(o.closes_on);
  const isOpen = ["found", "decide", "ready"].includes(o.status);
  const isClosed = (CLOSED as readonly string[]).includes(o.status);
  const packing = o.pack_status === "queued" || o.pack_status === "building" || o.pack_status === "approved";
  const hasResume = o.resume_path && existsSync(o.resume_path);

  const toolbar = [
    o.apply_url ? linkButton(o.apply_url, `Open the application${icon("external")}`, isClosed ? "default" : "primary", true) : "",
    hasResume ? linkButton(`/resume/${o.id}`, `${icon("download")}Resume PDF`) : o.resume_url ? linkButton(o.resume_url, `Resume${icon("external")}`, "default", true) : "",
    hasResume ? linkButton(`/resume/${o.id}/edit`, "Edit resume", "quiet") : "",
    isOpen ? postButton(`/o/${o.id}/applied`, "Mark applied", { variant: o.apply_url ? "default" : "primary" }) : "",
    packing ? "" : o.pack_status === "ready"
      ? postButton(`/o/${o.id}/repack`, `${icon("refresh")}Rebuild pack`, { variant: "quiet", confirm: "Rebuild the pack? The fit read, resume and drafts are written again." })
      : isOpen ? postButton(`/o/${o.id}/build`, "Build pack") : "",
    `<span class="spacer"></span>`,
    isClosed ? "" : postButton(`/o/${o.id}/drop`, "Drop role", { variant: "danger", confirm: `Drop ${o.role} at ${o.company}? Its reminders close too.` }),
  ].join("");

  const facts: [string, string][] = [
    ["Stage", statusBadge(o.status)],
    ...(o.fit_verdict ? [["Fit", fitBadge(o.fit_verdict)] as [string, string]] : []),
    ...(o.pay ? [["Pay", esc(o.pay)] as [string, string]] : []),
    ...(closes ? [["Closing date", `<span class="${closes.tone ? `tone-${closes.tone}` : ""}">${esc(closes.text)}</span>`] as [string, string]] : []),
    ...(o.date_applied ? [["Applied", day(o.date_applied)] as [string, string]] : []),
    ...(o.who_can_apply ? [["Who can apply", esc(o.who_can_apply)] as [string, string]] : []),
    ...(o.hard_gate ? [["Hard gate", esc(o.hard_gate)] as [string, string]] : []),
    ["Source", o.source_url ? `<a href="${esc(o.source_url)}" target="_blank" rel="noopener">${esc(sourceLabel(o.source))}</a>` : esc(sourceLabel(o.source))],
    ["Added", day(o.created_at)],
  ];

  const peopleHtml = people.map((r) => {
    const st = r.status === "note_sent" ? { label: `Sent${r.sent_at ? ` ${day(r.sent_at)}` : ""}, not accepted yet`, tone: "warn" }
      : r.accepted_at && r.status === "dm_sent" ? { label: `Accepted ${day(r.accepted_at)}`, tone: "ok" }
      : OUTREACH[r.status] ?? { label: r.status, tone: "neutral" };
    const note = r.connection_note ?? r.full_dm;
    // Sending is the action; the inbox sync records when they accept or reply.
    const buttons = [
      r.status === "drafted" && r.linkedin_url && note
        ? `<a class="btn primary" href="${esc(r.linkedin_url)}" target="_blank" rel="noopener" data-open="/r/${r.id}/note_sent" data-counts data-copy-text="${esc(note)}">Copy note, open LinkedIn${icon("external")}</a>` : "",
      r.status !== "skipped" && r.status === "drafted" ? postButton(`/r/${r.id}/skipped`, "Skip this person", { variant: "quiet" }) : "",
    ].join("");
    const rows: [string, string | null][] = [["Why them", r.why_them], ["Hook", r.hook_source], ["Best time", r.send_time]];
    return `<li class="person"><div class="person-head"><span class="who">${esc(r.name)}</span>${badge(st.label, st.tone)}</div>
<p class="small muted">${esc([r.title, r.degree].filter(Boolean).join(" · "))}</p>
${r.linkedin_url ? `<p class="small" style="margin-top:4px"><a href="${esc(r.linkedin_url)}" target="_blank" rel="noopener">LinkedIn profile</a></p>` : ""}
<dl>${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
${copyBlock("Connection note", r.connection_note, "h3")}${copyBlock("Message", r.full_dm, "h3")}
${r.reply ? `<div class="callout" style="margin-top:14px"><b>Their reply:</b> ${esc(r.reply)}</div>` : ""}
<div class="btn-row">${buttons}</div></li>`;
  }).join("");

  const next = all<ActionRow>("SELECT * FROM actions WHERE opportunity_id = $id AND status = 'open' ORDER BY due_at", { id });
  const meetings = all<{ title: string; start_at: string; status: string; join_url: string | null; link: string | null }>(
    "SELECT * FROM meetings WHERE opportunity_id = $id ORDER BY start_at DESC", { id });
  const localTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: TIMEZONE });
  const meetingsHtml = meetings.length ? `<section class="block"><div class="section-head"><h2>Interviews</h2><span class="count num">${meetings.length}</span></div><div class="panel"><ul class="list">${meetings.map((m) => {
    const past = new Date(m.start_at) < new Date();
    return `<li class="item"><div class="item-main"><span class="item-title">${esc(m.title)}</span>
<div class="item-meta"><span>${esc(localTime(m.start_at))}</span>${m.status === "cancelled" ? badge("Cancelled", "danger") : past ? badge("Done", "muted") : badge("Upcoming", "accent")}</div></div>
<div class="item-actions">${m.join_url && !past && m.status !== "cancelled" ? linkButton(m.join_url, `Join${icon("external")}`, "default", true) : ""}${m.link ? linkButton(m.link, `Calendar${icon("external")}`, "quiet", true) : ""}</div></li>`;
  }).join("")}</ul></div></section>` : "";
  const isLive = !isClosed;
  const upNext = isLive ? `<section class="block"><div class="section-head"><h2>Up next</h2></div><div class="panel">${next.length
    ? `<ul class="list">${next.map((a) => actionItem(a)).join("")}</ul>`
    : emptyState("No next step", `You dropped this role's reminders. ${postButton(`/o/${o.id}/remind`, "Remind me", { variant: "primary" })}`)}</div></section>` : "";

  const main = [
    upNext,
    meetingsHtml,
    isLive ? hiringSection(o, researchingRoles.has(o.id)) : "",
    o.pack_error ? `<div class="callout danger" role="alert"><b>The pack didn't finish.</b> ${esc(o.pack_error)}</div>` : "",
    packing ? `<div class="callout accent" role="status">The pack is being built. It arrives in Telegram and on this page, usually within a few minutes.</div>` : "",
    prose("Fit", o.fit_read),
    prose("Next step", o.next_step),
    copyBlock("Cover note", o.cover_note),
    copyBlock("Form answers", o.form_answers),
    `<section class="block" id="people"><div class="section-head"><h2>People to contact</h2><span class="count num">${people.length}</span></div>
<div class="panel">${people.length ? `<ul class="list">${peopleHtml}</ul>` : emptyState("No outreach drafted", o.pack_status === "ready" ? "This pack didn't find anyone worth contacting." : "People and their messages are drafted with the pack.")}</div></section>`,
    threads.length ? `<section class="block"><div class="section-head"><h2>Conversations</h2><span class="count num">${threads.length}</span></div><div class="panel"><ul class="list">${threads.map((t) => `<li class="item"><div class="item-main"><span class="item-title">${esc(t.subject)}</span>
<p class="item-detail clamp">${esc(t.last_snippet)}</p><div class="item-meta"><span>${t.channel === "linkedin" ? "LinkedIn" : t.channel === "x" ? "X" : "Email"}</span><span>${t.last_from === "me" ? "You wrote last" : "They wrote last"}</span><span>${day(t.last_message_at)}</span></div></div></li>`).join("")}</ul></div></section>` : "",
    fold("Job description", o.jd_text),
    fold("About the company", o.company_brief),
  ].filter(Boolean).join("");

  return page(`${o.role} · ${o.company}`, `
<a class="back" href="/list">${icon("back")}Roles</a>
<header class="role-head"><h1>${esc(o.role)}</h1><p class="company">${esc(o.company)}</p>
<div class="badges">${statusBadge(o.status)}${fitBadge(o.fit_verdict)}${closes?.tone ? badge(closes.text, closes.tone) : ""}</div></header>
<div class="toolbar">${toolbar}</div>
<div class="split flip"><div class="stack">${main || emptyState("No pack yet", "Build the pack to get the fit read, resume and drafts.")}</div>
<aside><div class="panel"><dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl></div></aside></div>`,
    { tab: "roles", flash: q.get("flash") });
}

// ---------- Resume editor ----------

/** Resumes being written again right now (the AI takes a few minutes). */
const rewriting = new Set<number>();
const resumeJson = (pdf: string) => pdf.replace(/\.pdf$/i, ".json");

function loadResume(id: number): { o: Opportunity; resume: Resume | null } | null {
  const o = getOpportunity(id);
  if (!o?.resume_path || !existsSync(o.resume_path)) return null;
  const file = resumeJson(o.resume_path);
  return { o, resume: existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Resume) : null };
}

function resumeEditor(id: number, q: URLSearchParams) {
  const found = loadResume(id);
  if (!found) return null;
  const { o, resume } = found;
  const name = esc([o.role, o.company].filter(Boolean).join(" · "));
  const head = `<a class="back" href="/o/${o.id}">${icon("back")}${name}</a>
<header class="role-head"><h1>Edit resume</h1><p class="company">${name}</p></header>`;
  const rebuild = postButton(`/resume/${o.id}/rebuild`, `${icon("refresh")}Rewrite resume`, {
    variant: resume ? "quiet" : "primary",
    confirm: resume ? "Write this resume again from your evidence? Your edits here are replaced." : "",
  });
  if (rewriting.has(o.id)) {
    return page("Edit resume", `${head}<div class="callout accent" role="status">The resume is being written again. This takes a few minutes; reload the page to edit it.</div>`, { tab: "roles", flash: q.get("flash") });
  }
  if (!resume) {
    return page("Edit resume", `${head}
<div class="stack"><div class="callout">This resume was made before editing was added, so only its PDF was saved. Rewrite it once (only the resume; your drafts and people stay) and it becomes editable. Blanks like [FILL IN] are left out now.</div>
<div class="btn-row">${rebuild}${linkButton(`/resume/${o.id}`, `${icon("download")}View current PDF`, "quiet", true)}</div></div>`, { tab: "roles", flash: q.get("flash") });
  }
  const blanks = blanksIn(resume);
  return page("Edit resume", `${head}
<div class="toolbar"><button type="button" class="btn primary" id="rs-save">Save and update PDF</button>
${linkButton(`/resume/${o.id}`, `${icon("download")}View PDF`, "default", true)}
<span class="spacer"></span>${rebuild}</div>
<p class="small muted" style="margin-bottom:12px">Click any text to change it. Enter adds a bullet or education line; clear a line to remove it. Your name and contact details come from your profile.</p>
<p class="callout${blanks.length ? " danger" : ""}" id="rs-status" role="status" aria-live="polite"${blanks.length ? "" : " hidden"}></p>
<iframe id="rs-sheet" title="Resume" style="display:block;width:100%;max-width:900px;margin:16px auto 0;border:1px solid var(--line);border-radius:var(--r-md);background:#ecebe7;min-height:80vh" srcdoc="${esc(resumeHtml(resume, undefined, { edit: true }))}"></iframe>
<script>(()=>{
const BLANK=/\[(FILL|TODO|TBD|ADD|INSERT)[^\]]*\]/i, frame=document.getElementById('rs-sheet'), save=document.getElementById('rs-save'), status=document.getElementById('rs-status');
let doc, dirty=false;
const fields=()=>[...doc.querySelectorAll('[data-f]')];
const fit=()=>{frame.style.height=doc.documentElement.scrollHeight+'px'};
function check(){
  const left=fields().filter(el=>BLANK.test(el.innerText));
  status.hidden=!left.length;status.className='callout danger';
  status.innerHTML=left.length?(left.length===1?'1 blank left.':left.length+' blanks left.')+' Fill each one in or delete it before saving. <button type="button" class="btn quiet sm" id="rs-next">Go to next</button>':'';
  const n=document.getElementById('rs-next'); if(n) n.onclick=()=>{const el=left[0];el.scrollIntoView({block:'center'});el.focus()};
  return left.length;
}
function caretEnd(el){el.focus();const r=doc.createRange();r.selectNodeContents(el);r.collapse(false);const s=doc.getSelection();s.removeAllRanges();s.addRange(r)}
frame.addEventListener('load',()=>{
  doc=frame.contentDocument; fit(); check();
  new ResizeObserver(fit).observe(doc.body);
  doc.addEventListener('input',()=>{dirty=true;check()});
  doc.addEventListener('paste',e=>{e.preventDefault();doc.execCommand('insertText',false,e.clipboardData.getData('text/plain').replace(/\s+/g,' '))});
  doc.addEventListener('keydown',e=>{
    const el=e.target.closest&&e.target.closest('[data-f]'); if(!el) return;
    if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();save.click();return}
    const list=el.parentElement.dataset.list;
    if(e.key==='Enter'){e.preventDefault(); if(!list) return;
      const n=doc.createElement(el.tagName);n.dataset.f=list+'.new';n.contentEditable='plaintext-only';n.dataset.hint=el.dataset.hint||'';
      el.after(n);n.focus();dirty=true;fit()}
    if(e.key==='Backspace'&&list&&!el.innerText.trim()&&el.parentElement.children.length>1){
      e.preventDefault();const prev=el.previousElementSibling||el.nextElementSibling;el.remove();caretEnd(prev);dirty=true;fit()}
  });
});
addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();save.click()}});
addEventListener('beforeunload',e=>{if(dirty){e.preventDefault()}});
save.addEventListener('click',async()=>{
  if(!doc) return; if(check()){document.getElementById('rs-next')?.click();return}
  save.disabled=true;save.textContent='Saving…';
  try{
    const r=await fetch('/resume/${o.id}/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fields().map(el=>[el.dataset.f,el.innerText]))});
    const j=await r.json(); if(!j.ok) throw new Error(j.error);
    dirty=false; location.href='/resume/${o.id}/edit?flash='+encodeURIComponent(j.message);
  }catch(err){status.hidden=false;status.className='callout danger';status.textContent=String(err.message||err);save.disabled=false;save.textContent='Save and update PDF'}
});
})()</script>`, { tab: "roles", flash: q.get("flash"), wide: true });
}

// ---------- Watched pages ----------

const ago = (iso: string | null) => {
  if (!iso) return "not scanned yet";
  const h = (Date.now() - new Date(iso).getTime()) / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};
const INTERVALS = [2, 4, 6, 12, 24];

function sourcesPage(q: URLSearchParams) {
  const sources = listSources();
  const prefill = q.get("url") ?? "";
  const note = q.get("note");
  const rows = sources.map((src) => {
    const found = get<{ n: number; fits: number }>(
      "SELECT count(*) n, sum(fit_verdict IN ('apply','stretch')) fits FROM opportunities WHERE source = $s", { s: `watch:${src.label}` },
    )!;
    const last = src.last_result ? describeResult(JSON.parse(src.last_result) as ScanResult) : "";
    return `<li class="item"><div class="item-main"><div class="person-head"><span class="item-title">${esc(src.label)}</span>${src.status === "paused" ? badge("Paused", "muted") : ""}${src.last_error ? badge("Failing", "danger") : ""}</div>
<p class="small" style="margin-top:2px;overflow-wrap:anywhere"><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.url)}</a></p>
<div class="item-meta"><span>Every ${src.interval_hours} h</span><span>Last scan ${ago(src.last_scanned_at)}${last ? `: ${esc(last)}` : ""}</span>
${found.n ? `<a href="/list?source=${encodeURIComponent(`watch:${src.label}`)}">${plural(found.n, "role")} found${found.fits ? `, ${found.fits} worth applying to` : ""}</a>` : "<span>No matching roles yet</span>"}</div>
${src.last_error ? `<p class="small tone-danger" style="margin-top:6px">${esc(src.last_error)}</p>` : ""}</div>
<div class="item-actions">${postButton(`/s/${src.id}/scan`, "Scan now")}${src.status === "paused" ? postButton(`/s/${src.id}/resume`, "Resume", { variant: "quiet" }) : postButton(`/s/${src.id}/pause`, "Pause", { variant: "quiet" })}${postButton(`/s/${src.id}/remove`, "Remove", { variant: "danger", confirm: `Stop watching ${src.label}? Roles already found there stay.` })}</div></li>`;
  });
  return page("Watched pages · Job hunt", `
<div class="page-head"><div><h1>Watched pages</h1><p style="max-width:68ch">Job boards, careers pages and curated feeds, checked on a timer. New postings that fit your targets arrive in Telegram as one list; the rest are left out.</p></div></div>
${note ? `<div class="callout note" role="status">${esc(note)}</div>` : ""}
<section class="stack" style="margin-bottom:32px"><div><div class="section-head"><h2>Watch a page</h2></div>
<form class="panel add-source" method="post" action="/sources">
<label class="sr" for="src-url">Page link</label><input id="src-url" type="url" name="url" placeholder="Job board or careers page link" value="${esc(prefill)}" required${prefill ? "" : " autofocus"}>
<label class="sr" for="src-label">Name</label><input id="src-label" type="text" name="label" placeholder="Name (optional)">
<label class="sr" for="src-int">How often</label><select id="src-int" name="interval">${INTERVALS.map((h) => `<option value="${h}" ${h === 6 ? "selected" : ""}>Every ${h} hours</option>`).join("")}</select>
<button class="btn primary">Watch page</button></form>
<p class="hint" style="margin-top:10px">If a board has filters or a "newest" sort, set them first and watch that link. To add the page you're on: drag <a class="bookmarklet" href="javascript:void(window.open('http://127.0.0.1:${env.port}/sources?url='+encodeURIComponent(location.href)))">${icon("bookmark")}Watch page</a> to your bookmarks bar.</p></div></section>
<section><div class="section-head"><h2>Watching</h2><span class="count num">${sources.length}</span></div>
<div class="panel">${rows.length ? `<ul class="list">${rows.join("")}</ul>` : emptyState("No pages watched yet", "Add one above, or send <code>/watch &lt;link&gt;</code> to the Telegram bot.")}</div></section>`,
    { tab: "sources" });
}

// ---------- People ----------

const WARMTH: Record<string, [string, string]> = { close: ["Close", "ok"], warm: ["Warm", "info"], cold: ["No reply yet", ""] };
const initials = (name: string) => name.replace(/\(.*?\)|"[^"]*"/g, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
const cleanCompany = (c: string | null) => (c ?? "").replace(/\s*\(.*\)\s*$/, "");

/** One row in the People directory. */
function personRow(r: Relationship, next: ActionRow | undefined, conn?: { status: string; sent_at: string | null; accepted_at: string | null }) {
  const keeps = keepsInTouch(r);
  const sub = [r.title, cleanCompany(r.company)].filter(Boolean).join(" · ");
  const last = r.last_touch_at
    ? `${day(r.last_touch_at)}, ${r.last_from === "me" ? "you wrote" : "they wrote"}${r.last_channel && r.last_channel !== "note" ? ` on ${esc(r.last_channel === "linkedin" ? "LinkedIn" : r.last_channel)}` : ""}`
    : "Not yet";
  const nextText = next ? `${esc(next.title.replace(/:.*$/, ""))}, ${esc(dueLabel(next.due_at).text.toLowerCase())}` : keeps ? "None due" : "Reminders off";
  const nextTone = next && dueLabel(next.due_at).tone === "danger" ? " danger" : "";
  const roles = r.roles.slice(0, 3).map((x) => `<a href="/o/${x.id}">${esc(x.role)}</a>`).join(", ");
  const more = `<details class="pop"><summary class="btn quiet sm icon-only" aria-label="More for ${esc(r.name)}">${icon("more")}</summary><div class="menu">
${r.linkedin_url ? `<a class="menu-item" href="${esc(r.linkedin_url)}" target="_blank" rel="noopener"><span>Open LinkedIn</span>${icon("external")}</a>` : ""}
${r.email ? `<a class="menu-item" href="mailto:${esc(r.email)}"><span>Write an email</span>${icon("mail")}</a>` : ""}
${r.automated ? "" : keeps ? `<form method="post" action="/p/${r.contact_id}/stop" data-inline><button class="menu-item">Stop reminders</button></form>` : `<form method="post" action="/p/${r.contact_id}/keep" data-inline><button class="menu-item">Keep in touch</button></form>`}
</div></details>`;
  return `<li class="dir-row" data-person data-text="${esc(`${r.name} ${r.title ?? ""} ${r.company ?? ""}`.toLowerCase())}">
<span class="avatar" aria-hidden="true">${esc(initials(r.name))}</span>
<div class="dir-main"><span class="dir-name">${esc(r.name)} <span class="chip ${WARMTH[r.warmth][1]}">${WARMTH[r.warmth][0]}</span>${r.automated ? ` <span class="chip">Inbox</span>` : ""}${conn?.status === "note_sent" ? ` <span class="chip warn">Note sent${conn.sent_at ? ` ${day(conn.sent_at)}` : ""}, not accepted yet</span>` : conn?.accepted_at ? ` <span class="chip ok">Connected ${day(conn.accepted_at)}</span>` : ""}</span>
${sub ? `<span class="dir-sub">${esc(sub)}</span>` : ""}${roles ? `<span class="dir-sub">Roles: ${roles}</span>` : ""}</div>
<div class="dir-col"><span class="dir-label">Last in touch</span><span>${last}</span></div>
<div class="dir-col"><span class="dir-label">Next reminder</span><span class="${nextTone ? "tone-danger" : ""}">${nextText}</span></div>
<div class="dir-actions"><form method="post" action="/p/${r.contact_id}/touch" data-inline><button class="btn sm" title="You talked some other way (a call, a comment, a coffee): the reminder clock restarts">In touch today</button></form>${more}</div>
</li>`;
}

function peoplePage(q: URLSearchParams) {
  reconcileActions();
  const everyone = loadRelationships();
  const t = getTimers();
  // Each person's next reminder: loop:touch:<contact>:<time>, loop:close:<role>:<contact>, loop:reengage:<role>:<contact>.
  const open = all<ActionRow>(
    `SELECT * FROM actions WHERE status = 'open' AND (rule_key LIKE 'loop:touch:%' OR rule_key LIKE 'loop:close:%' OR rule_key LIKE 'loop:reengage:%') ORDER BY due_at`,
  ).map((a) => { const p = a.rule_key.split(":"); return { ...a, contact: Number(p[1] === "touch" ? p[2] : p[3]) }; });
  const nextFor = (id: number) => open.find((a) => a.contact === id);
  const conns = new Map(all<{ contact_id: number; status: string; sent_at: string | null; accepted_at: string | null }>(
    "SELECT contact_id, status, sent_at, accepted_at FROM outreach WHERE status IN ('note_sent','dm_sent','replied','conversation') ORDER BY id",
  ).map((c) => [c.contact_id, c]));
  const soon = Date.now() + 7 * 86_400_000;
  const dueSoon = everyone.map((r) => ({ r, a: nextFor(r.contact_id) })).filter((x) => x.a && new Date(x.a.due_at).getTime() <= soon);
  const counts = { close: everyone.filter((r) => r.warmth === "close").length, warm: everyone.filter((r) => r.warmth === "warm").length, cold: everyone.filter((r) => r.warmth === "cold").length };
  const show = ["close", "warm", "cold", "all"].includes(q.get("show") ?? "") ? q.get("show")! : "known";
  const listed = everyone.filter((r) => show === "all" || (show === "known" ? r.warmth !== "cold" : r.warmth === show));
  const tab = (key: string, label: string, n: number) => `<a class="ktab" href="/people${key === "known" ? "" : `?show=${key}`}"${show === key ? ` aria-current="page"` : ""}>${label}<span class="ktab-count">${n}</span></a>`;

  const cards = dueSoon.slice(0, 6).map(({ r, a }) => {
    const due = dueLabel(a!.due_at);
    return `<li class="due-row" data-row data-aid="${a!.id}">
<span class="avatar" aria-hidden="true">${esc(initials(r.name))}</span>
<div class="dir-main"><span class="dir-name">${esc(a!.title.replace(/\s*\(.*\)\s*$/, ""))}</span><span class="dir-sub">${esc([r.title, cleanCompany(r.company)].filter(Boolean).join(" · "))}</span>${a!.detail ? `<span class="dir-sub">${esc(a!.detail.split("\n")[0])}</span>` : ""}
<span class="due ${due.tone === "danger" ? "danger" : ""}">${icon("clock")}${esc(due.text)}</span></div>
<div class="dir-actions"><form method="post" action="/a/${a!.id}/done" data-inline data-act="done"><button class="btn primary sm">Mark as sent</button></form>
<form method="post" action="/a/${a!.id}/snooze" data-inline data-act="snooze"><input type="hidden" name="hours" value="72"><button class="btn sm">After 3 days</button></form>
${r.linkedin_url ? `<a class="btn quiet sm" href="${esc(r.linkedin_url)}" target="_blank" rel="noopener">LinkedIn${icon("external")}</a>` : ""}</div></li>`;
  }).join("");

  return page("People · Job hunt", `
<div class="vstack page-stack-sm">
<div><h1>People</h1><p class="lede">Everyone you have talked to about work. Keep in touch with them, and tell them before you apply at their company.</p></div>
<div class="tiles">
<a class="tile" href="/people?show=close"><span class="tile-label">Close</span><span class="tile-value">${counts.close}</span><span class="tile-help">A note every ${t.keepInTouchCloseDays} days</span></a>
<a class="tile" href="/people?show=warm"><span class="tile-label">Warm</span><span class="tile-value">${counts.warm}</span><span class="tile-help">A note every ${t.keepInTouchWarmDays} days</span></a>
<a class="tile" href="#due"><span class="tile-label">Due for a note</span><span class="tile-value${dueSoon.some((x) => dueLabel(x.a!.due_at).tone === "danger") ? " danger" : ""}">${dueSoon.length}</span><span class="tile-help">In the next 7 days</span></a>
<a class="tile" href="/people?show=cold"><span class="tile-label">No reply yet</span><span class="tile-value">${counts.cold}</span><span class="tile-help">You wrote; they have not</span></a>
</div>
${cards ? `<section id="due" class="vstack section-stack" data-group="due"><div class="section-title-row"><h2>Due for a note</h2><p class="card-sub">Closing notes and stay-in-touch messages due this week.${dueSoon.length > 6 ? ` Showing 6 of ${dueSoon.length}; the rest are on Home.` : ""}</p></div>
<div class="panel"><ul class="dir">${cards}</ul></div></section>` : ""}
<section class="vstack section-stack" aria-labelledby="h-dir">
<div class="section-title-row"><h2 id="h-dir">Everyone</h2></div>
<div class="filters"><nav class="ktabs" aria-label="Show">${tab("known", "Close and warm", counts.close + counts.warm)}${tab("close", "Close", counts.close)}${tab("warm", "Warm", counts.warm)}${tab("cold", "No reply yet", counts.cold)}${tab("all", "All", everyone.length)}</nav>
<div class="search">${icon("search")}<label class="sr" for="p-q">Search people</label><input id="p-q" type="search" placeholder="Search name or company  /" data-filter="[data-person]" autocomplete="off" value="${esc(q.get("q") ?? "")}"></div></div>
<div class="panel">${listed.length ? `<ul class="dir">${listed.map((r) => personRow(r, nextFor(r.contact_id), conns.get(r.contact_id))).join("")}</ul><div data-filter-empty hidden>${emptyState("No one matches that search", "Try a first name or a company.")}</div>`
    : emptyState("No one here yet", "People appear here once you have written to each other, on any channel.")}</div>
</section></div>`, { tab: "people", flash: q.get("flash"), meta: `${everyone.length} people` });
}

// ---------- Target companies ----------

function companiesPage(q: URLSearchParams) {
  const list = listCompanies();
  const note = q.get("note");
  const found = (name: string) => get<{ n: number; fits: number }>(
    "SELECT count(*) n, coalesce(sum(fit_verdict IN ('apply','stretch')), 0) fits FROM opportunities WHERE source = $s", { s: `company:${name}` },
  )!;
  const needsCheck = list.filter((c) => c.needs_check);
  const noBoard = list.filter((c) => !c.needs_check && !c.board_type && !c.source_id);
  const failing = list.filter((c) => !c.needs_check && c.last_error);
  const watching = list.filter((c) => !c.needs_check && (c.board_type || c.source_id));
  const totals = list.reduce((s, c) => { const f = found(c.name); return { n: s.n + f.n, fits: s.fits + (f.fits ?? 0) }; }, { n: 0, fits: 0 });

  const linkForm = (c: (typeof list)[number], label: string) => `<form class="inline-form" method="post" action="/companies"><input type="hidden" name="names" value="${esc(c.name)}"><label class="sr" for="cl-${c.id}">Careers page link for ${esc(c.name)}</label><input id="cl-${c.id}" type="url" name="link" placeholder="Careers page or job board link" required><button class="btn sm">${label}</button></form>`;
  const attention = [
    ...needsCheck.map((c) => `<li class="attn-row"><div class="dir-main"><span class="dir-name">${esc(c.name)} <span class="chip warn">Check this board</span></span>
<span class="dir-sub">Guessed from the name. It lists none of your roles.${c.board_type && c.board_slug ? ` <a href="${esc(boardUrl({ type: c.board_type, slug: c.board_slug }))}" target="_blank" rel="noopener">Open the board</a>` : ""}</span></div>
${linkForm(c, "Use this link")}<div class="dir-actions">${postButton(`/c/${c.id}/resume`, "Right company", { variant: "primary" }).replace('class="btn primary"', 'class="btn primary sm"')}</div></li>`),
    ...noBoard.map((c) => `<li class="attn-row"><div class="dir-main"><span class="dir-name">${esc(c.name)} <span class="chip">No job board found</span></span>
<span class="dir-sub">Paste their careers page to start checking it.</span></div>
${linkForm(c, "Find board")}<div class="dir-actions">${postButton(`/c/${c.id}/remove`, "Remove", { variant: "quiet", confirm: `Stop watching ${c.name}?` }).replace('class="btn quiet"', 'class="btn quiet sm"')}</div></li>`),
    ...failing.map((c) => `<li class="attn-row"><div class="dir-main"><span class="dir-name">${esc(c.name)} <span class="chip danger">Check failing</span></span><span class="dir-sub tone-danger">${esc(c.last_error ?? "")}</span></div><span></span>
<div class="dir-actions">${postButton(`/c/${c.id}/scan`, "Try again").replace('class="btn default"', 'class="btn sm"')}</div></li>`),
  ];

  const rows = watching.map((c) => {
    const f = found(c.name);
    const last = c.last_result ? describeCompanyScan(JSON.parse(c.last_result) as CompanyScan) : "";
    const board = c.board_type && c.board_slug
      ? `<a href="${esc(boardUrl({ type: c.board_type, slug: c.board_slug }))}" target="_blank" rel="noopener">${esc(BOARD_LABEL[c.board_type])} board</a>`
      : `<a href="/sources">Careers page</a>`;
    const people = knownPeopleAt(c.name);
    return `<li class="co-row" data-company data-text="${esc(c.name.toLowerCase())}">
<div class="dir-main"><span class="dir-name">${esc(c.name)}${c.status === "paused" ? ` <span class="chip">Paused</span>` : ""}${c.added_via === "auto" ? ` <span class="chip">From your roles</span>` : ""}</span>
<span class="dir-sub">${board}${people.length ? ` · You know ${esc(people.slice(0, 2).map((p) => p.name).join(", "))}${people.length > 2 ? ` and ${people.length - 2} more` : ""}` : ""}</span></div>
<div class="dir-col"><span class="dir-label">Roles found</span><span>${f.n ? `<a href="/list?source=${encodeURIComponent(`company:${c.name}`)}">${f.n}${f.fits ? `, ${f.fits} worth applying` : ""}</a>` : "None yet"}</span></div>
<div class="dir-col"><span class="dir-label">Last check</span><span>${ago(c.last_scanned_at)}${last ? `<span class="dir-sub">${esc(last)}</span>` : ""}</span></div>
<div class="dir-actions">${c.board_type ? `<form method="post" action="/c/${c.id}/interval"><label class="sr" for="ci-${c.id}">How often to check ${esc(c.name)}</label><select id="ci-${c.id}" name="interval" onchange="this.form.submit()">${[1, 2, 3, 6, 12, 24].map((h) => `<option value="${h}"${h === c.interval_hours ? " selected" : ""}>Every ${h} h</option>`).join("")}</select></form>` : ""}
<details class="pop"><summary class="btn quiet sm icon-only" aria-label="More for ${esc(c.name)}">${icon("more")}</summary><div class="menu">
${c.board_type ? `<form method="post" action="/c/${c.id}/scan"><button class="menu-item">Check now</button></form>` : ""}
${c.status === "paused" ? `<form method="post" action="/c/${c.id}/resume"><button class="menu-item">Resume</button></form>` : `<form method="post" action="/c/${c.id}/pause"><button class="menu-item">Pause</button></form>`}
<div class="menu-sep"></div><form method="post" action="/c/${c.id}/remove" data-confirm="${esc(`Stop watching ${c.name}? Roles already found there stay.`)}"><button class="menu-item tone-danger">Stop watching</button></form>
</div></details></div></li>`;
  });

  return page("Companies · Job hunt", `
<div class="vstack page-stack-sm">
<div><h1>Target companies</h1><p class="lede">The companies you most want to work at, checked through their own job board. New roles that fit reach Telegram within a few hours.</p></div>
${note ? `<div class="callout note" role="status"><p class="prose">${esc(note)}</p></div>` : ""}
<div class="tiles">
<div class="tile"><span class="tile-label">Watching</span><span class="tile-value">${watching.filter((c) => c.status === "active").length}</span><span class="tile-help">Checked on their own</span></div>
<a class="tile" href="#attention"><span class="tile-label">Need your help</span><span class="tile-value${attention.length ? " danger" : ""}">${attention.length}</span><span class="tile-help">${needsCheck.length} to check, ${noBoard.length} without a board</span></a>
<div class="tile"><span class="tile-label">Roles found</span><span class="tile-value">${totals.n}</span><span class="tile-help">${totals.fits} worth applying to</span></div>
<div class="tile"><span class="tile-label">Paused</span><span class="tile-value">${list.filter((c) => c.status === "paused" && !c.needs_check).length}</span><span class="tile-help">Not checked until you resume</span></div>
</div>
<div class="split">
<div class="vstack page-stack-sm">
${attention.length ? `<section id="attention" class="vstack section-stack"><div class="section-title-row"><h2>Need your help</h2><p class="card-sub">These cannot be checked until you confirm the board or add a careers link.</p></div>
<div class="panel"><ul class="dir">${attention.slice(0, 6).join("")}</ul>${attention.length > 6 ? `<details class="overflow plain"><summary>Show ${attention.length - 6} more</summary><ul class="dir">${attention.slice(6).join("")}</ul></details>` : ""}</div></section>` : ""}
<section class="vstack section-stack" aria-labelledby="h-watch"><div class="filters"><div class="section-title-row"><h2 id="h-watch">Watching</h2><span class="card-sub">${watching.length}</span></div>
<div class="search">${icon("search")}<label class="sr" for="c-q">Search companies</label><input id="c-q" type="search" placeholder="Search companies  /" data-filter="[data-company]" autocomplete="off" value="${esc(q.get("q") ?? "")}"></div></div>
<div class="panel">${rows.length ? `<ul class="dir">${rows.join("")}</ul><div data-filter-empty hidden>${emptyState("No company matches that search")}</div>` : emptyState("No companies are being watched yet", "Add the companies you most want to work at.")}</div></section>
</div>
<aside><section class="card"><div class="card-head"><h2 class="card-title">Add companies</h2><p class="card-sub">One company per line. Add a careers link after a | if you have one.</p></div>
<form class="vstack section-stack" method="post" action="/companies"><label for="co-names" class="sr">Companies to add</label>
<textarea id="co-names" class="field" name="names" placeholder="Stripe&#10;Factory&#10;Packt | https://apply.workable.com/packtpublishing" required${list.length ? "" : " autofocus"}></textarea>
<button class="btn primary">Add and find their boards</button></form>
<p class="card-note">Most boards (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee) are found from the name. Companies from your roles are added on their own; ones you remove stay removed. From Telegram: <code>/company Stripe</code>.</p></section></aside>
</div></div>`, { tab: "companies", meta: `${list.length} companies` });
}

// ---------- Timers ----------

function timersPage(q: URLSearchParams) {
  const t = getTimers();
  const groups = [...new Set(Object.values(TIMER_SPECS).map((x) => x.group))];
  const row = (k: TimerKey) => {
    const spec = TIMER_SPECS[k];
    const changed = t[k] !== DEFAULT_TIMERS[k];
    return `<div class="timer-row"><div><label for="t-${k}">${esc(spec.label)}</label>
<p class="hint">${changed ? `Changed. Default ${spec.default} ${spec.unit}.` : `Default.`} Between ${spec.min} and ${spec.max}.</p></div>
<div class="timer-in"><input id="t-${k}" type="number" name="${k}" value="${t[k]}" min="${spec.min}" max="${spec.max}" step="1" inputmode="numeric" required${changed ? " data-changed" : ""}><span>${spec.unit}</span></div></div>`;
  };
  const d = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  return page("Timers · Job hunt", `
<div class="page-head"><div><h1>Timers</h1><p style="max-width:68ch">How long each step of an application can wait before the tool asks you to act. Every role in play always has one next step with a due date; these set the dates.</p></div></div>
<div class="stack" style="max-width:820px">
<section><div class="section-head"><h2>After you apply</h2></div><div class="panel"><ol class="ladder">
<li>Within ${t.firstTouchHours} hours: reach a person (recruiter or hiring manager).</li>
<li>Quiet for ${d(t.followUp1Days)} (${d(t.interviewFollowUpDays)} after an interview): follow up.</li>
<li>${d(t.followUp2Days)} later: follow up again, on another channel or with another person.</li>
<li>${d(t.closeAfterDays)} later: close warmly, so the door stays open.</li></ol>
<p class="small muted" style="padding:0 16px 14px">Anything from their side (an email, a reply to a DM, an interview invite) starts the steps again. A taken-down posting brings the next follow-up forward.</p></div></section>
<form method="post" action="/timers" class="stack">
${groups.map((g) => `<section><div class="section-head"><h2>${esc(g)}</h2></div><div class="panel">${(Object.keys(TIMER_SPECS) as TimerKey[]).filter((k) => TIMER_SPECS[k].group === g).map(row).join("")}</div></section>`).join("")}
<div class="btn-row"><button class="btn primary">Save timers</button></div></form>
${postButton("/timers/reset", "Reset all to defaults", { variant: "quiet", confirm: "Put every timer back to its default?" })}
</div>`,
    { tab: "timers", flash: q.get("flash") });
}

// ---------- small pages ----------

const message = (title: string, h: string, body: string) =>
  page(title, `<div style="max-width:560px"><h1>${h}</h1><div style="margin-top:12px" class="stack">${body}</div></div>`);

async function body(req: http.IncomingMessage): Promise<URLSearchParams> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return new URLSearchParams(data);
}

/** Where to send the person back to after a form post, with a toast message. */
function back(referer: string | undefined, flash: string) {
  const u = new URL(referer ?? "/", "http://localhost");
  u.searchParams.set("flash", flash);
  return u.pathname + u.search;
}

const ACTION_MSG: Record<string, string> = { done: "Marked as done.", drop: "Reminder removed.", snooze: "We will remind you tomorrow.", undo: "Back on your list." };
const OPP_MSG: Record<string, string> = { research: "Researching who's hiring. Reload in a few minutes.", remind: "The reminder is back on your list.", applied: "Marked as applied. Follow-up reminders start now.", drop: "Role dropped.", repack: "Rebuilding the pack. It arrives in a few minutes.", build: "Building the pack. It arrives in a few minutes." };
const OUTREACH_MSG: Record<string, string> = { note_sent: "Marked note sent.", dm_sent: "Marked DM sent.", replied: "Marked as replied.", skipped: "Skipped.", conversation: "Marked as in conversation." };

export function startServer(port = env.port, hooks?: Hooks) {
  setShellPort(port);
  setNavCounts(() => ({
    pending: dueActions().filter((a) => dueLabel(a.due_at).tone === "danger").length,
    roles: get<{ n: number }>(`SELECT count(*) n FROM opportunities WHERE status IN (${ACTIVE.map((s) => `'${s}'`).join(",")})`)!.n,
    interviews: upcomingCount(),
  }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const inline = req.headers["x-inline"] === "1";
    const redirect = (to: string) => { res.writeHead(303, { location: to }); res.end(); };
    const json = (code: number, data: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const htmlOut = (s: string | null) => {
      res.writeHead(s ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(s ?? message("Not found", "Page not found", `<p class="muted">That role or page doesn't exist any more. It may have been merged with a duplicate.</p><p>${linkButton("/", "Back to Home", "primary")}</p>`));
    };
    try {
      if (url.pathname.startsWith("/worker/")) return await handleWorker(req, res, url);
      if (await telegramConnectRoute(req, res, url)) return;
      if (desktopConnectRoute(req, res, url)) return;
      if (await googleConnectRoute(req, res, url)) return;
      if (setupRoute(req, res, url)) return;
      if (await setupProfileRoute(req, res, url)) return;
      if (await setupPlaybookRoute(req, res, url)) return;
      if (await setupKeysRoute(req, res, url)) return;
      if (setupExportRoute(req, res, url)) return;
      const m = url.pathname.match(/^\/(a|o|r)\/(\d+)\/(\w+)$/);
      if (req.method === "POST" && m) {
        const [, scope, idText, verb] = m;
        const id = Number(idText);
        let msg = "";
        if (scope === "a") {
          if (verb === "done") completeAction(id, "done");
          else if (verb === "drop") completeAction(id, "dropped");
          else if (verb === "snooze") {
            const hours = Math.min(Math.max(Number((await body(req)).get("hours")) || 24, 1), 24 * 14);
            snoozeAction(id, hours);
            msg = hours <= 24 ? "We will remind you tomorrow." : `We will remind you on ${new Date(Date.now() + hours * 3_600_000).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}.`;
          } else if (verb === "opened") {
            markOpened(id);
            const task = get<ActionRow>("SELECT * FROM actions WHERE id = $id", { id });
            const d = task ? directActions([task]).get(id) : undefined;
            if (task && d?.countsOnOpen) {
              // A LinkedIn note counts as sent once opened; the inbox sync records when they accept.
              if (task.outreach_id) run("UPDATE outreach SET status = 'note_sent', sent_at = coalesce(sent_at, $now) WHERE id = $o AND status = 'drafted'", { now: nowIso(), o: task.outreach_id });
              else completeAction(id, "done");
              reconcileActions();
              if (inline) return json(200, { ok: true, message: "Counted as sent. You will see when they accept." });
            }
            if (inline) return json(200, { ok: true, message: "Opened. It clears on its own once it is seen to be done.", remove: false });
          } else if (verb === "unopen") {
            clearOpened(id);
            if (inline) return json(200, { ok: true, message: "Back on your list.", remove: false, reload: true });
          } else if (verb === "undo") {
            run("UPDATE actions SET status = 'open', done_at = NULL, snoozed_until = NULL WHERE id = $id AND (status = 'dropped' OR status = 'open')", { id });
          }
          msg ||= ACTION_MSG[verb] ?? "";
          if (inline && (verb === "snooze" || verb === "drop")) { reconcileActions(); return json(200, { ok: true, message: msg, undo: `/a/${id}/undo` }); }
        } else if (scope === "o") {
          if (verb === "applied") updateOpportunity(id, { status: "applied", date_applied: nowIso().slice(0, 10) }, { byUser: true });
          else if (verb === "drop") updateOpportunity(id, { status: "dropped" }, { byUser: true });
          else if (verb === "repack") updateOpportunity(id, { pack_status: "queued" }, { byUser: true });
          else if (verb === "build") updateOpportunity(id, { pack_status: "approved", status: "found" }, { byUser: true });
          else if (verb === "remind") remindAgain(id);
          else if (verb === "followup") {
            const opp = getOpportunity(id);
            const today = nowIso().slice(0, 10);
            if (opp) run(`INSERT INTO actions (rule_key, kind, title, detail, due_at, urgent, opportunity_id)
                VALUES ($k, 'follow_up', $t, $d, $due, 0, $id) ON CONFLICT(rule_key) DO NOTHING`, {
              k: `web:followup:${id}:${today}`, t: `Follow up with ${opp.company.replace(/\s*\(.*\)\s*$/, "")}`,
              d: `You applied ${opp.date_applied ? `on ${day(opp.date_applied)}` : "a while ago"} and have not heard back. Send one short note. If there is no reply in a week, close the role.`,
              due: new Date(Date.now() + 86_400_000).toISOString(), id,
            });
            if (inline) return json(200, { ok: true, message: `Follow-up added for ${opp?.company ?? "this role"}. It is due tomorrow.`, remove: false, label: "Reminder set" });
          }
          else if (verb === "research") {
            if (hooks?.research && !researchingRoles.has(id)) {
              researchingRoles.add(id);
              void hooks.research(id).catch(() => false).finally(() => researchingRoles.delete(id));
            }
          }
          msg = OPP_MSG[verb] ?? "";
        } else if (scope === "r" && ["note_sent", "dm_sent", "replied", "skipped", "conversation"].includes(verb)) {
          run(`UPDATE outreach SET status = $s,
                 sent_at = CASE WHEN $s IN ('note_sent','dm_sent') THEN $now ELSE sent_at END,
                 replied_at = CASE WHEN $s = 'replied' THEN $now ELSE replied_at END WHERE id = $id`, { s: verb, now: nowIso(), id });
          msg = OUTREACH_MSG[verb] ?? "";
        }
        reconcileActions();
        if (inline) return json(200, { ok: true, message: msg });
        return redirect(back(req.headers.referer, msg));
      }
      const sm = url.pathname.match(/^\/s\/(\d+)\/(scan|pause|resume|remove)$/);
      if (req.method === "POST" && sm) {
        const id = Number(sm[1]);
        const src = getSource(id);
        let note = "";
        if (!src) note = "That page isn't watched any more.";
        else if (sm[2] === "scan") {
          void hooks?.scanNow(id, { force: true }).catch(() => {});
          note = `Scanning ${src.label} now. Refresh in a minute for the result; matches arrive in Telegram.`;
        } else if (sm[2] === "pause") { setSourceStatus(id, "paused"); note = `Paused ${src.label}. It won't be scanned until you resume it.`; }
        else if (sm[2] === "resume") { setSourceStatus(id, "active"); note = `Resumed ${src.label}.`; }
        else if (sm[2] === "remove") { removeSource(id); note = `Stopped watching ${src.label}. Roles found there stay.`; }
        return redirect(`/sources${note ? `?note=${encodeURIComponent(note)}` : ""}`);
      }
      if (req.method === "POST" && url.pathname === "/sources") {
        const form = await body(req);
        const link = form.get("url") ?? "";
        const r = hooks ? await hooks.watchPage(link, { label: form.get("label") || undefined, intervalHours: Number(form.get("interval")) || undefined, via: "web" }) : { text: "The dashboard isn't connected to the scanner. Start it with npm run daemon." };
        return redirect(`/sources?note=${encodeURIComponent(r.text)}`);
      }
      if (url.pathname === "/sources") return htmlOut(sourcesPage(url.searchParams));
      if (req.method === "POST" && url.pathname === "/companies") {
        const form = await body(req);
        const names = (form.get("names") ?? "").trim();
        const link = (form.get("link") ?? "").trim();
        const text = link ? `${names} | ${link}` : names;
        const r = hooks?.addCompanies ? await hooks.addCompanies(text, "web") : { lines: ["The dashboard isn't connected to the scanner. Start it with npm run daemon."] };
        return redirect(`/companies?note=${encodeURIComponent(r.lines.join("\n") || "Nothing to add.")}`);
      }
      const pm = url.pathname.match(/^\/p\/(\d+)\/(touch|stop|keep)$/);
      if (req.method === "POST" && pm) {
        const id = Number(pm[1]);
        if (pm[2] === "touch") logTouch(id, "note");
        else setStayInTouch(id, pm[2] === "stop" ? 0 : 1);
        reconcileActions();
        const msg = { touch: "Noted. The reminder clock starts again from today.", stop: "No more stay-in-touch reminders for them.", keep: "You'll be reminded to stay in touch." }[pm[2]]!;
        if (inline) return json(200, { ok: true, message: msg });
        return redirect(back(req.headers.referer, msg));
      }
      if (url.pathname === "/people") return htmlOut(peoplePage(url.searchParams));
      const cm = url.pathname.match(/^\/c\/(\d+)\/(scan|pause|resume|remove|interval)$/);
      if (req.method === "POST" && cm) {
        const id = Number(cm[1]);
        const c = getCompany(id);
        let note = "";
        if (!c) note = "That company isn't watched any more.";
        else if (cm[2] === "scan") { void hooks?.scanCompany?.(id, { report: true }).catch(() => {}); note = `Checking ${c.name}'s job board now. Refresh in a minute; matches arrive in Telegram.`; }
        else if (cm[2] === "pause") { setCompanyStatus(id, "paused"); note = `Paused ${c.name}.`; }
        else if (cm[2] === "resume") { setCompanyStatus(id, "active"); note = `Watching ${c.name} again.`; }
        else if (cm[2] === "remove") { removeCompany(id); note = `Stopped watching ${c.name}. Roles found there stay.`; }
        else if (cm[2] === "interval") {
          const h = Math.min(Math.max(Number((await body(req)).get("interval")) || 3, 1), 48);
          run("UPDATE companies SET interval_hours = $h WHERE id = $id", { h, id });
          note = `${c.name} is checked every ${h} h.`;
        }
        return redirect(`/companies${note ? `?note=${encodeURIComponent(note)}` : ""}`);
      }
      if (url.pathname === "/companies") return htmlOut(companiesPage(url.searchParams));
      if (req.method === "POST" && url.pathname === "/timers") {
        const form = await body(req);
        const values = Object.fromEntries((Object.keys(TIMER_SPECS) as TimerKey[]).filter((k) => form.has(k)).map((k) => [k, Number(form.get(k))]));
        setTimers(values);
        reconcileActions();
        return redirect(`/timers?flash=${encodeURIComponent("Timers saved. Due dates are updated.")}`);
      }
      if (req.method === "POST" && url.pathname === "/timers/reset") {
        resetTimers();
        reconcileActions();
        return redirect(`/timers?flash=${encodeURIComponent("Timers are back to their defaults.")}`);
      }
      if (url.pathname === "/timers") return htmlOut(timersPage(url.searchParams));
      if (req.method === "POST" && url.pathname === "/add") {
        const form = await body(req);
        const link = form.get("url");
        const backLink = form.get("back");
        if (link && hooks) {
          const result = await hooks.addLink(link, form.get("note") || undefined);
          if (result === NOT_A_POSTING) {
            return htmlOut(message("Not a single posting", "That link isn't a single job posting",
              `<p class="muted">If it's a job board or careers page, the tool can check it every few hours and send you the roles that fit.</p>
<p class="small muted" style="overflow-wrap:anywhere">${esc(link)}</p>
<div class="btn-row">${postButton("/sources", "Watch this page", { variant: "primary", hidden: { url: link, interval: "6" } })}${linkButton("/", "Back to Home", "quiet")}</div>`));
          }
          return htmlOut(message("Saved", esc(result),
            `<p class="muted">The pack (fit read, resume, cover note and people to contact) arrives in Telegram when it's ready, usually within a few minutes. It also appears under Roles.</p>
<div class="btn-row">${linkButton("/", "Back to Home", "primary")}${backLink ? linkButton(backLink, "Back to the job", "quiet") : ""}</div>`));
        }
        else if (link) run("INSERT INTO inbox_items (source, external_id, url, status) VALUES ('web', $u, $u, 'new') ON CONFLICT DO NOTHING", { u: link });
        return redirect(back("/", link ? "Link saved. It's processed when the daemon runs." : "Paste a link first."));
      }
      if (req.method === "GET" && url.pathname === "/add" && !url.searchParams.get("url")) {
        return htmlOut(message("Add a job link", "Add a job link",
          `<p class="muted">Paste a posting from LinkedIn, X or a careers page. The pack arrives in Telegram in a few minutes.</p>
<form method="post" action="/add" class="vstack section-stack"><div><label for="add-url" class="small muted">Job link</label>
<input id="add-url" type="url" name="url" required autofocus class="full" placeholder="https://"></div>
<div class="btn-row"><button class="btn primary">Make a pack</button>${linkButton("/", "Cancel", "quiet")}</div></form>`));
      }
      if (req.method === "GET" && url.pathname === "/add") {
        const link = url.searchParams.get("url") ?? "";
        return htmlOut(message("Save job", "Save this job?",
          `<p class="small muted" style="overflow-wrap:anywhere">${esc(link)}</p>
<form method="post" action="/add" class="stack" style="--gap:12px"><input type="hidden" name="url" value="${esc(link)}"><input type="hidden" name="back" value="${esc(link)}">
<div><label for="save-note" class="small muted" style="display:block;margin-bottom:6px">Note (optional)</label>
<input id="save-note" type="text" name="note" placeholder="e.g. founder posted this on X" style="width:100%" autofocus></div>
<div class="btn-row" style="margin-top:16px"><button class="btn primary">Save and build the pack</button>${linkButton(link || "/", "Cancel", "quiet")}</div></form>`));
      }
      if (url.pathname === "/") return htmlOut(home(url.searchParams));
      if (url.pathname === "/tasks") return htmlOut(tasksPage(url.searchParams));
      if (url.pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const hits = searchAll(q);
        if (url.searchParams.get("format") === "json") return json(200, { q, link: isLink(q), hits });
        return htmlOut(page("Search · Job hunt", searchPageBody(q, hits, icon), { tab: "" }));
      }
      if (url.pathname === "/interviews") return htmlOut(interviewsPage());
      const iv = url.pathname.match(/^\/interviews\/(\d+)$/);
      if (iv) return htmlOut(interviewPage(Number(iv[1])));
      if (url.pathname === "/insights") return htmlOut(insightsPage(url.searchParams));
      if (url.pathname === "/progress") return htmlOut(progressPage(url.searchParams));
      if (req.method === "POST" && url.pathname === "/insights/clear-drafts") {
        const n = clearStaleDrafts();
        const msg = n ? `${plural(n, "old draft")} removed.` : "No old drafts to remove.";
        if (inline) return json(200, { ok: true, message: msg, reload: true });
        return redirect(back(req.headers.referer, msg));
      }
      if (url.pathname === "/list") return htmlOut(list(url.searchParams));
      const o = url.pathname.match(/^\/o\/(\d+)$/);
      if (o) return htmlOut(detail(Number(o[1]), url.searchParams));
      const rs = url.pathname.match(/^\/resume\/(\d+)\/(edit|save|rebuild)$/);
      if (rs) {
        const id = Number(rs[1]);
        if (rs[2] === "edit") return htmlOut(resumeEditor(id, url.searchParams));
        if (req.method === "POST" && rs[2] === "rebuild") {
          if (!rewriting.has(id)) {
            rewriting.add(id);
            void rebuildResume(id).catch((err) => updateOpportunity(id, { pack_error: `The resume rewrite failed: ${String(err?.message ?? err)}` })).finally(() => rewriting.delete(id));
          }
          return redirect(`/resume/${id}/edit?flash=${encodeURIComponent("Writing the resume again. Reload in a few minutes.")}`);
        }
        if (req.method === "POST" && rs[2] === "save") {
          const found = loadResume(id);
          if (!found?.resume) return json(404, { ok: false, error: "This resume has no saved content to edit." });
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const edits = JSON.parse(raw) as Edits;
          if (!Array.isArray(edits) || !edits.every((e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string")) {
            return json(400, { ok: false, error: "That edit couldn't be read. Reload and try again." });
          }
          const next = applyEdits(found.resume, edits);
          const blanks = blanksIn(next);
          if (blanks.length) return json(400, { ok: false, error: `Still has blanks: ${blanks.join(", ")}. Fill them in or delete them.` });
          const out = await renderResumePdf(next, path.basename(found.o.resume_path!));
          const resumeErr = found.o.pack_error?.startsWith("Check these resume lines") || found.o.pack_error?.startsWith("The resume rewrite failed");
          updateOpportunity(id, { resume_path: out, ...(resumeErr ? { pack_error: null } : {}) }, { byUser: true });
          return json(200, { ok: true, message: "Saved. The PDF is updated." });
        }
      }
      const pdf = url.pathname.match(/^\/resume\/(\d+)$/);
      if (pdf) {
        const opp = get<{ resume_path: string | null }>("SELECT resume_path FROM opportunities WHERE id = $id", { id: Number(pdf[1]) });
        if (opp?.resume_path && existsSync(opp.resume_path)) {
          res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store", "content-disposition": `inline; filename="${opp.resume_path.split("/").pop()}"` });
          return res.end(readFileSync(opp.resume_path));
        }
      }
      htmlOut(null);
    } catch (err) {
      console.error(err);
      if (inline) return json(500, { ok: false, error: "That didn't save: " + String((err as Error)?.message ?? err) });
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(message("Something went wrong", "This page couldn't load",
        `<p class="muted">The dashboard hit an error. Your data is unchanged. Reload to try again; if it keeps happening, the message below helps with the fix.</p><pre>${esc(String((err as Error)?.stack ?? err))}</pre><p>${linkButton("/", "Back to Home", "primary")}</p>`));
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`Dashboard: http://127.0.0.1:${port}`));
  return server;
}

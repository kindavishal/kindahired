import { loadProfile, TIMEZONE } from "../config.ts";
import { followAccount, stopThread, unfollowAccount, xStatus } from "../pipeline/x.ts";
import { monthlyBudget, postIdFromUrl, spentThisMonth, xConfigured, xUserConnected } from "../sources/x.ts";
import { outreachForOpportunity } from "../db/contacts.ts";
import { all, get, kvGet, kvSet, logEvent, nowIso, run } from "../db/index.ts";
import { getOpportunity, PAST_DECISION, updateOpportunity, type Opportunity } from "../db/opportunities.ts";
import { completeAction, dueActions, reconcileActions, snoozeAction, stalledRoles, type ActionRow } from "../loops/engine.ts";
import { sheetRowFor } from "../import/mirror.ts";
import { describeResult, getSource, listSources, removeSource, setSourceStatus, type ScanResult, type Source } from "../pipeline/sources.ts";
import { bestContact, getBrief } from "../pipeline/hiring-brief.ts";
import { setStayInTouch } from "../pipeline/relationships.ts";
import { BOARD_LABEL, describeCompanyScan, getCompany, knownPeopleAt, listCompanies, removeCompany, setCompanyStatus, type Company, type CompanyScan } from "../pipeline/companies.ts";
import { ackButton, clearButtons, editMessage, html, send, sendDocument, type Button, type Incoming } from "./telegram.ts";

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
const VERDICT: Record<string, string> = { apply: "Good fit", stretch: "Stretch", skip: "Not a fit" };
const firstSentences = (t: string | null, n: number) => (t ?? "").match(/[^.!?]+[.!?]+/g)?.slice(0, n).join("").trim() ?? t ?? "";
const short = (t: string | null, max = 140) => (!t ? "" : t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t);

// ---------- Step 1: the summary card ----------

const STANDING: Record<string, string> = {
  applied: "Applied", interviewing: "Interviewing", offer: "Offer", rejected: "Closed", dropped: "Skipped by you",
};

/** The newest email about this role, from any thread, as one line. */
function latestUpdate(o: Opportunity): string | null {
  const t = get<{ subject: string | null; last_message_at: string | null; last_from: string | null }>(
    `SELECT subject, last_message_at, last_from FROM threads WHERE opportunity_id = $id AND last_message_at IS NOT NULL
     ORDER BY last_message_at DESC LIMIT 1`, { id: o.id },
  );
  if (!t?.last_message_at) return null;
  return `Latest: ${t.last_from === "me" ? "you wrote" : "email from them"}, ${fmtDate(t.last_message_at)}${t.subject ? ` (${html(short(t.subject, 90))})` : ""}`;
}

/** The one open action on this role, most urgent first. */
function nextAction(o: Opportunity): ActionRow | undefined {
  return get<ActionRow>(
    `SELECT * FROM actions WHERE opportunity_id = $id AND status = 'open' ORDER BY urgent DESC, due_at ASC LIMIT 1`, { id: o.id },
  );
}

/**
 * A role I've already acted on (applied, interviewing, dropped...) shows where it stands, newest
 * news first, and what to do next. No Build pack / Skip: that choice has been made.
 */
function standingText(o: Opportunity): string {
  const a = nextAction(o);
  const status = `<b>${STANDING[o.status] ?? o.status}</b>${o.status === "applied" && o.date_applied ? ` on ${fmtDate(o.date_applied)}` : ""}`
    + (o.status === "rejected" && o.skip_reason ? `: ${html(o.skip_reason)}` : "");
  return [
    `<b>${html(o.role)}</b> · ${html(o.company)}`,
    status,
    latestUpdate(o),
    hiringLine(o),
    a ? `Next: ${html(a.title)}${a.due_at > nowIso() ? ` (due ${fmtDate(a.due_at)})` : ""}` : o.status === "dropped" ? null : "Nothing to do right now.",
  ].filter(Boolean).join("\n");
}

/** The person to write to, from the who's-hiring research. */
function hiringLine(o: Opportunity): string | null {
  const p = bestContact(getBrief(o));
  const part: Record<string, string> = { hiring_manager: "hiring manager", recruiter: "recruiter", team_lead: "leads the team", job_poster: "posted it", founder: "founder", referrer: "could refer you", team_member: "on the team" };
  return p ? `Who's hiring: ${html(p.name)}${p.title ? `, ${html(p.title)}` : ""} (${part[p.part] ?? p.part}${p.confidence === "high" ? "" : ", likely"})` : null;
}

/** People I already know at this company, from other roles there: the warmest first touch. */
function warmLine(o: Opportunity): string | null {
  const people = knownPeopleAt(o.company).filter((p) => !all<{ n: number }>(
    "SELECT 1 AS n FROM outreach r JOIN contacts c ON c.id = r.contact_id WHERE r.opportunity_id = $o AND c.name = $name", { o: o.id, name: p.name },
  ).length);
  return people.length ? `You know: ${people.slice(0, 3).map((p) => `${html(p.name)} (${p.how})`).join(", ")}` : null;
}

/** One message per role: what it is, whether it fits, and a choice. Nothing more until I choose. */
export function cardText(o: Opportunity): string {
  if (PAST_DECISION.has(o.status)) return standingText(o);
  const facts = [short(o.who_can_apply, 120), o.pay && short(o.pay, 60), o.closes_on && `closes ${fmtDate(o.closes_on)}`].filter(Boolean).join(" · ");
  if (o.status === "skipped") {
    return [`<b>${html(o.role)}</b> · ${html(o.company)}`, `Skipped: ${html(o.skip_reason)}`, facts && html(facts)].filter(Boolean).join("\n");
  }
  return [
    `<b>${html(o.role)}</b> · ${html(o.company)}`,
    latestUpdate(o),
    `<b>${VERDICT[o.fit_verdict ?? ""] ?? "Not read yet"}</b>${o.gate_result === "ask" ? " · needs your call" : ""}`,
    facts && html(facts),
    o.hard_gate && o.hard_gate !== "None" && `Gate: ${html(short(o.hard_gate, 160))}`,
    hiringLine(o),
    warmLine(o),
    "",
    html(firstSentences(o.fit_read, 3)),
    o.fit_read && firstSentences(o.fit_read, 3) !== o.fit_read && `<blockquote expandable>${html(o.fit_read)}</blockquote>`,
  ].filter((l) => l !== null && l !== undefined && l !== false).join("\n").replace(/\n{3,}/g, "\n\n");
}

function cardButtons(o: Opportunity): Button[][] {
  const link = o.apply_url ?? o.source_url;
  const open = link ? [[{ text: "Open posting", url: link } as Button]] : [];
  if (o.status === "dropped") return [[{ text: "Undo skip", data: `o:build:${o.id}` }]];
  if (PAST_DECISION.has(o.status)) {
    const a = nextAction(o);
    return [...(a ? actionButtons(a) : []), ...open];
  }
  if (o.status === "skipped") return [[{ text: "Build anyway", data: `o:build:${o.id}` }], ...open];
  return [[{ text: "Build pack", data: `o:build:${o.id}` }, { text: "Skip", data: `o:drop:${o.id}` }], ...open];
}

export async function sendCard(opportunityId: number, opts: { silent?: boolean } = {}) {
  const o = getOpportunity(opportunityId);
  if (!o) return;
  const id = await send(cardText(o), cardButtons(o), opts);
  if (id) updateOpportunity(o.id, { card_message_id: id });
  logEvent("telegram.card", o.id);
}

/** Where a batch of matches came from, in words: "your email", "LinkedIn", a watched page's name. */
function originOf(opps: Opportunity[]): string {
  const names = [...new Set(opps.map((o) => o.source?.startsWith("watch:") ? o.source.slice(6) : o.source?.startsWith("company:") ? `${o.source.slice(8)}'s job board` : o.source?.startsWith("x:") ? "X" : o.source === "linkedin_saved" ? "LinkedIn" : "your email"))];
  return names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
}

/** New matches from email and watched pages arrive as one list, not one message each. */
export async function sendMatchList(ids: number[]) {
  // Only roles still waiting on my call: one I've applied to or skipped since is not a new match.
  const opps = ids.map((id) => getOpportunity(id)).filter((o): o is Opportunity => !!o && o.status !== "skipped" && !PAST_DECISION.has(o.status));
  if (!opps.length) return;
  if (opps.length === 1) return sendCard(opps[0].id);
  const shown = opps.slice(0, 8);
  const lines = shown.map((o, i) => `${i + 1}. <b>${html(o.role)}</b> · ${html(o.company)}\n    ${VERDICT[o.fit_verdict ?? ""] ?? ""}${o.closes_on ? ` · closes ${fmtDate(o.closes_on)}` : ""}`);
  await send(
    [`<b>${opps.length} new matches from ${html(originOf(opps))}</b>`, ...lines, opps.length > shown.length ? `…and ${opps.length - shown.length} more on the dashboard.` : "", "Tap one to see the summary."].filter(Boolean).join("\n"),
    shown.map((o, i) => [{ text: `${i + 1}. ${o.role}`.slice(0, 60), data: `o:card:${o.id}` }]),
  );
  logEvent("telegram.matches", null, { count: opps.length });
}

// ---------- Step 2: the pack, after I tap Build ----------

const FILL = /\[FILL IN[^\]]*\]/gi;

function applicationText(o: Opportunity): { text: string; questions: string[] } {
  const questions = [...`${o.cover_note ?? ""}\n${o.form_answers ?? ""}`.matchAll(FILL)].map((m) => m[0].replace(/^\[FILL IN:?\s*|\]$/gi, "") || "Your answer");
  const text = [
    `<b>Application</b> · ${html(o.company)}`,
    o.cover_note && `<b>Cover note</b> (tap to expand)\n<blockquote expandable>${html(o.cover_note)}</blockquote>`,
    o.form_answers && `<b>Form answers</b>\n<blockquote expandable>${html(o.form_answers)}</blockquote>`,
    questions.length
      ? `<b>${questions.length === 1 ? "One thing" : `${questions.length} things`} only you know</b>\n${questions.map((q, i) => `${i + 1}. ${html(q)}`).join("\n")}\n\nReply to this message with your answers, one per line, and I'll fill them in.`
      : null,
  ].filter(Boolean).join("\n\n");
  return { text, questions };
}

function peopleText(o: Opportunity) {
  const people = outreachForOpportunity(o.id).filter((r) => r.status === "drafted");
  if (!people.length) return null;
  const blocks = people.map((r, i) => {
    const contact = get<{ notes: string | null }>("SELECT notes FROM contacts WHERE id = $id", { id: r.contact_id });
    const link = r.linkedin_url ?? contact?.notes?.match(/https?:\/\/\S+/)?.[0] ?? null;
    return [
      `${i + 1}. <b>${html(r.name)}</b> · ${html(short(r.title, 80))}${r.degree ? ` · ${html(r.degree)}` : ""}`,
      link ? `${r.linkedin_url ? "" : "Profile search: "}${html(link)}` : null,
      r.hook_source && `Hook: ${html(short(r.hook_source, 140))}`,
      r.send_time && `Send: ${html(r.send_time)}`,
      r.connection_note && `<pre>${html(r.connection_note)}</pre>`,
      r.full_dm && `After they accept:\n<blockquote expandable>${html(r.full_dm)}</blockquote>`,
    ].filter(Boolean).join("\n");
  });
  const buttons: Button[][] = people.map((r, i) => [
    { text: `${i + 1}. Note sent`, data: `r:note_sent:${r.id}` },
    { text: `${i + 1}. DM sent`, data: `r:dm_sent:${r.id}` },
    { text: `${i + 1}. Skip`, data: `r:skipped:${r.id}` },
  ]);
  return { text: [`<b>People to contact</b> · ${html(o.company)}`, ...blocks].join("\n\n"), buttons };
}

/** The pack in three messages: resume, application, people. */
export async function sendPack(opportunityId: number) {
  const o = getOpportunity(opportunityId);
  if (!o) return;
  if (o.pack_status !== "ready" || !o.resume_path) return sendCard(o.id);
  const row = sheetRowFor("role", o.id);
  const caption = [
    `<b>${html(o.role)}</b> · ${html(o.company)}`,
    o.apply_url && `Apply: ${html(o.apply_url)}`,
    o.check_notes && `Double-check: ${html(short(o.check_notes.replace(/\n/g, "; "), 300))}`,
    o.pack_error && html(short(o.pack_error, 300)),
    row && `Tracker: Roles row ${row}`,
  ].filter(Boolean).join("\n");
  await sendDocument(o.resume_path, caption, [
    [{ text: "Applied", data: `o:applied:${o.id}` }, { text: "Drop", data: `o:drop:${o.id}` }],
    ...(o.apply_url ? [[{ text: "Open application", url: o.apply_url } as Button]] : []),
  ]);
  const app = applicationText(o);
  const appId = await send(app.text, undefined, app.questions.length ? { forceReply: "One answer per line" } : {});
  if (appId && app.questions.length) kvSet(`fill:${appId}`, String(o.id));
  const people = peopleText(o);
  if (people) await send(people.text, people.buttons);
  if (o.card_message_id) await editMessage(o.card_message_id, `${cardText(o)}\n\n<i>Pack sent below.</i>`);
  logEvent("telegram.pack", o.id);
}

/** Puts my typed answers into the [FILL IN] spots, in order, and sends the finished application. */
export async function fillIn(opportunityId: number, reply: string) {
  const o = getOpportunity(opportunityId);
  if (!o) return;
  const answers = reply.split("\n").map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
  let n = 0;
  const fill = (t: string | null) => t?.replace(FILL, (m) => (n < answers.length ? answers[n++] : m)) ?? null;
  const cover = fill(o.cover_note);
  const form = fill(o.form_answers);
  updateOpportunity(o.id, { cover_note: cover, form_answers: form });
  const app = applicationText(getOpportunity(o.id)!);
  const id = await send(app.text, undefined, app.questions.length ? { forceReply: "One answer per line" } : {});
  if (id && app.questions.length) kvSet(`fill:${id}`, String(o.id));
  logEvent("telegram.fill_in", o.id, { filled: n });
}

// ---------- Daily digest ----------

function actionLine(a: ActionRow): string {
  return `${a.urgent ? "<b>!</b> " : ""}${html(a.title)}`;
}

export function digestText(now = new Date()): { text: string; top: ActionRow[] } {
  const due = dueActions(now);
  const by = (kinds: string[]) => due.filter((a) => kinds.includes(a.kind));
  const interviews = all<ActionRow>(
    "SELECT * FROM actions WHERE status = 'open' AND kind = 'interview' AND due_at <= $soon ORDER BY due_at",
    { soon: new Date(now.getTime() + 3 * 86400_000).toISOString() },
  );
  const replies = by(["reply"]);
  const apply = by(["apply"]);
  const follow = by(["follow_up"]);
  const send_ = by(["send_note", "send_dm"]);
  const decide = by(["decide"]);
  const stalled = stalledRoles();
  const savedNotApplied = all<{ company: string; role: string; created_at: string }>(
    `SELECT company, role, created_at FROM opportunities WHERE saved_on_linkedin = 1 AND status IN ('found','decide','ready') ORDER BY created_at LIMIT 5`,
  );
  const savedCount = get<{ n: number }>(`SELECT count(*) n FROM opportunities WHERE saved_on_linkedin = 1 AND status IN ('found','decide','ready')`)!.n;
  const newSince = get<{ n: number }>(`SELECT count(*) n FROM opportunities WHERE pack_ready_at >= $since AND status IN ('ready','decide')`, {
    since: new Date(now.getTime() - 24 * 3600_000).toISOString(),
  })!.n;

  const section = (title: string, items: ActionRow[], max = 6) =>
    items.length ? `<b>${title} (${items.length})</b>\n${items.slice(0, max).map(actionLine).join("\n")}${items.length > max ? `\n…and ${items.length - max} more` : ""}` : null;

  const text = [
    `<b>Today</b> · ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: TIMEZONE })}`,
    newSince ? `${newSince} new pack${newSince > 1 ? "s" : ""} ready since yesterday.` : null,
    section("Interviews in the next few days", interviews),
    section("Replies you owe", replies),
    section("Apply", apply),
    section("Follow up", follow),
    section("Send outreach", send_),
    section("Decide", decide),
    stalled.length ? `<b>No next step (${stalled.length})</b>\n${stalled.slice(0, 5).map((r) => `${html(r.role)} at ${html(r.company)}`).join("\n")}\nYou dropped their reminders but the roles are still open. Bring a reminder back or close the role on the dashboard.` : null,
    savedCount ? `<b>Saved on LinkedIn, not applied (${savedCount})</b>\n${savedNotApplied.map((s) => `${html(s.role)} at ${html(s.company)}`).join("\n")}` : null,
    due.length ? "Tap a button below to act, or send /today any time." : "Nothing due. Nice.",
  ].filter(Boolean).join("\n\n");

  const top = [...interviews, ...replies, ...apply, ...follow, ...send_, ...decide].slice(0, 5);
  return { text, top };
}

export async function sendDigest(now = new Date()) {
  reconcileActions(now);
  const { text, top } = digestText(now);
  await send(text, top.map((a) => [
    { text: a.title.slice(0, 40), data: `a:open:${a.id}` },
  ]));
  logEvent("telegram.digest", null);
}

/** Instant pings for urgent loops I haven't been told about yet (mostly replies I owe). */
export async function sendUrgentPings(now = new Date()) {
  // Only replies that arrived in the last two days ping me. Older ones (found by the email
  // backfill, say) go in the digest instead of arriving as a burst.
  const since = new Date(now.getTime() - 48 * 3600_000).toISOString();
  run(
    `UPDATE actions SET notified_at = $now WHERE status = 'open' AND notified_at IS NULL AND kind = 'reply'
       AND due_at < $cutoff`,
    { now: now.toISOString(), cutoff: new Date(new Date(since).getTime() + 12 * 3600_000).toISOString() },
  );
  const urgent = all<ActionRow>(
    `SELECT * FROM actions WHERE status = 'open' AND notified_at IS NULL AND kind = 'reply'
       AND (snoozed_until IS NULL OR snoozed_until <= $now) LIMIT 3`,
    { now: now.toISOString() },
  );
  for (const a of urgent) {
    await send(`<b>Reply needed</b>\n${html(a.title)}\n\n${html(a.detail)}`, actionButtons(a));
    run("UPDATE actions SET notified_at = $now WHERE id = $id", { now: nowIso(), id: a.id });
  }
}

function actionButtons(a: ActionRow): Button[][] {
  const rows: Button[][] = [[
    { text: a.kind === "reply" ? "Replied" : "Done", data: `a:done:${a.id}` },
    { text: "Snooze 1 day", data: `a:snooze:${a.id}` },
    { text: "Drop", data: `a:drop:${a.id}` },
  ]];
  // A stay-in-touch reminder can be turned off for that person.
  const person = a.rule_key?.match(/^loop:touch:(\d+):/);
  if (person) rows.push([{ text: "Stop reminders for them", data: `p:stop:${person[1]}` }]);
  // A role on the follow-up ladder can be closed from the reminder itself.
  if (a.opportunity_id && a.rule_key?.startsWith("loop:ladder:")) {
    rows.push([{ text: "Close it: draft a closing note", data: `o:closenote:${a.opportunity_id}` }]);
  }
  if (a.outreach_id && a.kind !== "reply") {
    rows.push([
      { text: "Note sent", data: `r:note_sent:${a.outreach_id}` },
      { text: "DM sent", data: `r:dm_sent:${a.outreach_id}` },
      { text: "They replied", data: `r:replied:${a.outreach_id}` },
    ]);
  }
  return rows;
}

// ---------- Closing a role that went quiet ----------

/**
 * Where the conversation lives and a short closing note for it. A role is only closed after I've
 * sent this myself (the tool never sends), so the other side isn't left wondering either.
 */
export function closingNote(o: Opportunity): { text: string; where: string; threadUrl: string | null } {
  const me = loadProfile().name.split(/\s+/)[0];
  // The real conversation, not a calendar invite or an automated confirmation.
  const t = get<{ external_id: string; subject: string | null; last_message_at: string | null; name: string | null; email: string | null; noreply: number }>(
    `SELECT t.external_id, t.subject, t.last_message_at, c.name, c.email,
       NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.from_me = 0
         AND lower(coalesce(m.sender, '')) NOT GLOB '*no-reply*' AND lower(coalesce(m.sender, '')) NOT GLOB '*noreply*'
         AND lower(coalesce(m.sender, '')) NOT GLOB '*calendar*') AS noreply
     FROM threads t LEFT JOIN contacts c ON c.id = t.contact_id
     WHERE t.opportunity_id = $id AND t.channel = 'email' AND t.last_message_at IS NOT NULL
     ORDER BY noreply ASC, (lower(coalesce(t.subject, '')) GLOB '*invitation*') ASC, (c.id IS NOT NULL) DESC,
       (t.kind = 'conversation') DESC, t.last_message_at DESC LIMIT 1`, { id: o.id },
  );
  const r = get<{ name: string; linkedin_url: string | null; status: string }>(
    `SELECT c.name, c.linkedin_url, r.status FROM outreach r JOIN contacts c ON c.id = r.contact_id
     WHERE r.opportunity_id = $id AND r.status IN ('note_sent', 'dm_sent', 'conversation', 'replied') ORDER BY coalesce(r.replied_at, r.sent_at) DESC LIMIT 1`,
    { id: o.id },
  );
  const who = t?.name ?? r?.name ?? null;
  const first = who?.split(/\s+/)[0];
  const since = t?.last_message_at ? ` since ${fmtDate(t.last_message_at)}` : "";
  const text = [
    `Hi ${first ?? "there"},`,
    "",
    `I wanted to close the loop on the ${o.role} role. I haven't heard back${since}, so I'm guessing you've gone ahead with someone else, and that's completely fine.`,
    "",
    `Thanks for the time you spent on my application. If something opens up later that fits, I'd be glad to talk again.`,
    "",
    me,
  ].join("\n");
  const where = t?.noreply
    ? r
      ? `Their only emails came from a no-reply address, so send it to ${r.name} on LinkedIn${r.linkedin_url ? `: ${r.linkedin_url}` : ""}.`
      : "Their only emails came from a no-reply address, so a reply won't reach anyone. Send it to the recruiter or hiring manager on LinkedIn, or through the application portal if it has messages."
    : t
    ? `Reply in the email thread "${short(t.subject, 80)}"${who ? ` with ${who}` : ""}${t.email ? ` (${t.email})` : ""}.`
    : r
      ? `Send it to ${r.name} on LinkedIn${r.linkedin_url ? `: ${r.linkedin_url}` : ""}.`
      : "No email thread or contact on file. Send it wherever you applied or spoke to them.";
  return { text, where, threadUrl: t && !t.noreply ? `https://mail.google.com/mail/u/0/#all/${t.external_id}` : null };
}

// ---------- X ----------

export async function sendXStatus() {
  if (!xConfigured()) return send("X isn't connected yet. See the README, X setup.", undefined, { silent: true });
  const st = xStatus();
  const threads = st.threads.map((t) => `· ${html(t.label ?? "thread")} until ${fmtDate(t.watch_until)}`);
  const buttons: Button[][] = st.threads.slice(0, 8).map((t) => [{ text: `Stop ${t.label ?? "thread"}`.slice(0, 40), data: `x:stop:${t.conversation_id}` }]);
  await send([
    `<b>X</b> · $${spentThisMonth().toFixed(2)} of $${monthlyBudget()} used this month`
      + (kvGet("x.noCredits") ? "\nPaused: the X developer account has no credits. Top up at console.x.com (Billing)." : ""),
    `<b>Searches</b> (${st.queries.length}): your target roles plus hiring words`,
    `<b>Accounts watched</b> (${st.accounts.length}): ${st.accounts.length ? st.accounts.map((a) => "@" + html(a)).join(", ") : "none yet. Add one with /xfollow @handle"}`,
    `<b>Threads watched</b> (${st.threads.length})${threads.length ? "\n" + threads.join("\n") : ""}`,
    xUserConnected() ? "Bookmarks: synced" : "Bookmarks: not connected (run auth:x)",
  ].join("\n\n"), buttons, { silent: true });
}

// ---------- Handling what I send back ----------

// ---------- Watched pages ----------

/** What addLink says when a link isn't a single posting. The bot then offers to watch the page. */
export const NOT_A_POSTING = "That link doesn't look like a job posting. If it's a post that needs a login, paste its text along with the link.";

const ago = (iso: string | null) => {
  if (!iso) return "not scanned yet";
  const h = (Date.now() - new Date(iso).getTime()) / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

export function sourceLine(src: Source): string {
  const last = src.last_result ? describeResult(JSON.parse(src.last_result) as ScanResult) : null;
  return [
    `<b>${html(src.label)}</b>${src.status === "paused" ? " · paused" : ""}`,
    `every ${src.interval_hours} h · last scan ${ago(src.last_scanned_at)}${last ? `: ${last}` : ""}`,
    src.last_error && `⚠ ${html(src.last_error)}`,
  ].filter(Boolean).join("\n");
}

export async function sendSources() {
  const sources = listSources();
  if (!sources.length) {
    await send("You're not watching any pages yet. Send <code>/watch https://…</code> with a job board, careers page or feed, and I'll check it every few hours for roles that fit.", undefined, { silent: true });
    return;
  }
  await send(
    [`<b>Watched pages (${sources.length})</b>`, ...sources.map(sourceLine), "Add another with <code>/watch https://…</code>"].join("\n\n"),
    sources.map((src) => [
      { text: `Scan ${src.label}`.slice(0, 40), data: `s:scan:${src.id}` },
      src.status === "paused" ? { text: "Resume", data: `s:resume:${src.id}` } : { text: "Pause", data: `s:pause:${src.id}` },
      { text: "Remove", data: `s:remove:${src.id}` },
    ]),
    { silent: true },
  );
}

export interface Hooks {
  addLink: (url: string, note?: string) => Promise<string>;
  watchPage: (url: string, opts: { label?: string; intervalHours?: number; via: string }) => Promise<{ text: string; id?: number }>;
  scanNow: (id: number, opts?: { report?: boolean; force?: boolean }) => Promise<unknown>;
  /** Wake the workers so a new card or pack starts now, not on the next timer. */
  kick: () => void;
  /** Read an X post and its replies, and keep watching the thread. */
  readXLink?: (url: string) => Promise<{ text: string; conversationId?: string }>;
  /** Add target companies from "Name" or "Name | link" lines. */
  addCompanies?: (text: string, via: string) => Promise<{ lines: string[]; ids: number[] }>;
  /** Read one target company's job board now. */
  scanCompany?: (id: number, opts?: { report?: boolean }) => Promise<unknown>;
}

// ---------- Target companies ----------

function companyLine(c: Company): string {
  const last = c.last_result ? describeCompanyScan(JSON.parse(c.last_result) as CompanyScan) : null;
  const where = c.board_type ? `${BOARD_LABEL[c.board_type]} · every ${c.interval_hours} h · last check ${ago(c.last_scanned_at)}${last ? `: ${last}` : ""}`
    : c.source_id ? "careers page, watched under /sources" : "no job board found yet";
  return [`<b>${html(c.name)}</b>${c.needs_check ? " · board guessed, check it on the dashboard" : c.status === "paused" ? " · paused" : ""}`, where, c.last_error && `⚠ ${html(c.last_error)}`].filter(Boolean).join("\n");
}

const companyButtons = (list: Company[]): Button[][] => list.filter((c) => c.board_type).slice(0, 20).map((c) => [
  { text: `Check ${c.name}`.slice(0, 40), data: `c:scan:${c.id}` },
  c.status === "paused" ? { text: "Resume", data: `c:resume:${c.id}` } : { text: "Pause", data: `c:pause:${c.id}` },
  { text: "Remove", data: `c:remove:${c.id}` },
]);

export async function sendCompanies(messageId?: number) {
  const list = listCompanies();
  const text = list.length
    ? [`<b>Target companies (${list.length})</b>`, ...list.map(companyLine), "Add more with <code>/company Name</code>, one per line, with a careers link if you have one."].join("\n\n")
    : "No target companies yet. Send <code>/company Stripe</code>, or several on separate lines, and I'll watch their job boards and send new roles that fit within a few hours of posting.";
  if (messageId) await editMessage(messageId, text, companyButtons(list));
  else await send(text, companyButtons(list), { silent: true });
}

export async function handleIncoming(msg: Incoming, hooks: Hooks) {
  if (msg.kind === "button") {
    const [scope, verb, idText] = msg.text.split(":");
    const id = Number(idText);
    let reply = "Done";
    if (scope === "a") {
      const a = get<ActionRow>("SELECT * FROM actions WHERE id = $id", { id });
      if (!a) reply = "Not found";
      else if (verb === "open") {
        const o = a.opportunity_id ? getOpportunity(a.opportunity_id) : undefined;
        if (o && ["apply", "decide"].includes(a.kind)) {
          if (o.pack_status === "ready" && o.resume_path) await sendPack(o.id);
          else await sendCard(o.id);
        } else {
          await send(`<b>${html(a.title)}</b>\n\n${html(a.detail)}`, actionButtons(a));
        }
        reply = "Opened";
      } else if (verb === "done") {
        completeAction(id, "done");
        if (a.kind === "reply") reply = "Marked replied. I'll remind you to follow up if they go quiet.";
      } else if (verb === "drop") completeAction(id, "dropped");
      else if (verb === "snooze") { snoozeAction(id, 24); reply = "Snoozed for a day"; }
    } else if (scope === "o") {
      const o = getOpportunity(id);
      if (!o) reply = "Not found";
      else if (verb === "card") { await sendCard(id); reply = "Summary"; }
      else if (verb === "build") {
        if (o.pack_status === "ready" && o.resume_path) { await sendPack(id); reply = "Here's the pack"; }
        else {
          // Only a skip is undone; any other status is left for automation to move forward
          // (locking it here is what kept a later "applied" email from registering).
          updateOpportunity(id, { pack_status: "approved" });
          if (o.status === "skipped" || o.status === "dropped") updateOpportunity(id, { status: "found" }, { byUser: true });
          if (msg.messageId) await editMessage(msg.messageId, `${cardText(getOpportunity(id)!)}\n\n<i>Building the pack: resume, application and people. Usually 2 to 4 minutes.</i>`);
          hooks.kick();
          reply = "Building the pack";
        }
      } else if (verb === "closenote") {
        const note = closingNote(o);
        await send(
          [`<b>Closing note</b> · ${html(o.role)} at ${html(o.company)}`, html(note.where), `<pre>${html(note.text)}</pre>`,
            "Send it yourself, then tap <b>Sent, close it</b>. Until then the role stays open."].join("\n\n"),
          [[{ text: "Sent, close it", data: `o:close:${id}` }, { text: "Keep it open", data: `o:keepopen:${id}` }],
            ...(note.threadUrl ? [[{ text: "Open the email thread", url: note.threadUrl } as Button]] : [])],
        );
        reply = "Closing note drafted";
      } else if (verb === "keepopen") {
        if (msg.messageId) await clearButtons(msg.messageId);
        reply = "Kept open";
      } else if (verb === "close") {
        updateOpportunity(id, { status: "rejected", skip_reason: "No response; closing note sent" }, { byUser: true });
        run("UPDATE threads SET status = 'closed', closed_reason = 'No response' WHERE opportunity_id = $id AND status = 'open'", { id });
        if (msg.messageId) await clearButtons(msg.messageId);
        await send(`<s>${html(o.role)} · ${html(o.company)}</s>\nClosed: no response, closing note sent.`, undefined, { silent: true });
        reply = "Closed";
      } else if (verb === "applied") {
        updateOpportunity(id, { status: "applied", date_applied: nowIso().slice(0, 10) }, { byUser: true });
        reply = "Marked applied. I'll remind you to follow up.";
      } else if (verb === "drop") {
        updateOpportunity(id, { status: "dropped" }, { byUser: true });
        // A pack queued or mid-build stops here, so no second Build / Skip card follows.
        if (["queued", "approved"].includes(o.pack_status)) updateOpportunity(id, { pack_status: o.resume_path ? "ready" : "none" });
        const skippedText = `<s>${html(o.role)} · ${html(o.company)}</s>\nSkipped.`;
        if (o.card_message_id) await editMessage(o.card_message_id, skippedText, [[{ text: "Undo skip", data: `o:build:${o.id}` }]]);
        if (msg.messageId && msg.messageId !== o.card_message_id) await clearButtons(msg.messageId);
        reply = "Skipped";
      }
    } else if (scope === "s") {
      const src = getSource(id);
      if (verb === "list") { await sendSources(); reply = "Watched pages"; }
      else if (!src) reply = "Not watching that page any more";
      else if (verb === "scan") {
        void hooks.scanNow(id, { report: true, force: true }).catch(() => {});
        reply = `Scanning ${src.label}`;
      } else if (verb === "pause") { setSourceStatus(id, "paused"); reply = `Paused ${src.label}`; }
      else if (verb === "resume") { setSourceStatus(id, "active"); reply = `Watching ${src.label} again`; }
      else if (verb === "remove") {
        removeSource(id);
        reply = `Stopped watching ${src.label}. Roles found there stay.`;
      }
      if (msg.messageId && src && ["pause", "resume", "remove"].includes(verb)) {
        const left = listSources();
        if (left.length) await editMessage(msg.messageId, [`<b>Watched pages (${left.length})</b>`, ...left.map(sourceLine)].join("\n\n"), left.map((x) => [
          { text: `Scan ${x.label}`.slice(0, 40), data: `s:scan:${x.id}` },
          x.status === "paused" ? { text: "Resume", data: `s:resume:${x.id}` } : { text: "Pause", data: `s:pause:${x.id}` },
          { text: "Remove", data: `s:remove:${x.id}` },
        ]));
        else await editMessage(msg.messageId, "Not watching any pages now.");
      }
    } else if (scope === "p" && verb === "stop") {
      setStayInTouch(id, 0);
      if (msg.messageId) await clearButtons(msg.messageId);
      reply = "No more stay-in-touch reminders for them";
    } else if (scope === "c" && verb === "list") {
      await sendCompanies();
      reply = "Target companies";
    } else if (scope === "c") {
      const c = getCompany(id);
      if (!c) reply = "Not watching that company any more";
      else if (verb === "scan") {
        void hooks.scanCompany?.(id, { report: true }).catch(() => {});
        reply = `Checking ${c.name}`;
      } else if (verb === "pause") { setCompanyStatus(id, "paused"); reply = `Paused ${c.name}`; }
      else if (verb === "resume") { setCompanyStatus(id, "active"); reply = `Watching ${c.name} again`; }
      else if (verb === "remove") { removeCompany(id); reply = `Stopped watching ${c.name}. Roles found there stay.`; }
      if (msg.messageId && c && ["pause", "resume", "remove"].includes(verb)) await sendCompanies(msg.messageId);
    } else if (scope === "x" && verb === "stop") {
      stopThread(idText);
      if (msg.messageId) await clearButtons(msg.messageId);
      reply = "Stopped watching that thread";
    } else if (scope === "w" && verb === "offer") {
      // "Watch this page" on a link that wasn't a single posting.
      const url = kvGet(`watchoffer:${id}`);
      if (!url) reply = "That offer expired; send /watch with the link";
      else {
        const r = await hooks.watchPage(url, { via: "telegram" });
        if (msg.messageId) await editMessage(msg.messageId, html(r.text));
        reply = "Watching";
      }
    } else if (scope === "r") {
      run(`UPDATE outreach SET status = $s,
             sent_at = CASE WHEN $s IN ('note_sent','dm_sent') THEN $now ELSE sent_at END,
             replied_at = CASE WHEN $s = 'replied' THEN $now ELSE replied_at END WHERE id = $id`, {
        s: verb, now: nowIso(), id,
      });
      reply = verb === "skipped" ? "Skipped" : verb === "replied" ? "Noted. Reply is now on your list." : "Marked sent. I'll remind you to follow up.";
    }
    reconcileActions();
    if (msg.callbackId) await ackButton(msg.callbackId, reply);
    logEvent("telegram.button", msg.text);
    return;
  }

  const text = msg.text.trim();
  // A reply to an application message fills in its blanks.
  const fillFor = msg.replyTo ? kvGet(`fill:${msg.replyTo}`) : undefined;
  if (fillFor) return fillIn(Number(fillFor), text);

  if (text === "/today" || text === "/start") return sendDigest();
  if (/^\/sources\b/.test(text)) return sendSources();
  if (/^\/companies\b/.test(text)) return sendCompanies();
  const company = text.match(/^\/company(?:@\w+)?\s*([\s\S]*)$/);
  if (company) {
    if (!company[1].trim() || !hooks.addCompanies) {
      await send("Send <code>/company Stripe</code> to watch a company's job board. Add several on separate lines, and a careers link after a | if you have one: <code>Packt | https://apply.workable.com/packtpublishing</code>", undefined, { silent: true });
      return;
    }
    await send("Finding their job boards…", undefined, { silent: true, replyTo: msg.messageId });
    const r = await hooks.addCompanies(company[1], "telegram");
    await send(r.lines.map(html).join("\n") || "Nothing to add.", [[{ text: "All target companies", data: "c:list:0" }]], { silent: true });
    return;
  }
  const watch = text.match(/^\/watch(?:@\w+)?\s*(\S+)?\s*(.*)$/s);
  if (watch) {
    if (!watch[1]) {
      await send("Send <code>/watch https://…</code> with a job board, careers page or feed (and an optional name after the link). I'll check it every few hours and send roles that fit.", undefined, { silent: true });
      return;
    }
    const r = await hooks.watchPage(watch[1], { label: watch[2].trim() || undefined, via: "telegram" });
    await send(html(r.text), r.id ? [[{ text: "All watched pages", data: `s:list:${r.id}` }]] : undefined, { silent: true, replyTo: msg.messageId });
    return;
  }
  if (/^\/x(@\w+)?$/.test(text)) return sendXStatus();
  const follow = text.match(/^\/x(un)?follow(?:@\w+)?\s+(\S+)/);
  if (follow) {
    try {
      if (follow[1]) { unfollowAccount(follow[2]); await send(`Stopped watching @${html(follow[2].replace(/^@/, ""))} on X.`, undefined, { silent: true }); }
      else { const u = followAccount(follow[2]); await send(`Watching @${html(u)}'s posts on X for roles. They're checked every few hours.`, undefined, { silent: true }); }
    } catch (err) { await send(html(String(err instanceof Error ? err.message : err)), undefined, { silent: true }); }
    return;
  }
  const url = text.match(/https?:\/\/\S+/)?.[0];
  // An X post, when the X API is set up: read it and its replies, then keep watching the thread.
  if (url && hooks.readXLink && xConfigured() && postIdFromUrl(url)) {
    await send("Reading the post and its replies…", undefined, { silent: true, replyTo: msg.messageId });
    try {
      const r = await hooks.readXLink(url);
      await send(html(r.text), r.conversationId ? [[{ text: "Stop watching this thread", data: `x:stop:${r.conversationId}` }]] : undefined, { silent: true });
    } catch (err) {
      await send(`Couldn't read that post: ${html(String(err instanceof Error ? err.message : err).split("\n")[0])}`, undefined, { silent: true });
    }
    return;
  }
  if (url) {
    await send("Got it. Reading the posting…", undefined, { silent: true, replyTo: msg.messageId });
    const result = await hooks.addLink(url, text.replace(url, "").trim() || undefined);
    if (result === NOT_A_POSTING && !/linkedin\.com|x\.com|twitter\.com/i.test(url)) {
      // Probably a board or careers page: offer to keep an eye on it instead.
      const n = Number(kvGet("watchoffer.next") ?? 1);
      kvSet("watchoffer.next", String(n + 1));
      kvSet(`watchoffer:${n}`, url);
      await send("That isn't a single posting. If it's a job board or careers page, I can check it every few hours and send you the roles that fit.",
        [[{ text: "Watch this page", data: `w:offer:${n}` }]], { silent: true });
    } else if (result) await send(html(result), undefined, { silent: true });
    hooks.kick();
    return;
  }
  await send("Send me a job link and I'll check it, <code>/company</code> a company to watch its job board, <code>/watch</code> a page, /companies or /sources for what's watched, or /today for what needs you.", undefined, { silent: true });
}

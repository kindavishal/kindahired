import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { AI_MODE } from "./llm/client.ts";
import { geminiAvailable, PlanUnavailableError } from "./llm/providers.ts";
import { loadProfile, localClock, PATHS } from "./config.ts";
import { all, get, kvGet, kvSet, logEvent, run } from "./db/index.ts";
import { getOpportunity, PAST_DECISION, updateOpportunity } from "./db/opportunities.ts";
import { reconcileActions } from "./loops/engine.ts";
import { NOT_A_POSTING, sendCard, sendDigest, sendMatchList, sendPack, sendUrgentPings } from "./notify/messages.ts";
import { html, send, telegramReady } from "./notify/telegram.ts";
import { addFromLink, syncGmail, syncLinkedIn } from "./pipeline/ingest.ts";
import { buildFullPack, buildSummary } from "./pipeline/pack.ts";
import { addSource, describeResult, dueSources, getSource, scanSource, type ScanResult } from "./pipeline/sources.ts";
import { syncSheet } from "./import/mirror.ts";
import { googleConnected } from "./sources/google-auth.ts";
import { readThreadLink, scanX } from "./pipeline/x.ts";
import { monthlyBudget, spentThisMonth, xConfigured } from "./sources/x.ts";
import { LinkedInUnavailable } from "./sources/linkedin.ts";
import { checkPostings, type CheckSummary } from "./pipeline/liveness.ts";
import { syncLinkedInMessages } from "./pipeline/dms.ts";
import { researchHiring, rolesNeedingResearch } from "./pipeline/hiring.ts";
import { calendarReady, syncCalendar } from "./pipeline/interviews.ts";
import { addCompany, autoAddCompanies, BOARD_LABEL, describeCompanyScan, dueCompanies, getCompany, parseCompanyLines, scanCompany, type CompanyScan } from "./pipeline/companies.ts";

/** The units of work the daemon schedules. Each one is safe to run again. */

/** Errors that will fail every AI call until I fix my account (credit, key, permissions). */
export function isAccountError(err: unknown): boolean {
  return err instanceof PlanUnavailableError || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
    || (err instanceof Anthropic.BadRequestError && /credit balance|billing/i.test(err.message));
}

/** One Telegram notice per 12 hours about an account problem, instead of one per failed call. */
export async function warnAccountOnce(err: unknown) {
  const last = kvGet("ai.warnedAt");
  if (last && Date.now() - new Date(last).getTime() < 12 * 3600_000) return;
  kvSet("ai.warnedAt", new Date().toISOString());
  const text = String(err);
  const reason = err instanceof PlanUnavailableError
    ? (/limit/i.test(text) ? "your Claude plan hit its usage limit for now" : `Claude Code isn't available (${text.slice(0, 120)})`)
    : /credit balance/i.test(text) ? "the Anthropic account is out of credit" : "the Anthropic API key was rejected";
  await send(`Paused: ${reason}. Nothing is lost; queued work resumes once it's fixed.`, undefined, { silent: true }).catch(() => {});
}

/**
 * Two workers, so a quick summary never waits behind a full pack:
 * - summaries: new roles get the posting check and fit read, then a card (or, for email, one list)
 * - packs: roles I approved get the resume, application and people
 */
let summariesRunning = false;
let packsRunning = false;

const PAST = [...PAST_DECISION].map((s) => `'${s}'`).join(", ");

/**
 * A role I've already applied to, or dropped, needs no summary or pack: whatever queued it (an
 * application email that also listed the role, an old tap) is stood down here.
 */
export function standDownPastDecisions(): number {
  return Number(run(
    `UPDATE opportunities SET pack_status = CASE WHEN resume_path IS NOT NULL THEN 'ready' ELSE 'none' END
     WHERE pack_status IN ('queued', 'approved', 'held') AND status IN (${PAST})`,
  ).changes);
}

/** Network blips and busy servers: worth a quiet retry on the next run, not a message to me. */
export function isTransient(err: unknown): boolean {
  return /ERR_NETWORK|ERR_INTERNET|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|Timeout \d+ms exceeded|\b(429|50[234])\b|overloaded/i
    .test(String(err));
}

/** One readable line from an error: no colour codes, call logs or stack traces. */
export function plainError(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\n|Call log:/)[0]
    .replace(/^(Error|TypeError):\s*/, "")
    .trim();
  return text.length > 160 ? text.slice(0, 159).trimEnd() + "…" : text;
}

/** How many times this role's summary or pack started in the last few hours. */
/** Counted from 6 hours ago, or from my last Build / Try again tap if that's later. */
function recentAttempts(id: number, kind: "summary" | "pack"): number {
  const sixHours = new Date(Date.now() - 6 * 3600_000).toISOString();
  const tapped = get<{ at: string }>("SELECT max(at) at FROM events WHERE kind = 'telegram.button' AND ref = $b", { b: `o:build:${id}` })?.at;
  return get<{ n: number }>(
    "SELECT count(*) n FROM events WHERE kind = $k AND ref = $ref AND at >= $since",
    { k: `${kind}.start`, ref: String(id), since: tapped && tapped > sixHours ? tapped : sixHours },
  )!.n;
}

/**
 * Safety net against loops: a role whose summary or pack keeps restarting is stopped and I'm
 * told once, instead of it quietly using up my plan and sending the same card again and again.
 */
export const MAX_ATTEMPTS = 3;
async function tooManyAttempts(id: number, kind: "summary" | "pack"): Promise<boolean> {
  const n = recentAttempts(id, kind);
  if (n < MAX_ATTEMPTS) return false;
  updateOpportunity(id, { pack_status: "failed", pack_error: `Stopped after ${n} ${kind} attempts in 6 hours` });
  logEvent(`${kind}.looping`, id, { attempts: n });
  const o = getOpportunity(id);
  if (o && telegramReady()) {
    await send(`Stopped working on ${html(o.role)} at ${html(o.company)}: it started ${n} times in a few hours without finishing. Tap to try once more.`,
      [[{ text: "Try again", data: `o:build:${id}` }]], { silent: true }).catch(() => {});
  }
  return true;
}

async function onFailure(id: number, err: unknown, requeueAs: string): Promise<boolean> {
  if (isAccountError(err)) {
    updateOpportunity(id, { pack_status: requeueAs, pack_error: null });
    await warnAccountOnce(err);
    return true; // stop this run
  }
  console.error(`Opportunity ${id} failed:`, err);
  const o = getOpportunity(id);
  if (!o) return false; // merged or removed while it was being worked on: nothing to report
  // A dropped connection gets retried on the next run; the attempt limit stops endless retries.
  if (isTransient(err) && recentAttempts(id, requeueAs === "queued" ? "summary" : "pack") < MAX_ATTEMPTS) {
    updateOpportunity(id, { pack_status: requeueAs, pack_error: plainError(err) });
    return false;
  }
  if (PAST_DECISION.has(o.status)) return false; // I've moved on from this role; no need to hear about it
  await send(`Couldn't finish ${html(o.role)} at ${html(o.company)}: ${html(plainError(err))}`, [[{ text: "Try again", data: `o:build:${id}` }]], { silent: true }).catch(() => {});
  return false;
}

export async function runSummaries(limit = 10): Promise<number> {
  if (summariesRunning) return 0;
  summariesRunning = true;
  const fromEmail: number[] = [];
  let done = 0;
  try {
    standDownPastDecisions();
    const queued = all<{ id: number; source: string }>(
      "SELECT id, source FROM opportunities WHERE pack_status = 'queued' ORDER BY (source = 'manual') DESC, created_at DESC LIMIT $n",
      { n: limit },
    );
    for (const { id, source } of queued) {
      if (await tooManyAttempts(id, "summary")) continue;
      try {
        const { skipped } = await buildSummary(id);
        done++;
        if (!telegramReady()) continue;
        // A link I sent always gets its card, even when it's a skip. Email and LinkedIn matches are
        // batched into one list, and ones that don't fit stay quiet (dashboard and sheet only).
        if (source === "manual") await sendCard(id);
        else if (!skipped) fromEmail.push(id);
      } catch (err) {
        if (await onFailure(id, err, "queued")) break;
      }
    }
    if (fromEmail.length) await sendMatchList(fromEmail);
    if (done) await syncSheet().catch((err) => console.error("Sheet sync failed:", err));
  } finally {
    summariesRunning = false;
  }
  return done;
}

export async function runPacks(limit = 3): Promise<number> {
  if (packsRunning) return 0;
  packsRunning = true;
  let done = 0;
  try {
    standDownPastDecisions();
    const approved = all<{ id: number }>("SELECT id FROM opportunities WHERE pack_status = 'approved' ORDER BY updated_at LIMIT $n", { n: limit });
    for (const { id } of approved) {
      if (await tooManyAttempts(id, "pack")) continue;
      try {
        await buildFullPack(id);
        await syncSheet().catch((err) => console.error("Sheet sync failed:", err));
        // I may have tapped Skip, or applied, while it was building: then the pack stays quiet.
        if (telegramReady() && !PAST_DECISION.has(getOpportunity(id)?.status ?? "")) await sendPack(id);
        done++;
      } catch (err) {
        if (await onFailure(id, err, "approved")) break;
      }
    }
  } finally {
    packsRunning = false;
  }
  return done;
}

/** Starts both workers now (after a link arrives or I tap Build), without waiting on them. */
export function kick() {
  void runSummaries().catch((err) => console.error("summaries:", err));
  void runPacks().catch((err) => console.error("packs:", err));
}

/** Older name, kept for the command line: summaries then any approved packs. */
export async function runPackQueue(limit = 5): Promise<number> {
  return (await runSummaries(limit)) + (await runPacks(limit));
}

export async function gmailTick() {
  if (!googleConnected()) return null;
  // The 90-day backfill screens hundreds of emails. Without Gemini that would all run on my
  // Claude plan, so until a Gemini key is set only recent mail is screened.
  const backfill = !kvGet("gmail.backfilled") && (AI_MODE !== "hybrid" || geminiAvailable());
  try {
    return await syncGmail({ backfill });
  } catch (err) {
    if (isAccountError(err)) {
      await warnAccountOnce(err);
      return { paused: "AI account problem" };
    }
    throw err;
  }
}

export async function linkedinTick() {
  if (!existsSync(PATHS.browserProfile)) return null;
  try {
    return await syncLinkedIn();
  } catch (err) {
    if (err instanceof LinkedInUnavailable) {
      const warned = kvGet("linkedin.warnedAt");
      if (!warned || Date.now() - new Date(warned).getTime() > 24 * 3600_000) {
        await send(`LinkedIn sync paused: ${err.message}`, undefined, { silent: true }).catch(() => {});
        kvSet("linkedin.warnedAt", new Date().toISOString());
      }
      return null;
    }
    throw err;
  }
}

/** LinkedIn messages: job conversations are filed on their roles, replies to my notes recorded. */
export async function linkedinMessagesTick() {
  if (!existsSync(PATHS.browserProfile)) return null;
  try {
    const r = await syncLinkedInMessages(loadProfile().name);
    if (r.needsReply && telegramReady()) await sendUrgentPings();
    return r.opened ? r : null;
  } catch (err) {
    if (err instanceof LinkedInUnavailable) return null; // the jobs sync warns about logins once a day
    if (isAccountError(err)) return { paused: "AI account problem" };
    throw err;
  }
}

/** Interviews from Google Calendar. Asks once a week to reconnect Google until Calendar is allowed. */
export async function calendarTick() {
  if (!googleConnected()) return null;
  if (!calendarReady()) {
    const warned = kvGet("calendar.warnedAt");
    if (telegramReady() && (!warned || Date.now() - new Date(warned).getTime() > 7 * 86400_000)) {
      await send("Interviews on your calendar aren't tracked yet. Run <code>npm run jh -- auth:google</code> once to allow read-only Calendar access.", undefined, { silent: true }).catch(() => {});
      kvSet("calendar.warnedAt", new Date().toISOString());
    }
    return null;
  }
  const r = await syncCalendar();
  return "matched" in r && (r.matched || r.cancelled) ? r : null;
}

// ---------- Who's hiring ----------

const researching = new Set<number>();

/** Researches who's hiring for one role now. A failure is retried after a day, not every tick. */
export async function researchNow(id: number): Promise<boolean> {
  if (researching.has(id)) return false;
  researching.add(id);
  try {
    await researchHiring(id);
    reconcileActions();
    return true;
  } catch (err) {
    kvSet(`hiring.failed:${id}`, new Date().toISOString());
    if (isAccountError(err)) { await warnAccountOnce(err); throw err; }
    logEvent("hiring.failed", id, String(err).slice(0, 300));
    return false;
  } finally {
    researching.delete(id);
  }
}

/** Every half hour: one or two roles that don't have a brief yet, applied ones first. */
export async function hiringTick() {
  const due = rolesNeedingResearch(6).filter((id) => {
    const failed = kvGet(`hiring.failed:${id}`);
    return !failed || Date.now() - new Date(failed).getTime() > 86400_000;
  }).slice(0, 2);
  const done: number[] = [];
  for (const id of due) if (await researchNow(id)) done.push(id);
  return done.length ? { researched: done } : null;
}

/** Sends the digest once per day after 8 AM your time. */
export async function digestTick(now = new Date()) {
  if (!telegramReady()) return false;
  const { day: today, minutes } = localClock(now);
  if (minutes < 8 * 60 || kvGet("digest.lastDay") === today) return false;
  await sendDigest(now);
  kvSet("digest.lastDay", today);
  return true;
}

export async function pingTick() {
  reconcileActions();
  if (telegramReady()) await sendUrgentPings();
}

export async function addLink(url: string, note?: string): Promise<string> {
  const result = await addFromLink(url, note);
  if (!result) return NOT_A_POSTING;
  const { opportunity: o, isNew } = result;
  logEvent("manual.add", o.id, url);
  if (o.status === "skipped" && o.skip_reason?.includes("no longer accepting")) {
    await syncSheet().catch(() => {});
    if (telegramReady()) await sendCard(o.id);
    return "";
  }
  // Already applied (or dropped): show where it stands, don't start over.
  if (!isNew && PAST_DECISION.has(o.status)) {
    if (telegramReady()) await sendCard(o.id);
    return "";
  }
  if (!isNew && ["summary", "ready", "approved", "building"].includes(o.pack_status)) {
    if (telegramReady()) await (o.pack_status === "ready" ? sendPack(o.id) : sendCard(o.id));
    return `You're already tracking this one.`;
  }
  updateOpportunity(o.id, { pack_status: "queued" });
  return `${o.role} at ${o.company}. Checking the posting and your fit; the summary follows in under a minute.`;
}

export async function sheetTick() {
  return syncSheet();
}

// ---------- Watched pages ----------

const scanning = new Set<number>();

/** Scans one watched page and starts the summary worker if anything new fits. */
export async function scanNow(id: number, opts: { report?: boolean; force?: boolean } = {}): Promise<ScanResult | null> {
  if (scanning.has(id)) return null;
  scanning.add(id);
  const source = getSource(id);
  try {
    const result = await scanSource(id, { force: opts.force });
    if (result.newOpportunityIds.length) kick();
    if (opts.report && telegramReady()) {
      await send(`<b>${html(source?.label)}</b>: ${describeResult(result)}.${result.matches ? " The summaries follow shortly." : ""}`, undefined, { silent: true });
    }
    return result;
  } catch (err) {
    if (isAccountError(err)) {
      await warnAccountOnce(err);
      throw err;
    }
    const after = getSource(id);
    // One notice when a page keeps failing (or right away when I asked for the scan).
    if (telegramReady() && (opts.report || after?.fail_count === 3)) {
      await send(`Couldn't read <b>${html(source?.label)}</b>: ${html(after?.last_error)}${opts.report ? "" : " Retrying less often until it works."}`,
        [[{ text: "Try again", data: `s:scan:${id}` }, { text: "Stop watching", data: `s:remove:${id}` }]], { silent: true }).catch(() => {});
    }
    throw err;
  } finally {
    scanning.delete(id);
  }
}

/**
 * Re-checks the postings of roles still in play (each about once a day) and tells me, in one
 * quiet message, which ones closed. Roles I haven't applied to come off the list.
 */
export async function postingsTick(opts: Parameters<typeof checkPostings>[0] = {}): Promise<CheckSummary | null> {
  const r = await checkPostings(opts);
  if (!r.closed.length) return r.checked ? { checked: r.checked, closed: [] } : null;
  reconcileActions();
  await syncSheet().catch(() => {});
  if (telegramReady()) {
    const line = (c: CheckSummary["closed"][number]) => `• <b>${html(c.role)}</b> · ${html(c.company)}: ${html(c.reason)}`;
    const skipped = r.closed.filter((c) => !c.applied);
    const applied = r.closed.filter((c) => c.applied);
    const text = [
      skipped.length ? `Posting closed, taken off your list:\n${skipped.map(line).join("\n")}` : "",
      applied.length ? `Posting taken down for roles you applied to (likely filled):\n${applied.map(line).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    await send(text, undefined, { silent: true }).catch(() => {});
  }
  return r;
}

// ---------- Target companies ----------

const scanningCompany = new Set<number>();

/** Reads one company's job board now; new roles that fit go to the summary worker. */
export async function scanCompanyNow(id: number, opts: { report?: boolean } = {}): Promise<CompanyScan | null> {
  if (scanningCompany.has(id)) return null;
  scanningCompany.add(id);
  const c = getCompany(id);
  try {
    const r = await scanCompany(id);
    if (r.newOpportunityIds.length) kick();
    if (opts.report && telegramReady()) {
      await send(`<b>${html(c?.name)}</b>: ${describeCompanyScan(r)}.${r.matches ? " The summaries follow shortly." : ""}`, undefined, { silent: true });
    }
    return r;
  } catch (err) {
    if (isAccountError(err)) { await warnAccountOnce(err); throw err; }
    const after = getCompany(id);
    if (telegramReady() && (opts.report || after?.fail_count === 3)) {
      await send(`Couldn't read <b>${html(c?.name)}</b>'s job board: ${html(after?.last_error)}`, undefined, { silent: true }).catch(() => {});
    }
    throw err;
  } finally {
    scanningCompany.delete(id);
  }
}

/** Every few minutes: reads the boards of target companies whose timer is up. */
export async function companiesTick() {
  const out: Record<string, string> = {};
  for (const c of dueCompanies()) {
    try {
      const r = await scanCompanyNow(c.id);
      if (r && (r.newPostings || r.matches)) out[c.name] = describeCompanyScan(r);
    } catch (err) {
      if (isAccountError(err)) return { paused: "AI account problem" };
      out[c.name] = `failed: ${String(err).slice(0, 120)}`;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Companies from my roles become target companies on their own (a few times a day). */
export async function companiesAutoTick() {
  const r = await autoAddCompanies();
  return r.added.length || r.toCheck.length || r.noBoard.length ? r : null;
}

/**
 * Adds target companies from lines like "Stripe" or "Factory | jobs.ashbyhq.com/factory" (from
 * the dashboard, the bot or the terminal), finds each board, and runs the first scan.
 */
export async function addCompanies(text: string, via: string): Promise<{ lines: string[]; ids: number[] }> {
  const lines: string[] = [];
  const ids: number[] = [];
  for (const { name, link } of parseCompanyLines(text).slice(0, 50)) {
    try {
      const { company, isNew, found } = await addCompany(name, link, { via });
      ids.push(company.id);
      if (found.board) {
        lines.push(`${company.name}: ${isNew ? "watching" : "updated"} its ${BOARD_LABEL[found.board.type]} board (${found.open} open roles), checked every ${company.interval_hours} h.`);
        void scanCompanyNow(company.id).catch(() => {});
      } else if (company.source_id) {
        lines.push(`${company.name}: no job board found, so its careers page is watched instead (${found.careersUrl}).`);
        void scanNow(company.source_id).catch(() => {});
      } else {
        lines.push(`${company.name}: couldn't find its job board. Send its careers page link: ${company.name} | https://…`);
      }
    } catch (err) {
      lines.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { lines, ids };
}


/** Every few minutes: scans whichever watched pages are due. */
export async function sourcesTick() {
  const out: Record<string, string> = {};
  for (const s of dueSources()) {
    try {
      const r = await scanNow(s.id);
      if (r) out[s.label] = describeResult(r);
    } catch (err) {
      if (isAccountError(err)) return { paused: "AI account problem" };
      out[s.label] = `failed: ${String(err).slice(0, 120)}`;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Adds a page to watch (from the bot, the dashboard or the terminal) and scans it right away. */
export async function watchPage(url: string, opts: { label?: string; intervalHours?: number; via: string }): Promise<{ text: string; id?: number }> {
  let added;
  try {
    added = addSource(url, { label: opts.label, intervalHours: opts.intervalHours, via: opts.via });
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err) };
  }
  const { source, isNew } = added;
  if (!isNew) return { text: `Already watching ${source.label}, every ${source.interval_hours} hours.`, id: source.id };
  void scanNow(source.id, { report: true }).catch(() => {});
  return { text: `Watching ${source.label}. It's checked every ${source.interval_hours} hours; the first scan is running now.`, id: source.id };
}

/** X: bookmarks, watched threads and accounts, then searches. Tells me once a month if the budget runs out. */
export async function xTick() {
  if (!xConfigured()) return null;
  const r = await scanX();
  // An empty X balance: tell me once a day until it's topped up.
  if (r.stopped && /no credits/i.test(r.stopped)) {
    const key = `x.warnedCredits.${new Date().toISOString().slice(0, 10)}`;
    if (!kvGet(key)) {
      kvSet(key, "1");
      if (telegramReady()) await send(`X is paused: ${html(r.stopped)} I'll try again every 6 hours.`, undefined, { silent: true }).catch(() => {});
    }
  } else if (r.stopped && /budget/i.test(r.stopped)) {
    const key = `x.warned.${new Date().toISOString().slice(0, 7)}`;
    // The daily pace pauses quietly; only the month's cap (or an empty balance) is worth a message.
    if (!kvGet(key) && spentThisMonth() >= monthlyBudget() - 0.05) {
      kvSet(key, "1");
      if (telegramReady()) await send(`X paused for the rest of the month: ${html(r.stopped)}. Raise X_MONTHLY_BUDGET_USD in .env to keep going.`, undefined, { silent: true }).catch(() => {});
    }
  }
  if (r.newOpportunityIds.length) kick();
  return r.read || r.stopped ? { read: r.read, matches: r.matches, threadsAdded: r.threadsAdded, stopped: r.stopped } : null;
}

/** A link to an X post: read it and its replies, file roles, and keep watching the thread. */
export async function readXLink(url: string) {
  const r = await readThreadLink(url);
  kick();
  return r;
}

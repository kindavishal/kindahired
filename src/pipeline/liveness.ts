import { existsSync } from "node:fs";
import { PATHS } from "../config.ts";
import { all, logEvent, nowIso } from "../db/index.ts";
import { getOpportunity, updateOpportunity, type Opportunity } from "../db/opportunities.ts";
import { htmlToText } from "./evidence.ts";
import { getTimers } from "../loops/timers.ts";
import { LinkedInUnavailable, readLinkedInJob } from "../sources/linkedin.ts";

/**
 * Postings close after the tool first reads them. This re-checks the links of roles still in
 * play, once a day, and takes a role off the list when its posting is gone. Only clear signals
 * count (the job board's own API says the job is gone, the page answers 404/410, it redirects
 * away from the job, or the page says it's closed); anything else leaves the role as it is.
 */

export type PostingState = "open" | "closed" | "unknown";
export interface Liveness { state: PostingState; reason: string; url: string; sure?: boolean }

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Words a job page uses once the role is gone. Specific on purpose: no "apply by" or "closing date". */
export const CLOSED_TEXT = new RegExp([
  "no longer accepting applications",
  "(?:job|position|posting|role|vacancy|opening|requisition)s? (?:is|has been|was) (?:no longer (?:available|open|active)|closed|filled|expired|removed|taken down)",
  "this (?:job|position|posting|role|vacancy|opening) (?:has )?(?:expired|closed|been filled)",
  "(?:job|posting|position) (?:not found|no longer exists|has expired)",
  "applications (?:are|have) (?:now )?closed",
  "we(?:'re| are) no longer (?:hiring|recruiting) for this",
  "the page you were looking for",
  "page (?:you requested )?(?:could not|cannot|can't) be found",
].join("|"), "i");

/** URLs that can't be checked: social posts, forms, chats, and things that aren't links. */
const UNCHECKABLE = /(^|\.)(x\.com|twitter\.com|whatsapp\.com|wa\.me|t\.me|forms\.gle|docs\.google\.com|typeform\.com)$/i;

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9]*\d{5,}[A-Za-z0-9]*|[A-Z0-9]{8,})$/;

const open = (url: string, reason: string): Liveness => ({ state: "open", reason, url, sure: true });
const closed = (url: string, reason: string): Liveness => ({ state: "closed", reason, url });
const unknown = (url: string, reason: string): Liveness => ({ state: "unknown", reason, url });

async function status(f: Fetch, url: string): Promise<number> {
  const res = await f(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  await res.body?.cancel().catch(() => {});
  return res.status;
}

/** The job board's own API, for the boards that have a public one. Null for other sites. */
async function viaAtsApi(f: Fetch, url: string): Promise<Liveness | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  // Workable: apply.workable.com/<account>/j/<id>; a closed job redirects to the account page with ?not_found=true.
  if (host === "apply.workable.com" && parts[1] === "j" && parts[2]) {
    const s = await status(f, `https://apply.workable.com/api/v2/accounts/${parts[0]}/jobs/${parts[2]}`);
    if (s === 404) return closed(url, "Workable says the job no longer exists");
    if (s === 200) return open(url, "Workable lists the job");
    return unknown(url, `Workable answered ${s}`);
  }

  // Greenhouse: (job-)boards.greenhouse.io/<board>/jobs/<id>, or the embed form with for= and token=.
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const board = parts[1] === "jobs" ? parts[0] : u.searchParams.get("for");
    const id = parts[1] === "jobs" ? parts[2] : u.searchParams.get("token");
    if (board && id && /^\d+$/.test(id)) {
      const s = await status(f, `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`);
      if (s === 404) return closed(url, "Greenhouse says the job no longer exists");
      if (s === 200) return open(url, "Greenhouse lists the job");
      return unknown(url, `Greenhouse answered ${s}`);
    }
  }

  // Lever: jobs.lever.co/<company>/<uuid>[/apply]
  if (host === "jobs.lever.co" && parts[1]) {
    const s = await status(f, `https://api.lever.co/v0/postings/${parts[0]}/${parts[1]}`);
    if (s === 404) return closed(url, "Lever says the job no longer exists");
    if (s === 200) return open(url, "Lever lists the job");
    return unknown(url, `Lever answered ${s}`);
  }

  // Ashby: jobs.ashbyhq.com/<board>/<uuid>[/application]. Its pages answer 404 to scripts even
  // when open, so the board's public job list is the only reliable read.
  if (host === "jobs.ashbyhq.com" && parts[1]) {
    const res = await f(`https://api.ashbyhq.com/posting-api/job-board/${parts[0]}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return unknown(url, `Ashby answered ${res.status}`);
    const jobs = ((await res.json()) as { jobs?: { id: string }[] }).jobs ?? [];
    if (jobs.length === 0) return unknown(url, "Ashby board listed no jobs");
    return jobs.some((j) => j.id.toLowerCase() === parts[1].toLowerCase())
      ? open(url, "Ashby lists the job")
      : closed(url, "No longer on the company's Ashby job board");
  }
  return null;
}

/** Any other page: its answer, where it redirects, and what it says. */
async function viaPage(f: Fetch, url: string): Promise<Liveness> {
  const res = await f(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => {});
    return closed(url, `The posting page is gone (${res.status})`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return unknown(url, `The page answered ${res.status}`);
  }
  const final = res.url || url;
  if (/[?&](not_found|error)=true|[?&]job_not_found|\/(job-?not-?found|expired|404)(\/|$)/i.test(final)) {
    return closed(url, "The job board sends the link to its 'not found' page");
  }
  // A link to one job that now lands somewhere without that job's ID was taken down.
  const ids = (s: string) => { try { return new URL(s).pathname.split("/").filter((p) => ID_SEGMENT.test(p)); } catch { return []; } };
  const was = ids(url);
  if (was.length && !was.some((id) => final.includes(id))) return closed(url, "The link now redirects away from the job");
  const text = htmlToText(await res.text()).slice(0, 30_000);
  const hit = text.match(CLOSED_TEXT);
  if (hit) return closed(url, `The page says "${hit[0].trim()}"`);
  return unknown(url, "The page loads and doesn't say it's closed");
}

const linkedinId = (url: string) => url.match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/)?.[1];

export interface CheckDeps {
  fetch?: Fetch;
  /** Reads a LinkedIn job through my logged-in browser. Null when that isn't available. */
  linkedin?: ((id: string) => Promise<{ text: string; closed: boolean }>) | null;
}

/** Checks one link. Never throws: a link that can't be read is "unknown". */
export async function checkPostingUrl(url: string, deps: CheckDeps = {}): Promise<Liveness> {
  const f = deps.fetch ?? fetch;
  let host = "";
  try { host = new URL(url).hostname; } catch { return unknown(url, "Not a link"); }
  try {
    const li = linkedinId(url);
    if (li) {
      if (!deps.linkedin) return unknown(url, "LinkedIn isn't connected");
      const job = await deps.linkedin(li);
      if (job.closed) return closed(url, "LinkedIn says it's no longer accepting applications");
      if (/this job is no longer available|job (?:post )?(?:has been )?(?:removed|closed)/i.test(job.text)) return closed(url, "LinkedIn says the job is no longer available");
      return job.text.length > 500 ? open(url, "LinkedIn shows the job") : unknown(url, "LinkedIn page didn't load");
    }
    if (/(^|\.)linkedin\.com$/i.test(host) || UNCHECKABLE.test(host)) return unknown(url, "Can't check this kind of link");
    return (await viaAtsApi(f, url)) ?? (await viaPage(f, url));
  } catch (err) {
    if (err instanceof LinkedInUnavailable) throw err;
    return unknown(url, `Couldn't read it: ${err instanceof Error ? err.message : err}`);
  }
}

/** The role's links worth checking, the company's own first. */
export function postingLinks(o: Pick<Opportunity, "apply_url" | "source_url" | "linkedin_job_id">): string[] {
  const links = [o.apply_url, o.source_url, o.linkedin_job_id ? `https://www.linkedin.com/jobs/view/${o.linkedin_job_id}/` : null]
    .filter((l): l is string => !!l && /^https?:\/\//i.test(l.trim()))
    .map((l) => l.trim());
  // One LinkedIn read per role is enough.
  const seen = new Set<string>();
  return links.filter((l) => {
    const key = linkedinId(l) ?? l;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One verdict from all of a role's links. A board's API saying the job is listed wins (a stale
 * job-board copy shouldn't close a role the company still lists); otherwise any clear "closed".
 */
export async function checkOpportunity(o: Opportunity, deps: CheckDeps = {}): Promise<Liveness> {
  const links = postingLinks(o);
  if (!links.length) return unknown("", "No link to check");
  const results: Liveness[] = [];
  for (const l of links) results.push(await checkPostingUrl(l, deps));
  return results.find((r) => r.state === "open" && r.sure)
    ?? results.find((r) => r.state === "closed")
    ?? results.find((r) => r.state === "open")
    ?? results[0];
}

/** Roles not applied to yet: a closed posting takes these off the list. */
const PRE_APPLY = ["found", "decide", "ready"];
/** Roles applied to: a closed posting is noted (it's likely filled) but the status stays mine to change. */
const IN_FLIGHT = ["applied", "interviewing"];

export interface CheckSummary { checked: number; closed: { id: number; company: string; role: string; reason: string; applied: boolean }[] }

/** Re-checks the roles whose links are due, up to `limit`, and acts on the ones that closed. */
export async function checkPostings(opts: { limit?: number; force?: boolean; ids?: number[]; deps?: CheckDeps } = {}): Promise<CheckSummary> {
  const limit = opts.limit ?? 20;
  const statuses = [...PRE_APPLY, ...IN_FLIGHT].map((s) => `'${s}'`).join(",");
  const cutoff = new Date(Date.now() - getTimers().postingRecheckHours * 3600_000).toISOString();
  const rows = opts.ids?.length
    ? opts.ids.map((id) => getOpportunity(id)).filter((o): o is Opportunity => !!o)
    : all<Opportunity>(
      `SELECT * FROM opportunities WHERE status IN (${statuses})
         AND (apply_url LIKE 'http%' OR source_url LIKE 'http%' OR linkedin_job_id IS NOT NULL)
         AND ($force OR posting_checked_at IS NULL OR posting_checked_at < $cutoff)
         AND coalesce(posting_state, '') != 'closed'
       ORDER BY posting_checked_at IS NOT NULL, posting_checked_at, id LIMIT $limit`,
      { force: opts.force ? 1 : 0, cutoff, limit },
    );

  let linkedin = opts.deps?.linkedin;
  if (linkedin === undefined) linkedin = existsSync(PATHS.browserProfile) ? readLinkedInJob : null;
  const deps: CheckDeps = { fetch: opts.deps?.fetch, linkedin };

  const summary: CheckSummary = { checked: 0, closed: [] };
  for (const o of rows) {
    let r: Liveness;
    try {
      r = await checkOpportunity(o, deps);
    } catch (err) {
      // LinkedIn's browser is busy or logged out: check the rest without it, this one next time.
      if (err instanceof LinkedInUnavailable) { deps.linkedin = null; r = await checkOpportunity(o, deps); }
      else throw err;
    }
    summary.checked++;
    const today = nowIso().slice(0, 10);
    updateOpportunity(o.id, { posting_checked_at: nowIso(), posting_state: r.state });
    if (r.state !== "closed") continue;
    logEvent("posting.closed", o.id, { url: r.url, reason: r.reason });
    const applied = IN_FLIGHT.includes(o.status);
    if (applied) {
      updateOpportunity(o.id, { check_notes: [o.check_notes, `Posting taken down (${today}): ${r.reason}. The role may be filled.`].filter(Boolean).join("\n") });
    } else {
      updateOpportunity(o.id, { status: "skipped", skip_reason: `Posting closed (${today}): ${r.reason}` });
    }
    summary.closed.push({ id: o.id, company: o.company, role: o.role, reason: r.reason, applied });
  }
  return summary;
}

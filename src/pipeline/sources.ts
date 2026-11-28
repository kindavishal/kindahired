import { z } from "zod";
import { all, get, logEvent, nowIso, run } from "../db/index.ts";
import { llm } from "../llm/client.ts";
import { htmlToLinkedText, NEEDS_LOGIN, readListing } from "../sources/web.ts";
import { addOpportunity, screenerSystem } from "./ingest.ts";

/**
 * Watched pages: job boards, careers pages and curated feeds I add from the dashboard or the bot.
 * Each is scanned on its own timer. A scan reads the page, lists the postings on it, screens them
 * against my targets, and queues the ones that fit, exactly like a job-alert email.
 */

export interface Source {
  id: number;
  url: string;
  label: string;
  interval_hours: number;
  status: "active" | "paused";
  added_via: string | null;
  seen_links: string;
  last_scanned_at: string | null;
  last_result: string | null;
  last_error: string | null;
  fail_count: number;
  created_at: string;
}

export interface ScanResult {
  postings: number;      // postings the scan saw on the page
  newPostings: number;   // ones not seen on an earlier scan
  matches: number;       // new ones that fit and were queued
  newOpportunityIds: number[];
  deferred: number;      // matches over the per-scan cap, left for the next scan
  unchanged?: boolean;   // no new links since the last scan, so nothing was read
}

/** Most new matches one scan queues. The rest are picked up on the next scan. */
const MAX_NEW_PER_SCAN = 10;
/** Text sent to the screening step per call. */
const CHUNK = 12_000;

export const getSource = (id: number) => get<Source>("SELECT * FROM sources WHERE id = $id", { id });
export const listSources = () => all<Source>("SELECT * FROM sources ORDER BY status, created_at");

export function normaliseSourceUrl(input: string): string {
  const raw = input.trim().replace(/[)>.,]+$/, "");
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only web pages (http or https) can be watched.");
  if (NEEDS_LOGIN.test(url.hostname)) throw new Error("LinkedIn and X pages need a login, so they can't be watched. LinkedIn saved jobs are already synced.");
  url.hash = "";
  return url.href;
}

/** A short name for a page: its title-ish host, e.g. "jobsinthewild.tal.club". */
const labelFor = (url: string) => new URL(url).hostname.replace(/^www\./, "");

export function addSource(input: string, opts: { label?: string; intervalHours?: number; via?: string } = {}): { source: Source; isNew: boolean } {
  const url = normaliseSourceUrl(input);
  const existing = get<Source>("SELECT * FROM sources WHERE url = $url", { url });
  if (existing) {
    if (existing.status === "paused") run("UPDATE sources SET status = 'active' WHERE id = $id", { id: existing.id });
    return { source: getSource(existing.id)!, isNew: false };
  }
  const interval = Math.min(Math.max(opts.intervalHours ?? 6, 1), 168);
  run("INSERT INTO sources (url, label, interval_hours, added_via) VALUES ($url, $label, $interval, $via)", {
    url, label: opts.label?.trim() || labelFor(url), interval, via: opts.via ?? null,
  });
  const source = get<Source>("SELECT * FROM sources WHERE url = $url", { url })!;
  logEvent("source.added", source.id, { url, via: opts.via });
  return { source, isNew: true };
}

export function setSourceStatus(id: number, status: "active" | "paused") {
  run("UPDATE sources SET status = $status, fail_count = CASE WHEN $status = 'active' THEN 0 ELSE fail_count END WHERE id = $id", { id, status });
}

/** Stops watching. Roles already found from the page stay. */
export function removeSource(id: number) {
  run("DELETE FROM sources WHERE id = $id", { id });
  logEvent("source.removed", id);
}

const Extracted = z.object({
  is_job_listing: z.boolean().describe("True if this page lists job openings (a board, careers page or feed of hiring posts)."),
  jobs: z.array(z.object({
    company: z.string(),
    role: z.string(),
    url: z.string().nullable().describe("The link for this posting, copied exactly from a [→ ...] marker next to it. Prefer the posting's own page on this site."),
    apply_url: z.string().nullable().describe("A separate apply or contact link for this posting, if there is one."),
    location: z.string().nullable(),
    summary: z.string().describe("One or two lines: what the role is, as the page describes it."),
    relevance: z.enum(["high", "medium", "low"]),
  })),
});
type ExtractedJob = z.infer<typeof Extracted>["jobs"][number];

const EXTRACT_RULES = `You are reading one part of a job listing page. Links appear as [→ URL] right after the words they're on.
List every job opening on this part of the page. For each:
- company and role: as posted. If a hiring post doesn't name the company, use the poster's company from their headline. Skip posts with no clear role.
- url: copy exactly from a [→ ...] marker belonging to that posting. Never make one up. Null if there is none.
- relevance: "high" only for my target role families in a location the playbook allows; "medium" if it's adjacent or unclear; "low" for everything else.
Skip navigation, filters, ads and anything that isn't an opening.`;

/** Splits the page text into pieces, keeping only those with links not seen before. */
function chunksWithNewLinks(text: string, fresh: Set<string>): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur.length + line.length > CHUNK && cur) { out.push(cur); cur = ""; }
    cur += line + "\n";
  }
  if (cur) out.push(cur);
  if (!fresh.size) return out;
  return out.filter((c) => [...c.matchAll(/\[→ ([^\]]+)\]/g)].some((m) => fresh.has(m[1])));
}

const itemKey = (j: ExtractedJob) => (j.url ? j.url.replace(/[?#].*$/, "").replace(/\/$/, "") : `${j.company}|${j.role}`.toLowerCase());

/** Scans one watched page now. Safe to run again: postings already seen are skipped. */
export async function scanSource(id: number, opts: { force?: boolean } = {}): Promise<ScanResult> {
  const source = getSource(id);
  if (!source) throw new Error("No such source");
  try {
    const page = await readListing(source.url);
    const { text, links } = htmlToLinkedText(page.html, page.url);
    const before = new Set<string>(JSON.parse(source.seen_links));
    const fresh = new Set(links.filter((l) => !before.has(l)));
    const firstScan = !source.last_scanned_at;

    let result: ScanResult = { postings: 0, newPostings: 0, matches: 0, deferred: 0, newOpportunityIds: [] };
    if (!firstScan && !fresh.size && !opts.force) {
      result.unchanged = true;
    } else {
      const parts = chunksWithNewLinks(text, firstScan || opts.force ? new Set() : fresh);
      const jobs: ExtractedJob[] = [];
      let listing = false;
      for (const [i, part] of parts.entries()) {
        const out = await llm.structured(`source.extract:${source.id}`, Extracted, {
          effort: "low", maxTokens: 16000,
          system: `${screenerSystem()}\n\n${EXTRACT_RULES}`,
          prompt: `Page: ${source.label} (${page.url}), part ${i + 1} of ${parts.length}\n\n${part}`,
        });
        listing ||= out.is_job_listing || out.jobs.length > 0;
        jobs.push(...out.jobs);
      }
      if (firstScan && !listing) throw new Error("This page doesn't seem to list any job openings.");
      result = fileJobs(source, jobs);
    }
    // Remember every link on the page (capped), so the next scan reads only what's new. If some
    // matches were left over the cap, keep the old list so the next scan reads them again.
    const remembered = result.deferred ? [...before] : [...new Set([...links, ...before])].slice(0, 3000);
    run(
      `UPDATE sources SET seen_links = $links, last_scanned_at = $now, last_result = $result, last_error = NULL, fail_count = 0 WHERE id = $id`,
      { id, links: JSON.stringify(remembered), now: nowIso(), result: JSON.stringify({ ...result, newOpportunityIds: undefined }) },
    );
    logEvent("source.scan", id, result);
    return result;
  } catch (err) {
    run("UPDATE sources SET last_scanned_at = $now, last_error = $err, fail_count = fail_count + 1 WHERE id = $id", {
      id, now: nowIso(), err: String(err instanceof Error ? err.message : err).slice(0, 300),
    });
    logEvent("source.scan_failed", id, String(err));
    throw err;
  }
}

/** Files the postings from a scan. New ones that fit become opportunities, like an email alert. */
export function fileJobs(source: Source, jobs: ExtractedJob[]): ScanResult {
  const result: ScanResult = { postings: jobs.length, newPostings: 0, matches: 0, deferred: 0, newOpportunityIds: [] };
  const seenThisScan = new Set<string>();
  for (const j of jobs) {
    const key = itemKey(j);
    if (seenThisScan.has(key)) continue;
    seenThisScan.add(key);
    const known = get("SELECT 1 FROM inbox_items WHERE source = $s AND external_id = $k", { s: `watch:${source.id}`, k: key });
    if (known) continue;
    // Over the cap: leave it unrecorded so the next scan picks it up.
    if (j.relevance !== "low" && result.matches >= MAX_NEW_PER_SCAN) { result.deferred++; continue; }
    result.newPostings++;
    let opportunityId: number | null = null;
    if (j.relevance !== "low") {
      const { opportunity, isNew } = addOpportunity(j.company, j.role, {
        source: `watch:${source.label}`,
        source_url: j.url,
        apply_url: j.apply_url && j.apply_url !== j.url ? j.apply_url : null,
        jd_text: [`Found on ${source.label}${j.location ? ` · ${j.location}` : ""}`, j.summary].join("\n"),
      }, j.relevance);
      opportunityId = opportunity.id;
      if (isNew) { result.matches++; result.newOpportunityIds.push(opportunity.id); }
    }
    // Low matches are remembered but not added as roles, so a busy board doesn't flood the tracker.
    run(
      `INSERT INTO inbox_items (source, external_id, url, title, raw, status, opportunity_id) VALUES ($s, $k, $url, $title, $raw, $status, $opp)
       ON CONFLICT(source, external_id) DO NOTHING`,
      {
        s: `watch:${source.id}`, k: key, url: j.url, title: `${j.role} · ${j.company}`, raw: JSON.stringify(j),
        status: opportunityId ? "processed" : "ignored", opp: opportunityId,
      },
    );
  }
  return result;
}

/** Sources whose timer is up. */
export function dueSources(now = new Date()): Source[] {
  return listSources().filter((s) => s.status === "active"
    && (!s.last_scanned_at || now.getTime() - new Date(s.last_scanned_at).getTime() >= s.interval_hours * 3600_000
      // After a failure, back off: 1x, 2x, 4x the interval, at most a day.
      * (s.fail_count ? Math.max(1, Math.min(2 ** (s.fail_count - 1), 24 / s.interval_hours)) : 1)));
}

export function describeResult(r: ScanResult): string {
  if (r.unchanged) return "nothing new since the last check";
  if (!r.postings) return "no postings found";
  return `${r.postings} posting${r.postings === 1 ? "" : "s"}, ${r.newPostings} new, ${r.matches} match${r.matches === 1 ? "" : "es"}`
    + (r.deferred ? ` (${r.deferred} more next check)` : "");
}

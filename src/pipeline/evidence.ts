import { z } from "zod";
import { loadProfile } from "../config.ts";
import { all, logEvent, nowIso, run } from "../db/index.ts";
import { llm } from "../llm/client.ts";

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|li|h[1-6]|div|section|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&middot;/g, "·").replace(/&rarr;/g, "→")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Crawls the portfolio (same site only) and stores each page's text. */
export async function crawlPortfolio(maxPages = 40): Promise<number> {
  const start = new URL(loadProfile().portfolio);
  const queue = [start.href];
  const seen = new Set<string>();
  while (queue.length && seen.size < maxPages) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (personal job tracker)" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) continue;
    const html = await res.text();
    run(
      `INSERT INTO profile_sources (url, text, fetched_at) VALUES ($url, $text, $at)
       ON CONFLICT(url) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at`,
      { url, text: htmlToText(html), at: nowIso() },
    );
    for (const m of html.matchAll(/href="([^"#]+)"/g)) {
      const next = new URL(m[1], url);
      if (next.host !== start.host || /\.(png|jpe?g|svg|woff2?|xml|pdf|ico|css|js)$/i.test(next.pathname)) continue;
      next.search = "";
      if (!seen.has(next.href)) queue.push(next.href);
    }
  }
  logEvent("evidence.crawl", null, { pages: seen.size });
  return seen.size;
}

const Extracted = z.object({
  facts: z.array(
    z.object({
      claim: z.string().describe("One self-contained, checkable fact about me, with its numbers and dates."),
      source: z.string().describe("The page URL it came from."),
      conflict_note: z.string().nullable().describe("If another source says something different, say what differs. Otherwise null."),
    }),
  ),
});

/**
 * Turns the portfolio pages plus my hand-checked facts into one evidence bank.
 * Hand-checked facts (from the tracker) are kept as they are; new facts from the site are added.
 */
export async function buildEvidence(): Promise<{ added: number; conflicts: number }> {
  const pages = all<{ url: string; text: string }>("SELECT url, text FROM profile_sources");
  if (!pages.length) throw new Error("No portfolio pages stored yet. Run the crawl first.");
  const known = all<{ claim: string; source: string; note: string | null }>("SELECT claim, source, note FROM evidence");

  const result = await llm.structured("evidence.extract", Extracted, {
    effort: "high",
    maxTokens: 32000,
    system:
      "You build an evidence bank of facts about one person, for use in job applications. " +
      "Only record what a source states. Never infer, round up or combine numbers. Keep each fact atomic: one role, project, metric or credential. " +
      "Keep the person's own wording for numbers and names.",
    prompt: [
      "Portfolio pages (the source of truth):",
      ...pages.map((p) => `\n=== ${p.url} ===\n${p.text}`),
      "\n\nFacts already checked by the person (keep these, don't repeat them):",
      ...known.map((k) => `- ${k.claim} [${k.source}]${k.note ? ` (note: ${k.note})` : ""}`),
      "\n\nList every other fact on the portfolio that could support a resume or cover note: roles with dates, metrics, projects, links, credentials, education, skills. " +
        "Where a portfolio fact disagrees with a checked fact, include it and explain the difference in conflict_note.",
    ].join("\n"),
  });

  let added = 0, conflicts = 0;
  for (const f of result.facts) {
    const r = run(
      `INSERT INTO evidence (claim, source, note, conflict) VALUES ($claim, $source, $note, $conflict)
       ON CONFLICT(claim) DO NOTHING`,
      { claim: f.claim.trim(), source: f.source, note: f.conflict_note, conflict: f.conflict_note ? 1 : 0 },
    );
    if (r.changes) added++;
    if (f.conflict_note) conflicts++;
  }
  logEvent("evidence.built", null, { added, conflicts });
  return { added, conflicts };
}

export interface EvidenceRow { id: number; claim: string; source: string; note: string | null; conflict: number }

export function evidenceBlock(): { text: string; rows: EvidenceRow[] } {
  const rows = all<EvidenceRow>("SELECT * FROM evidence ORDER BY id");
  const text = rows
    .map((e) => `E${e.id}: ${e.claim} [source: ${e.source}]${e.conflict ? ` [UNSETTLED: ${e.note}]` : ""}`)
    .join("\n");
  return { text, rows };
}

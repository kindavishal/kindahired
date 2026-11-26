import { kvGet, kvSet, logEvent } from "../db/index.ts";

/**
 * Firecrawl web search on the free plan: a search plus the text of the top pages in one call,
 * in seconds. It replaces the slow Claude Code web research for finding a posting or a person's
 * profile. Free accounts can't be charged, so the only limit is the monthly credit allowance:
 * credits are counted here, and when they run out (or Firecrawl says so) search stops until the
 * month resets and the old route takes over.
 */

const API = "https://api.firecrawl.dev/v2";
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const usedKey = () => `firecrawl.credits.${monthKey()}`;

/** The free plan's allowance, less a margin so a burst never runs past it. */
export const monthlyCredits = () => Number(process.env.FIRECRAWL_MONTHLY_CREDITS ?? 1000);
const RESERVE = 25;

export function firecrawlAvailable(): boolean {
  if (!process.env.FIRECRAWL_API_KEY) return false;
  if (kvGet("firecrawl.exhausted") === monthKey()) return false;
  return creditsUsed() + RESERVE < monthlyCredits();
}

export const creditsUsed = () => Number(kvGet(usedKey()) ?? 0);

/** What a search costs: 2 credits per 10 results, plus 1 per page whose text is fetched. */
export const searchCost = (limit: number, scrape: boolean) => 2 * Math.ceil(limit / 10) + (scrape ? limit : 0);

export interface SearchResult { url: string; title: string; description: string; markdown: string | null }

export class FirecrawlUnavailable extends Error {}

export async function firecrawlSearch(query: string, opts: { limit?: number; scrape?: boolean; label?: string } = {}): Promise<SearchResult[]> {
  const limit = opts.limit ?? 5;
  const scrape = opts.scrape ?? false;
  const cost = searchCost(limit, scrape);
  if (!firecrawlAvailable() || creditsUsed() + cost + RESERVE > monthlyCredits()) {
    throw new FirecrawlUnavailable("Firecrawl credits for this month are used up");
  }
  const res = await fetch(`${API}/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      query, limit,
      ...(scrape ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 402 || res.status === 429) {
    // Out of credits (402) or over the free plan's rate (429): stop for the month or back off.
    if (res.status === 402) kvSet("firecrawl.exhausted", monthKey());
    logEvent("firecrawl.unavailable", opts.label ?? null, { status: res.status });
    throw new FirecrawlUnavailable(res.status === 402 ? "Firecrawl credits for this month are used up" : "Firecrawl is rate limiting");
  }
  if (!res.ok) throw new Error(`Firecrawl search: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: unknown; creditsUsed?: number };
  kvSet(usedKey(), String(creditsUsed() + (json.creditsUsed ?? cost)));
  // v2 groups results by kind ({ web: [...] }); v1 returned a flat list.
  const rows = (Array.isArray(json.data) ? json.data : (json.data as { web?: unknown[] })?.web ?? []) as Array<Record<string, unknown>>;
  const out = rows.map((r) => ({
    url: String(r.url ?? ""),
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    markdown: typeof r.markdown === "string" ? r.markdown : null,
  })).filter((r) => r.url);
  logEvent("firecrawl.search", opts.label ?? null, { results: out.length, credits: json.creditsUsed ?? cost });
  return out;
}

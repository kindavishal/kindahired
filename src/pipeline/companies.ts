import { z } from "zod";
import { all, get, kvGet, kvSet, logEvent, nowIso, run } from "../db/index.ts";
import { findOpportunity, normalise, opportunitiesAtCompany, sameCompany } from "../db/opportunities.ts";
import { llm } from "../llm/client.ts";
import { firecrawlAvailable, firecrawlSearch } from "../sources/firecrawl.ts";
import { addOpportunity, screenerSystem } from "./ingest.ts";
import { addSource } from "./sources.ts";

/**
 * Target companies: the companies I most want to work at, watched through their own job board.
 * Most companies post on an applicant tracking system with a public job list (Greenhouse, Lever,
 * Ashby, Workable, SmartRecruiters, Recruitee), so a new posting is seen within hours of going
 * live, read exactly, with no AI and no scraping. Only the new titles are screened against my
 * targets. A company whose board can't be found falls back to a watched careers page.
 */

export type BoardType = "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters" | "recruitee";
export interface Board { type: BoardType; slug: string }

export interface Company {
  id: number;
  name: string;
  board_type: BoardType | null;
  board_slug: string | null;
  careers_url: string | null;
  source_id: number | null;   // the watched page used when there's no board
  interval_hours: number;
  status: "active" | "paused";
  added_via: string | null;
  seen_ids: string;            // JSON: posting IDs already screened
  open_count: number | null;   // postings on the board at the last scan
  last_scanned_at: string | null;
  last_result: string | null;
  last_error: string | null;
  fail_count: number;
  needs_check: number;         // 1: board guessed from the name, waiting for me to confirm it
  created_at: string;
}

export interface Posting {
  id: string;
  title: string;
  url: string;
  applyUrl: string | null;
  location: string | null;
  remote: boolean | null;
  department: string | null;
  publishedAt: string | null;
}

export interface CompanyScan { postings: number; newPostings: number; matches: number; deferred: number; newOpportunityIds: number[] }

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const MAX_NEW_PER_SCAN = 10;

// ---------- Boards ----------

export const BOARD_LABEL: Record<BoardType, string> = {
  greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workable: "Workable", smartrecruiters: "SmartRecruiters", recruitee: "Recruitee",
};

export function boardUrl(b: Board): string {
  return {
    greenhouse: `https://job-boards.greenhouse.io/${b.slug}`,
    lever: `https://jobs.lever.co/${b.slug}`,
    ashby: `https://jobs.ashbyhq.com/${b.slug}`,
    workable: `https://apply.workable.com/${b.slug}/`,
    smartrecruiters: `https://jobs.smartrecruiters.com/${b.slug}`,
    recruitee: `https://${b.slug}.recruitee.com/`,
  }[b.type];
}

/** The board a link points at, from a board page, a posting on it, or an embed's script URL. */
export function parseBoard(text: string): Board | null {
  const patterns: [BoardType, RegExp][] = [
    ["greenhouse", /(?:job-)?boards(?:-api)?(?:\.eu)?\.greenhouse\.io\/(?:v1\/boards\/|embed\/job_board(?:\/js)?\?for=)?([a-z0-9_-]+)/i],
    ["greenhouse", /greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9_-]+)/i],
    ["lever", /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)/i],
    ["lever", /api\.lever\.co\/v0\/postings\/([a-z0-9_.-]+)/i],
    ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i],
    ["ashby", /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_.%-]+)/i],
    ["workable", /apply\.workable\.com\/(?!api\b|j\/)([a-z0-9_-]+)/i],
    ["workable", /([a-z0-9-]+)\.workable\.com/i],
    ["smartrecruiters", /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i],
    ["recruitee", /([a-z0-9-]+)\.recruitee\.com/i],
  ];
  // Embeds name the board in a query; check those first so "embed" isn't read as the slug.
  const ordered = [...patterns].sort((a, b) => Number(/for=/.test(String(b[1]))) - Number(/for=/.test(String(a[1]))));
  for (const [type, re] of ordered) {
    const m = text.match(re);
    const slug = m?.[1]?.replace(/\.$/, "");
    if (slug && !/^(embed|www|jobs|api|apply|careers|app)$/i.test(slug)) return { type, slug: decodeURIComponent(slug) };
  }
  return null;
}

const iso = (x: unknown) => {
  if (x == null || x === "") return null;
  const d = new Date(typeof x === "number" ? x : String(x));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The board's open postings, or null if the board doesn't exist. */
export async function readBoard(b: Board, f: Fetch = fetch): Promise<{ name: string | null; postings: Posting[] } | null> {
  const get = async (url: string) => {
    const res = await f(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`${BOARD_LABEL[b.type]} answered ${res.status}`);
    return res.json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const s = encodeURIComponent(b.slug);
  switch (b.type) {
    case "greenhouse": {
      const d = await get(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`);
      if (!d) return null;
      const meta = await get(`https://boards-api.greenhouse.io/v1/boards/${s}`).catch(() => null);
      return {
        name: meta?.name ?? null,
        postings: (d.jobs ?? []).map((j: any) => ({
          id: String(j.id), title: j.title, url: j.absolute_url, applyUrl: null, location: j.location?.name ?? null,
          remote: /remote/i.test(j.location?.name ?? "") || null, department: null, publishedAt: iso(j.first_published ?? j.updated_at),
        })),
      };
    }
    case "lever": {
      const d = await get(`https://api.lever.co/v0/postings/${s}?mode=json`);
      if (!d || !Array.isArray(d)) return null;
      return {
        name: null,
        postings: d.map((j: any) => ({
          id: j.id, title: j.text, url: j.hostedUrl, applyUrl: j.applyUrl ?? null, location: j.categories?.location ?? null,
          remote: j.workplaceType ? j.workplaceType === "remote" : null, department: j.categories?.team ?? j.categories?.department ?? null,
          publishedAt: iso(j.createdAt),
        })),
      };
    }
    case "ashby": {
      const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${s}`);
      if (!d) return null;
      return {
        name: null,
        postings: (d.jobs ?? []).filter((j: any) => j.isListed !== false).map((j: any) => ({
          id: j.id, title: j.title, url: j.jobUrl, applyUrl: j.applyUrl ?? null, location: j.location ?? null,
          remote: typeof j.isRemote === "boolean" ? j.isRemote : null, department: j.department ?? null, publishedAt: iso(j.publishedAt),
        })),
      };
    }
    case "workable": {
      const d = await get(`https://apply.workable.com/api/v1/widget/accounts/${s}`);
      if (!d || !Array.isArray(d.jobs)) return null;
      return {
        name: d.name ?? null,
        postings: d.jobs.map((j: any) => ({
          id: j.shortcode, title: j.title, url: j.shortlink ?? j.url, applyUrl: j.application_url ?? null,
          location: [j.city, j.country].filter(Boolean).join(", ") || null, remote: typeof j.telecommuting === "boolean" ? j.telecommuting : null,
          department: j.department || null, publishedAt: iso(j.published_on ?? j.created_at),
        })),
      };
    }
    case "smartrecruiters": {
      const postings: Posting[] = [];
      let name: string | null = null;
      for (let offset = 0; offset < 1000; offset += 100) {
        const d = await get(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100&offset=${offset}`);
        if (!d) return null;
        for (const j of d.content ?? []) {
          name ??= j.company?.name ?? null;
          postings.push({
            id: String(j.id), title: j.name, url: `https://jobs.smartrecruiters.com/${b.slug}/${j.id}`, applyUrl: null,
            location: [j.location?.city, j.location?.country].filter(Boolean).join(", ") || null,
            remote: typeof j.location?.remote === "boolean" ? j.location.remote : null, department: j.department?.label ?? null,
            publishedAt: iso(j.releasedDate),
          });
        }
        if ((d.content ?? []).length < 100) break;
      }
      // An unknown company answers with an empty list rather than 404.
      return postings.length || name ? { name, postings } : null;
    }
    case "recruitee": {
      const d = await get(`https://${s}.recruitee.com/api/offers/`);
      if (!d || !Array.isArray(d.offers)) return null;
      return {
        name: null,
        postings: d.offers.filter((j: any) => !j.status || j.status === "published").map((j: any) => ({
          id: String(j.id), title: j.title, url: j.careers_url, applyUrl: j.careers_apply_url ?? null, location: j.location ?? null,
          remote: typeof j.remote === "boolean" ? j.remote : null, department: j.department ?? null, publishedAt: iso(j.published_at ?? j.created_at),
        })),
      };
    }
  }
}

/** Likely board names for a company: "Arize AI" → arizeai, arize-ai, arize. */
export function slugGuesses(name: string): string[] {
  const words = name.toLowerCase().replace(/\(.*?\)/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const core = words.filter((w) => !/^(inc|llc|ltd|limited|corp|co|gmbh|the)$/.test(w));
  // The first word alone only when the rest is generic: "Arize AI" → arize, but "Applied
  // Materials" is not "applied" (that's another company).
  const generic = core.slice(1).every((w) => /^(ai|labs?|hq|app|io|inc|technologies|technology|tech|global|software|systems|group|com)$/.test(w));
  return [...new Set([core.join(""), core.join("-"), generic ? core[0] : "", words.join("")].filter((s) => s && s.length >= 2))];
}

/**
 * A guessed board must carry the company's full name when the board says its name ("Leap Motion"
 * isn't "Leap"). Lever and Ashby don't give a name, so those guesses rest on having open roles.
 */
const namesMatch = (a: string | null, b: string) => {
  if (!a) return true;
  const squash = (x: string) => normalise(x).replace(/ /g, "");
  return squash(a) === squash(b);
};

/** `named`: the board itself gave a name and it matched (Greenhouse, Workable, SmartRecruiters do). */
export interface Found { board: Board | null; careersUrl: string | null; via: string; open: number; named?: boolean; titles?: string[] }

/**
 * Finds a company's job board: from a link I gave (a board, posting or careers page), then by
 * trying the usual board names, then with one web search. Never throws.
 */
export async function findBoard(name: string, link: string | null, f: Fetch = fetch, opts: { search?: boolean } = {}): Promise<Found> {
  const tryBoard = async (b: Board, via: string): Promise<Found | null> => {
    const r = await readBoard(b, f).catch(() => null);
    return r && namesMatch(r.name, name) ? { board: b, careersUrl: link, via, open: r.postings.length, named: !!r.name, titles: r.postings.map((p) => p.title) } : null;
  };
  const fromPage = async (url: string): Promise<Board | null> => {
    const direct = parseBoard(url);
    if (direct) return direct;
    try {
      const res = await f(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      return parseBoard(res.url) ?? parseBoard(await res.text());
    } catch { return null; }
  };

  if (link) {
    const b = await fromPage(link);
    if (b) {
      const r = await readBoard(b, f).catch(() => null);
      if (r) return { board: b, careersUrl: link, via: "your link", open: r.postings.length, titles: r.postings.map((p) => p.title) };
    }
  }
  // An empty board under a guessed name is likely someone else's: only one with postings counts.
  for (const slug of slugGuesses(name)) {
    for (const type of ["greenhouse", "ashby", "lever", "workable"] as BoardType[]) {
      const hit = await tryBoard({ type, slug }, "its name");
      if (hit && hit.open > 0) return hit;
    }
  }
  if (opts.search !== false && firecrawlAvailable()) {
    try {
      const results = await firecrawlSearch(`${name} careers jobs`, { limit: 5, label: `company:${name}` });
      for (const r of results) {
        const b = parseBoard(r.url) ?? (r.url.match(/career|jobs|join/i) ? await fromPage(r.url) : null);
        if (b) {
          const hit = await tryBoard(b, "a web search");
          if (hit) return { ...hit, careersUrl: link ?? r.url };
        }
      }
      const careers = results.find((r) => /career|jobs|join-us|work-with-us/i.test(r.url) && sameCompany(new URL(r.url).hostname.split(".").slice(-2, -1)[0] ?? "", name));
      if (careers && !link) return { board: null, careersUrl: careers.url, via: "a web search", open: 0 };
    } catch { /* search is optional */ }
  }
  return { board: null, careersUrl: link, via: "nothing", open: 0 };
}

// ---------- Companies ----------

export const getCompany = (id: number) => get<Company>("SELECT * FROM companies WHERE id = $id", { id });
export const listCompanies = () => all<Company>("SELECT * FROM companies ORDER BY status, lower(name)");
export const findCompanyByName = (name: string) => listCompanies().find((c) => normalise(c.name) === normalise(name) || sameCompany(c.name, name));

/**
 * Adds a target company (or updates the link of one already there) and finds its board. With no
 * board, a careers page I gave is watched as a page instead; with neither, it waits for a link.
 */
export async function addCompany(name: string, link: string | null, opts: { via?: string; intervalHours?: number; fetch?: Fetch } = {}): Promise<{ company: Company; isNew: boolean; found: Found }> {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Give the company's name.");
  const url = link?.trim() ? (/^https?:\/\//i.test(link.trim()) ? link.trim() : `https://${link.trim()}`) : null;
  const existing = findCompanyByName(clean);
  const found = await findBoard(clean, url ?? existing?.careers_url ?? null, opts.fetch ?? fetch);
  let sourceId: number | null = existing?.source_id ?? null;
  if (!found.board && found.careersUrl && !sourceId) {
    sourceId = addSource(found.careersUrl, { label: clean, intervalHours: 6, via: opts.via ?? "companies" }).source.id;
  }
  if (existing) {
    run(`UPDATE companies SET board_type = coalesce($t, board_type), board_slug = coalesce($s, board_slug),
           careers_url = coalesce($u, careers_url), source_id = $src, status = 'active', needs_check = 0, last_error = NULL, fail_count = 0,
           seen_ids = CASE WHEN $t IS NOT NULL AND ($t != coalesce(board_type, '') OR $s != coalesce(board_slug, '')) THEN '[]' ELSE seen_ids END WHERE id = $id`,
    { id: existing.id, t: found.board?.type ?? null, s: found.board?.slug ?? null, u: found.careersUrl, src: sourceId });
    return { company: getCompany(existing.id)!, isNew: false, found };
  }
  run(
    `INSERT INTO companies (name, board_type, board_slug, careers_url, source_id, interval_hours, added_via)
     VALUES ($name, $t, $s, $u, $src, $int, $via)`,
    { name: clean, t: found.board?.type ?? null, s: found.board?.slug ?? null, u: found.careersUrl, src: sourceId,
      int: Math.min(Math.max(opts.intervalHours ?? 3, 1), 48), via: opts.via ?? null },
  );
  const company = get<Company>("SELECT * FROM companies WHERE id = last_insert_rowid()")!;
  logEvent("company.added", company.id, { name: clean, board: found.board, via: found.via });
  return { company, isNew: true, found };
}

export function setCompanyStatus(id: number, status: "active" | "paused") {
  // Resuming a guessed board is saying it's the right company.
  run(`UPDATE companies SET status = $status, fail_count = CASE WHEN $status = 'active' THEN 0 ELSE fail_count END,
         needs_check = CASE WHEN $status = 'active' THEN 0 ELSE needs_check END WHERE id = $id`, { id, status });
}

/** Stops watching. Roles already found stay, and so does a careers page watched for it. */
export function removeCompany(id: number) {
  const c = getCompany(id);
  run("DELETE FROM companies WHERE id = $id", { id });
  // Removed by hand: never added back automatically.
  if (c) kvSet(DISMISSED, JSON.stringify([...new Set([...dismissed(), squash(c.name)])]));
  logEvent("company.removed", id);
}

// ---------- Filled in from the tracker ----------

const DISMISSED = "companies.dismissed";
const squash = (x: string) => normalise(cleanCompanyName(x)).replace(/ /g, "");
const dismissed = (): string[] => { try { return JSON.parse(kvGet(DISMISSED) ?? "[]"); } catch { return []; } };

/** The company's own name, without the tracker's notes: "Factory (relocation: US)" → "Factory". */
export function cleanCompanyName(name: string): string {
  return name.replace(/\s*\(.*$/, "").replace(/,\s*(?:a|an)\s.*$/i, "").replace(/,?\s+(?:inc|llc|ltd|limited|corp)\.?$/i, "").trim();
}

/** Statuses that show I wanted to work there: decided, applied, in process, or turned down. */
const INTERESTED = ["decide", "ready", "applied", "interviewing", "offer", "rejected"];
const NOT_A_COMPANY = /^(unknown|confidential|undisclosed|stealth|n\/?a|we love ai jobs)\b/i;

/** Companies from my roles that aren't watched yet, each with the links its roles carry. */
export function candidateCompanies(): { name: string; links: string[] }[] {
  const rows = all<{ company: string; apply_url: string | null; source_url: string | null }>(
    `SELECT company, apply_url, source_url FROM opportunities
     WHERE status IN (${INTERESTED.map((s) => `'${s}'`).join(",")}) OR (saved_on_linkedin = 1 AND status NOT IN ('skipped', 'dropped'))
     ORDER BY updated_at DESC`,
  );
  const gone = new Set(dismissed());
  const out: { name: string; links: string[] }[] = [];
  for (const r of rows) {
    const name = cleanCompanyName(r.company);
    if (!name || NOT_A_COMPANY.test(name) || gone.has(squash(name)) || findCompanyByName(name)) continue;
    const links = [r.apply_url, r.source_url].filter((l): l is string => !!l && /^https?:\/\//.test(l));
    const known = out.find((c) => squash(c.name) === squash(name) || sameCompany(c.name, name));
    if (known) known.links.push(...links.filter((l) => !known.links.includes(l)));
    else out.push({ name, links });
  }
  return out;
}

/** A role link that can lead to the board: a board link first, then the company's own site (not a job site or social post). */
function bestLink(links: string[]): string | null {
  return links.find((l) => parseBoard(l))
    ?? links.find((l) => !/linkedin\.com|x\.com|twitter\.com|forms\.gle|google\.com|jobleads|talent\.superteam|turbohire|whatsapp/i.test(l))
    ?? null;
}

/**
 * Adds every company from my roles that isn't watched yet. Their boards start from what's open
 * now, so only roles posted from here on are screened: the open ones are roles I already have
 * or passed on. A company I removed by hand is never added back.
 */
export async function autoAddCompanies(f: Fetch = fetch, opts: { limit?: number } = {}): Promise<{ added: string[]; toCheck: string[]; noBoard: string[] }> {
  const out = { added: [] as string[], toCheck: [] as string[], noBoard: [] as string[] };
  for (const c of candidateCompanies().slice(0, opts.limit ?? 40)) {
    const found = await findBoard(c.name, bestLink(c.links), f, { search: false });
    const board = found.board ? await readBoard(found.board, f).catch(() => null) : null;
    // A board guessed from a name ("Leap") may be another company's. It's trusted when it came
    // from a role's own link, gave the same name, or lists a role I track there; otherwise it
    // waits, paused, for me to confirm it.
    // Same title, ignoring punctuation and a trailing team or place ("Associate Project Manager – Product – India").
    const title = (x: string) => normalise(x.replace(/\(.*?\)/g, " "));
    const mine = opportunitiesAtCompany(c.name).map((o) => title(o.role)).filter((x) => x.length > 3);
    const confirmed = !found.board || found.via === "your link" || found.named
      || (board?.postings ?? []).some((p) => mine.some((r) => title(p.title) === r || title(p.title).startsWith(r + " ")));
    run(
      `INSERT INTO companies (name, board_type, board_slug, careers_url, added_via, seen_ids, open_count, last_scanned_at, last_result, status, needs_check)
       VALUES ($name, $t, $s, $u, 'auto', $seen, $open, $at, $res, $status, $check)`,
      {
        status: confirmed ? "active" : "paused", check: confirmed ? 0 : 1,
        name: c.name, t: found.board?.type ?? null, s: found.board?.slug ?? null,
        u: found.careersUrl && !parseBoard(found.careersUrl) ? found.careersUrl : null,
        seen: JSON.stringify(board?.postings.map((p) => p.id) ?? []), open: board?.postings.length ?? null,
        at: board ? nowIso() : null,
        res: board ? JSON.stringify({ postings: board.postings.length, newPostings: 0, matches: 0, deferred: 0 }) : null,
      },
    );
    (!found.board ? out.noBoard : confirmed ? out.added : out.toCheck).push(c.name);
  }
  if (out.added.length || out.toCheck.length || out.noBoard.length) logEvent("companies.auto", null, out);
  return out;
}

/** Lines like "Stripe", "Factory | https://jobs.ashbyhq.com/factory" or "Exa, exa.ai/careers". */
export function parseCompanyLines(text: string): { name: string; link: string | null }[] {
  return text.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const url = line.match(/https?:\/\/\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/i)?.[0] ?? null;
    const name = (url ? line.replace(url, "") : line).replace(/[|,;·–—-]+\s*$/, "").replace(/^\s*[-*•\d.)]+\s*/, "").trim();
    return { name: name || (url ? new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname.replace(/^www\.|^jobs\.|^careers\./, "").split(".")[0] : ""), link: url };
  }).filter((x) => x.name);
}

// ---------- Scanning ----------

const Screened = z.object({
  results: z.array(z.object({
    id: z.string(),
    relevance: z.enum(["high", "medium", "low"]),
  })),
});

const SCREEN_RULES = `These are open roles at a company I want to work at. For each id, say how well the role fits my target role families and location rules:
- "high": one of my target role families, in a location the playbook allows (remote or a place I can work).
- "medium": adjacent to my targets, or the location is unclear.
- "low": anything else (engineering, sales, finance and so on, unless it's in my targets) or a location ruled out.
Answer for every id given.`;

/** Screens new postings against my targets. Titles and locations only, in batches. */
export async function screenPostings(company: string, postings: Posting[]): Promise<Map<string, "high" | "medium" | "low">> {
  const out = new Map<string, "high" | "medium" | "low">();
  for (let i = 0; i < postings.length; i += 120) {
    const batch = postings.slice(i, i + 120);
    const { results } = await llm.structured(`company.screen:${company}`, Screened, {
      effort: "low", numCtx: 16384, maxTokens: 8000,
      system: `${screenerSystem()}\n\n${SCREEN_RULES}`,
      prompt: `Company: ${company}\n\n${batch.map((p) => `${p.id} | ${p.title} | ${p.location ?? "location not given"}${p.remote ? " | remote" : ""}${p.department ? ` | ${p.department}` : ""}`).join("\n")}`,
    });
    for (const r of results) out.set(r.id, r.relevance);
  }
  return out;
}

/**
 * Reads a company's board and files the postings it hasn't screened before. Ones that fit are
 * added as roles and queued for a summary, like any job alert. Safe to run again.
 */
export async function scanCompany(id: number, deps: { fetch?: Fetch; screen?: typeof screenPostings } = {}): Promise<CompanyScan> {
  const c = getCompany(id);
  if (!c) throw new Error("No such company");
  if (!c.board_type || !c.board_slug) throw new Error(c.source_id ? "Watched as a careers page instead." : "No job board found yet. Add its careers page link.");
  const screen = deps.screen ?? screenPostings;
  try {
    const board = await readBoard({ type: c.board_type, slug: c.board_slug }, deps.fetch);
    if (!board) throw new Error(`The ${BOARD_LABEL[c.board_type]} board "${c.board_slug}" no longer exists. Add the careers page link again.`);
    const seen = new Set<string>(JSON.parse(c.seen_ids));
    const fresh = board.postings.filter((p) => p.id && p.title && !seen.has(p.id));
    const result: CompanyScan = { postings: board.postings.length, newPostings: fresh.length, matches: 0, deferred: 0, newOpportunityIds: [] };
    const relevance = fresh.length ? await screen(c.name, fresh) : new Map();
    const deferred = new Set<string>();
    for (const p of fresh) {
      const r = relevance.get(p.id) ?? "low";
      if (r === "low") continue;
      if (result.matches >= MAX_NEW_PER_SCAN) { deferred.add(p.id); result.deferred++; continue; }
      // A role I already track keeps its own source and links: a same-titled posting on the
      // board may be a different opening (another region), and the first source is the true one.
      if (findOpportunity(c.name, p.title)) continue;
      const posted = p.publishedAt ? `Posted ${p.publishedAt.slice(0, 10)}` : null;
      const { opportunity, isNew } = addOpportunity(c.name, p.title, {
        source: `company:${c.name}`,
        source_url: p.url,
        apply_url: p.applyUrl,
        jd_text: [`On ${c.name}'s ${BOARD_LABEL[c.board_type]} board`, [p.location, p.remote ? "remote" : null, p.department, posted].filter(Boolean).join(" · ")].join("\n"),
      }, r);
      if (isNew) { result.matches++; result.newOpportunityIds.push(opportunity.id); }
    }
    // Screened postings are remembered (capped); ones over the cap are read again next scan.
    const remembered = [...new Set([...board.postings.map((p) => p.id).filter((x) => !deferred.has(x)), ...seen])].slice(0, 5000);
    run(
      `UPDATE companies SET seen_ids = $seen, open_count = $open, last_scanned_at = $now, last_result = $res, last_error = NULL, fail_count = 0 WHERE id = $id`,
      { id, seen: JSON.stringify(remembered), open: board.postings.length, now: nowIso(), res: JSON.stringify({ ...result, newOpportunityIds: undefined }) },
    );
    logEvent("company.scan", id, result);
    return result;
  } catch (err) {
    run("UPDATE companies SET last_scanned_at = $now, last_error = $err, fail_count = fail_count + 1 WHERE id = $id", {
      id, now: nowIso(), err: String(err instanceof Error ? err.message : err).slice(0, 300),
    });
    logEvent("company.scan_failed", id, String(err));
    throw err;
  }
}

/** Companies with a board whose timer is up. Failures back off, up to a day. */
export function dueCompanies(now = new Date()): Company[] {
  return listCompanies().filter((c) => c.status === "active" && c.board_type
    && (!c.last_scanned_at || now.getTime() - new Date(c.last_scanned_at).getTime() >= c.interval_hours * 3600_000
      * (c.fail_count ? Math.max(1, Math.min(2 ** (c.fail_count - 1), 24 / c.interval_hours)) : 1)));
}

export function describeCompanyScan(r: CompanyScan): string {
  if (!r.postings) return "no open roles";
  return `${r.postings} open, ${r.newPostings} new, ${r.matches} match${r.matches === 1 ? "" : "es"}` + (r.deferred ? ` (${r.deferred} more next scan)` : "");
}

/** People I already know at a company, from any role there: for a warmer first touch. */
export function knownPeopleAt(company: string): { name: string; how: string }[] {
  const rows = all<{ name: string; company: string; status: string; via: string }>(
    `SELECT c.name, o.company, coalesce(r.status, 'email') AS status, 'outreach' AS via FROM outreach r JOIN contacts c ON c.id = r.contact_id JOIN opportunities o ON o.id = r.opportunity_id
       WHERE r.status IN ('note_sent', 'dm_sent', 'replied', 'conversation')
     UNION SELECT c.name, o.company, t.last_from, 'thread' FROM threads t JOIN contacts c ON c.id = t.contact_id JOIN opportunities o ON o.id = t.opportunity_id
       WHERE t.kind = 'conversation'`,
  );
  const seen = new Set<string>();
  return rows.filter((r) => sameCompany(r.company, company) && !seen.has(r.name) && seen.add(r.name))
    .map((r) => ({ name: r.name, how: r.status === "replied" || r.status === "conversation" || r.status === "them" ? "you've talked" : "you reached out" }));
}

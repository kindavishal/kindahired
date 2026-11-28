import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { LINKEDIN_LIMITS, PATHS, searchTerms, TIMEZONE } from "../config.ts";
import { kvGet, kvSet, logEvent } from "../db/index.ts";
import { roleTokens } from "../db/opportunities.ts";

/**
 * LinkedIn, through a browser profile I logged into myself. Read-only: it never clicks
 * connect, message, apply or save. It moves at a person's pace and stops at a daily cap.
 */

export class LinkedInUnavailable extends Error {}

const LOCK = path.join(PATHS.browserProfile, "..", "browser.lock");
const SESSION = path.join(PATHS.browserProfile, "..", "linkedin-session.json");
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () =>
  sleep(LINKEDIN_LIMITS.minDelayMs + Math.random() * (LINKEDIN_LIMITS.maxDelayMs - LINKEDIN_LIMITS.minDelayMs));

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// One browser at a time in this process: the profile folder can only be opened once.
let browserQueue: Promise<unknown> = Promise.resolve();
export function withBrowser<T>(fn: (ctx: BrowserContext) => Promise<T>, opts: { headless?: boolean } = {}): Promise<T> {
  const next = browserQueue.then(() => openBrowser(fn, opts));
  browserQueue = next.catch(() => {});
  return next;
}

async function openBrowser<T>(fn: (ctx: BrowserContext) => Promise<T>, opts: { headless?: boolean } = {}): Promise<T> {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8"));
    if (pid && pid !== process.pid && pidAlive(pid)) throw new LinkedInUnavailable("LinkedIn is busy with another check. It tries again soon.");
  }
  writeFileSync(LOCK, String(process.pid));
  // The same full browser for the visible login window and the background runs, so both read the
  // same cookies, and a normal browser identity instead of "HeadlessChrome".
  const ctx = await chromium.launchPersistentContext(PATHS.browserProfile, {
    channel: "chromium",
    headless: opts.headless ?? true,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: TIMEZONE,
    userAgent: USER_AGENT,
  });
  // A saved copy of the login, in case the profile's own cookie store can't be read.
  if (existsSync(SESSION)) {
    const { cookies } = JSON.parse(readFileSync(SESSION, "utf8")) as { cookies: Parameters<BrowserContext["addCookies"]>[0] };
    const have = await ctx.cookies("https://www.linkedin.com");
    if (!have.some((c) => c.name === "li_at")) await ctx.addCookies(cookies);
  }
  try {
    return await fn(ctx);
  } finally {
    // Keep the saved copy fresh: LinkedIn rotates its cookies.
    const fresh = await ctx.cookies("https://www.linkedin.com").catch(() => []);
    if (fresh.some((c) => c.name === "li_at")) writeFileSync(SESSION, JSON.stringify({ cookies: fresh }), { mode: 0o600 });
    await ctx.close();
    rmSync(LOCK, { force: true });
  }
}

export async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await pause();
  if (/\/(login|authwall|checkpoint|uas\/login)/.test(page.url())) {
    throw new LinkedInUnavailable("LinkedIn is logged out. Run: npm run jh -- linkedin:login");
  }
}

async function scrollToEnd(page: Page, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 2500);
    await sleep(800 + Math.random() * 700);
  }
}

/** Opens a visible browser so I can log in once. The session is kept in the profile folder. */
export async function linkedinLogin(): Promise<void> {
  await withBrowser(async (ctx) => {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://www.linkedin.com/login");
    console.log("Log in to LinkedIn in the window that opened. I'll wait up to 5 minutes.");
    // Logged in means LinkedIn has issued its session cookie, not just that the URL changed.
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if ((await ctx.cookies("https://www.linkedin.com")).some((c) => c.name === "li_at")) break;
      await sleep(2000);
    }
    const cookies = await ctx.cookies("https://www.linkedin.com");
    if (!cookies.some((c) => c.name === "li_at")) throw new Error("Didn't see a LinkedIn login within 5 minutes. Try again.");
    writeFileSync(SESSION, JSON.stringify({ cookies }), { mode: 0o600 });
    console.log("Logged in and saved. The window will close by itself.");
    await sleep(3000);
  }, { headless: false });
}

// ---------- Saved and applied jobs ----------

export interface SavedJob {
  jobId: string;
  url: string;
  title: string;
  company: string;
  location: string | null;
  meta: string[]; // lines like "Posted 2w ago", "Applied 3d ago", "No longer accepting applications"
}

/**
 * Reads the job cards on the current page. Each card is the largest block around a job link that
 * holds no other job; it's parsed by its text ("Title", "Company · Location", "Posted 2w ago"),
 * not by CSS classes, so small layout changes don't break it.
 */
async function readJobCards(page: Page): Promise<SavedJob[]> {
  // Passed as a string so the build adds nothing the page doesn't have. Each card's text is read
  // piece by piece, because the background browser doesn't put line breaks between them.
  const raw = (await page.evaluate(`(() => {
    const out = [];
    const seen = new Set();
    const idOf = (el) => (el.href.match(/\\/jobs\\/view\\/(\\d+)/) || [])[1];
    for (const a of Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'))) {
      const id = idOf(a);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let card = a;
      while (card.parentElement && new Set(Array.from(card.parentElement.querySelectorAll('a[href*="/jobs/view/"]')).map(idOf)).size <= 1) card = card.parentElement;
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      const lines = [];
      let node;
      while ((node = walker.nextNode())) { const t = node.textContent.trim(); if (t) lines.push(t); }
      out.push({ jobId: id, lines });
    }
    return out;
  })()`)) as { jobId: string; lines: string[] }[];
  return raw.map(({ jobId, lines }) => {
    const clean = lines.filter((l) => !/^(notes|add note|apply|easy apply|unsave|archive|delete|·|promoted|verified|did you hear back\?|yes|no)$/i.test(l));
    const title = (clean[0] ?? "").replace(/\s*\(verified job\)\s*$/i, "").trim();
    const companyLine = clean.find((l) => l.includes(" · ")) ?? clean[1] ?? "";
    const [company = "", location = null] = companyLine.split(" · ").map((x) => x.trim());
    const meta = clean.filter((l) => l !== clean[0] && l !== companyLine && l !== title);
    return { jobId, url: `https://www.linkedin.com/jobs/view/${jobId}/`, title, company, location, meta };
  }).filter((j) => j.title && j.company);
}

type Tab = "Saved" | "In Progress" | "Applied";

/** Opens one tab of the Job tracker and reads its cards, scrolling to load more. */
async function readTrackerTab(ctx: BrowserContext, tab: Tab, maxScrolls: number): Promise<SavedJob[]> {
  const page = await ctx.newPage();
  await open(page, "https://www.linkedin.com/jobs-tracker/");
  // The tab is the label; other elements carrying the same text are info buttons.
  const button = page.locator("label").filter({ hasText: new RegExp(`^\\s*${tab}\\s*·\\s*\\d+\\s*$`) }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await pause();
  } else if (tab !== "Saved") {
    logEvent("linkedin.tab_missing", tab);
    await page.close();
    return [];
  }
  const all = new Map<string, SavedJob>();
  for (let i = 0; i <= maxScrolls; i++) {
    const before = all.size;
    for (const c of await readJobCards(page)) all.set(c.jobId, c);
    if (i > 0 && all.size === before) {
      // Some lists load more with a button rather than on scroll.
      const more = page.getByRole("button", { name: /show more|load more|see more/i }).first();
      if (!(await more.isVisible().catch(() => false))) break;
      await more.click().catch(() => {});
    }
    await scrollToEnd(page, 2);
  }
  await page.close();
  return [...all.values()];
}

export async function syncLinkedInJobs(): Promise<{ saved: SavedJob[]; applied: SavedJob[] }> {
  return withBrowser(async (ctx) => {
    // LinkedIn's "In Progress" tab doesn't open its list for an automated browser, so it's not read.
    const saved = await readTrackerTab(ctx, "Saved", 10);
    // Applied can run to hundreds; the most recent ones are enough to keep statuses current.
    const applied = await readTrackerTab(ctx, "Applied", 4);
    logEvent("linkedin.jobs", null, { saved: saved.length, applied: applied.length });
    return { saved, applied };
  });
}

/** The job description and whether it's still taking applications. */
/** LinkedIn's wording on a job that's closed. It has said both "No longer accepting applications" and "Not currently accepting applications". */
export const LINKEDIN_CLOSED = /(?:no longer|not currently) accepting applications/i;

export async function readLinkedInJob(jobId: string): Promise<{ text: string; closed: boolean }> {
  return withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await open(page, `https://www.linkedin.com/jobs/view/${jobId}/`);
    const more = page.getByRole("button", { name: /see more|show more/i }).first();
    if (await more.isVisible().catch(() => false)) await more.click().catch(() => {});
    // Text piece by piece (the background browser drops line breaks from innerText).
    const text = String(await page.evaluate(`(() => {
      const root = document.querySelector("main") || document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const parts = [];
      let node;
      while ((node = walker.nextNode())) { const t = node.textContent.trim(); if (t) parts.push(t); }
      return parts.join("\\n");
    })()`).catch(() => ""));
    return { text: text.slice(0, 15000), closed: LINKEDIN_CLOSED.test(text) };
  });
}

// ---------- Messages ----------

export interface InboxEntry { index: number; name: string; snippet: string; fromMe: boolean; unread: boolean }
export interface LinkedInMessage { id: string; fromMe: boolean; sender: string; at: string; body: string }
export interface LinkedInConversation extends InboxEntry { threadId: string; url: string; messages: LinkedInMessage[] }

/**
 * A message's time, from its ID: the part after "2-" is base64 for "<epoch ms><suffix>". The
 * page only shows "THURSDAY 2:51 PM", which can't be read back into a date reliably.
 */
export function messageTime(urn: string): string | null {
  const part = urn.match(/,2-([A-Za-z0-9+/=]+)\)?$/)?.[1];
  if (!part) return null;
  const ms = Buffer.from(part, "base64").toString("latin1").match(/^(\d{13})/)?.[1];
  return ms ? new Date(Number(ms)).toISOString() : null;
}

/**
 * Reads the messaging inbox, then opens the conversations `shouldOpen` picks (at most
 * `maxOpen`), at a person's pace. Read-only: nothing is typed or sent, and opening a
 * conversation is the only click. Conversations it doesn't pick are never opened.
 */
export async function readLinkedInInbox(opts: { maxList?: number; maxOpen?: number; shouldOpen: (e: InboxEntry) => boolean }): Promise<{ inbox: InboxEntry[]; opened: LinkedInConversation[] }> {
  return withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await open(page, "https://www.linkedin.com/messaging/");
    await page.waitForSelector("li.msg-conversation-listitem", { timeout: 20_000 }).catch(() => {});
    const inbox = (await page.evaluate(`(() => Array.from(document.querySelectorAll('li.msg-conversation-listitem')).slice(0, ${opts.maxList ?? 25}).map((li, index) => {
      const pick = (sel) => ((li.querySelector(sel) || {}).innerText || '').trim();
      const name = pick('.msg-conversation-listitem__participant-names') || ((li.querySelector('img[alt]') || {}).alt || '');
      const snippet = pick('.msg-conversation-card__message-snippet') || pick('[class*="message-snippet"]');
      const unread = !!li.querySelector('[class*="--unread"], .notification-badge--show');
      return { index, name: name.replace(/\\s+/g, ' '), snippet: snippet.replace(/\\s+/g, ' '), unread };
    }))()`)) as Omit<InboxEntry, "fromMe">[];
    const entries: InboxEntry[] = inbox.filter((e) => e.name).map((e) => ({
      ...e, fromMe: /^you:/i.test(e.snippet), snippet: e.snippet.replace(/^you:\s*/i, ""),
    }));

    const opened: LinkedInConversation[] = [];
    for (const e of entries.filter(opts.shouldOpen).slice(0, opts.maxOpen ?? 8)) {
      const item = page.locator("li.msg-conversation-listitem").nth(e.index);
      await item.locator(".msg-conversation-listitem__link").first().click().catch(() => item.click());
      await page.waitForURL(/\/messaging\/thread\//, { timeout: 15_000 }).catch(() => {});
      await page.waitForSelector("li.msg-s-message-list__event", { timeout: 15_000 }).catch(() => {});
      await pause();
      const raw = (await page.evaluate(`(() => {
        let sender = '';
        return Array.from(document.querySelectorAll('li.msg-s-message-list__event')).map((li) => {
          const ev = li.querySelector('[data-event-urn]');
          const name = ((li.querySelector('.msg-s-message-group__name') || {}).innerText || '').trim();
          if (name) sender = name;
          return {
            id: ev ? ev.getAttribute('data-event-urn') : '',
            other: !!li.querySelector('.msg-s-event-listitem--other'),
            sender,
            body: ((li.querySelector('.msg-s-event-listitem__body') || {}).innerText || '').trim(),
          };
        });
      })()`)) as { id: string; other: boolean; sender: string; body: string }[];
      const messages = raw
        .map((m) => ({ id: m.id, fromMe: !m.other, sender: m.sender, at: messageTime(m.id) ?? "", body: m.body }))
        .filter((m) => m.id && m.at && m.body);
      const url = page.url().split("?")[0];
      const threadId = url.match(/\/messaging\/thread\/([^/]+)/)?.[1];
      if (threadId && messages.length) opened.push({ ...e, threadId, url, messages });
    }
    await page.close();
    logEvent("linkedin.inbox", null, { listed: entries.length, opened: opened.length });
    return { inbox: entries, opened };
  });
}

// ---------- People ----------

export interface PersonCandidate {
  name: string;
  headline: string;
  location: string | null;
  degree: string | null;
  url: string;
  recentPosts: string[];
}

function budgetLeft(): number {
  const today = new Date().toISOString().slice(0, 10);
  const [day, used] = (kvGet("linkedin.visits") ?? "").split(":");
  return LINKEDIN_LIMITS.profileVisitsPerDay - (day === today ? Number(used) : 0);
}
function spendBudget(n: number) {
  const today = new Date().toISOString().slice(0, 10);
  const [day, used] = (kvGet("linkedin.visits") ?? "").split(":");
  kvSet("linkedin.visits", `${today}:${(day === today ? Number(used) : 0) + n}`);
}

/** People-search words for a role: the target terms it matches, else the role's own title. */
function roleKeywords(role: string): string[] {
  const words = roleTokens(role);
  const hits = searchTerms().filter((t) => [...roleTokens(t)].every((w) => words.has(w))).slice(0, 2);
  return [...(hits.length ? hits : [role.split(/[,(]/)[0].trim()]), "hiring", "founder"];
}

/**
 * Searches people at the company, keeps those whose headline names the company, and reads the
 * recent posts of the most relevant few. Visits are capped per pack and per day.
 */
export async function findPeopleOnLinkedIn(company: string, role: string): Promise<PersonCandidate[]> {
  if (!existsSync(PATHS.browserProfile)) throw new LinkedInUnavailable("LinkedIn isn't set up. Run: npm run jh -- linkedin:login");
  if (budgetLeft() <= 0) throw new LinkedInUnavailable("It reached today's LinkedIn visit limit, which keeps your account safe. It carries on tomorrow.");
  const companyKey = company.replace(/\(.*?\)/g, "").trim().toLowerCase().split(/\s+/)[0];

  return withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const found = new Map<string, PersonCandidate>();
    for (const kw of roleKeywords(role)) {
      if (found.size >= 10) break;
      await open(page, `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${company.replace(/\(.*?\)/g, "")} ${kw}`)}`);
      const people = await page.evaluate(() => {
        const out: { url: string; lines: string[] }[] = [];
        const seen = new Set<string>();
        for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'))) {
          const url = a.href.split("?")[0];
          if (seen.has(url) || !/\/in\/[^/]+\/?$/.test(url)) continue;
          seen.add(url);
          const card = a.closest("li");
          if (!card) continue;
          out.push({ url, lines: (card as HTMLElement).innerText.split("\n").map((s) => s.trim()).filter(Boolean) });
        }
        return out;
      });
      for (const p of people) {
        const lines = p.lines.filter((l, i) => p.lines.indexOf(l) === i && !/^(connect|message|follow|view .*profile|status is)/i.test(l));
        const name = lines[0]?.replace(/\s*•.*$/, "");
        const degree = lines.find((l) => /\b(1st|2nd|3rd\+?)\b/.test(l))?.match(/1st|2nd|3rd\+?/)?.[0] ?? null;
        const rest = lines.filter((l) => !/^•?\s*(1st|2nd|3rd\+?)/.test(l) && l !== lines[0]);
        const headline = rest[0] ?? "";
        if (!name || name === "LinkedIn Member") continue;
        if (!(headline + " " + rest.join(" ")).toLowerCase().includes(companyKey)) continue;
        found.set(p.url, { name, headline, location: rest[1] ?? null, degree, url: p.url, recentPosts: [] });
      }
    }

    const toVisit = [...found.values()].slice(0, Math.min(LINKEDIN_LIMITS.profileVisitsPerPack, budgetLeft()));
    for (const person of toVisit) {
      await open(page, person.url.replace(/\/?$/, "/") + "recent-activity/all/");
      await scrollToEnd(page, 2);
      person.recentPosts = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-urn*="activity"], div[data-id*="activity"]'));
        return nodes.slice(0, 3).map((n) => n.innerText.replace(/\s+/g, " ").slice(0, 600));
      });
      spendBudget(1);
    }
    await page.close();
    logEvent("linkedin.people", company, { found: found.size, visited: toVisit.length });
    return toVisit.length ? toVisit : [...found.values()].slice(0, 6);
  });
}

/** One person's profile URL from a logged-in people search on name and company. Null if not found. */
export async function findProfileOnLinkedIn(name: string, company: string): Promise<string | null> {
  if (!existsSync(PATHS.browserProfile)) throw new LinkedInUnavailable("LinkedIn isn't set up.");
  const companyKey = company.replace(/\(.*?\)/g, "").trim().toLowerCase().split(/\s+/)[0];
  const surname = name.trim().split(/\s+/).pop()!.toLowerCase();
  return withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await open(page, `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${name} ${company.replace(/\(.*?\)/g, "")}`)}`);
    const cards = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')).map((a) => ({
        url: a.href.split("?")[0],
        text: ((a.closest("li") as HTMLElement | null)?.innerText ?? a.innerText).toLowerCase(),
      })));
    await page.close();
    const match = cards.find((c) => /\/in\/[^/]+\/?$/.test(c.url) && c.text.includes(surname) && c.text.includes(companyKey))
      ?? cards.find((c) => /\/in\/[^/]+\/?$/.test(c.url) && c.text.includes(surname));
    return match?.url ?? null;
  });
}

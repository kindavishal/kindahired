import { chromium } from "playwright";
import { htmlToText } from "../pipeline/evidence.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Pages that need my login. They're read through the LinkedIn session or not at all. */
export const NEEDS_LOGIN = /(^|\.)(linkedin\.com|x\.com|twitter\.com)$/i;
const needsLogin = (url: string) => {
  try { return NEEDS_LOGIN.test(new URL(url).hostname); } catch { return true; }
};

/**
 * Reads a public page as text. Plain download first (fast); if the page is built by JavaScript,
 * as most job boards are, it's opened in a background browser instead. Never used for LinkedIn.
 */
export async function readPage(url: string): Promise<{ url: string; text: string } | null> {
  if (needsLogin(url)) return null;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html")) {
      const text = htmlToText(await res.text());
      if (text.length > 1500) return { url: res.url, text: text.slice(0, 20000) };
    }
  } catch { /* try the browser */ }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
    const text = (await page.locator("body").innerText().catch(() => "")).trim();
    return text.length > 300 ? { url: page.url(), text: text.slice(0, 20000) } : null;
  } finally {
    await browser.close();
  }
}

/**
 * Reads a listing page (a job board, careers page or feed) as HTML, the way I'd see it. Opened in
 * a background browser and scrolled a few times, so boards that load more as you scroll show
 * their newer posts too. Falls back to a plain download if the browser can't start.
 */
export async function readListing(url: string, scrolls = 3): Promise<{ url: string; html: string }> {
  if (needsLogin(url)) throw new Error("That site needs a login, so it can't be watched. LinkedIn saved jobs are already synced.");
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`The page answered ${res.status}`);
    return { url: res.url, html: await res.text() };
  }
  try {
    const page = await browser.newPage({ userAgent: UA });
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => null);
    if (res && res.status() >= 400) throw new Error(`The page answered ${res.status()}`);
    for (let i = 0; i < scrolls; i++) {
      await page.mouse.wheel(0, 20_000);
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    return { url: page.url(), html: await page.content() };
  } finally {
    await browser.close();
  }
}

const decode = (s: string) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&middot;/g, "·").replace(/&rarr;/g, "→");

/**
 * Page text with each link's address kept next to its words, e.g. `Senior DevRel [/j/12 → https://site/j/12]`,
 * so the extraction step can say which link is which posting. Also returns every link on the page.
 */
export function htmlToLinkedText(html: string, base: string): { text: string; links: string[] } {
  const links = new Set<string>();
  const body = html.replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, " ");
  const withLinks = body.replace(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    let abs: string;
    try { abs = new URL(decode(href), base).href; } catch { return inner; }
    if (!/^https?:/.test(abs)) return inner;
    links.add(abs);
    const words = decode(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    return ` ${words} [→ ${abs}] `;
  });
  const text = decode(withLinks
    .replace(/<br\s*\/?>|<\/(p|li|h[1-6]|div|section|tr|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return { text, links: [...links] };
}

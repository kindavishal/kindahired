import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { PATHS } from "../config.ts";
import { kvGet, kvSet, logEvent } from "../db/index.ts";

/**
 * The official X API, paid per use. Read-only: the scopes below can read posts, my profile and my
 * bookmarks, nothing else. It never posts, likes, follows or sends messages.
 *
 * Two logins:
 * - my account (OAuth 2.0, one-time `auth:x`) for bookmarks, and for everything else if there's
 *   no app token;
 * - the app's bearer token (X_BEARER_TOKEN) for search, timelines and threads.
 *
 * Every call is priced before it's made against a monthly budget, paced so the month's money
 * isn't spent in the first week.
 */

const API = "https://api.x.com/2";
const SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];
const REDIRECT_PORT = 53683;
const REDIRECT = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

// Listed prices per resource read (see docs.x.com pricing); overridable as X changes them.
export const PRICE = {
  owned: Number(process.env.X_PRICE_OWNED_READ ?? 0.001), // my own bookmarks
  read: Number(process.env.X_PRICE_POST_READ ?? 0.005),   // any other post or user
};
export const monthlyBudget = () => Number(process.env.X_MONTHLY_BUDGET_USD ?? 15);

const month = (d = new Date()) => d.toISOString().slice(0, 7);
const day = (d = new Date()) => d.toISOString().slice(0, 10);
export const spentThisMonth = () => Number(kvGet(`x.spent.${month()}`) ?? 0);
const spentToday = () => Number(kvGet(`x.spentDay.${day()}`) ?? 0);

const hasAppKeys = () => Boolean(process.env.X_API_KEY && process.env.X_API_SECRET);
export function xConfigured(): boolean {
  return Boolean(process.env.X_BEARER_TOKEN || hasAppKeys() || existsSync(PATHS.xToken));
}

/** The app's bearer token: given directly, or swapped for the API key and secret once and kept. */
async function appBearer(): Promise<string | null> {
  if (process.env.X_BEARER_TOKEN) return process.env.X_BEARER_TOKEN;
  if (!hasAppKeys()) return null;
  const cached = kvGet("x.appBearer");
  if (cached) return cached;
  const res = await fetch("https://api.x.com/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(process.env.X_API_KEY!)}:${encodeURIComponent(process.env.X_API_SECRET!)}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`X app login: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const token = ((await res.json()) as { access_token: string }).access_token;
  kvSet("x.appBearer", token);
  return token;
}
export const xUserConnected = () => existsSync(PATHS.xToken) && Boolean(process.env.X_CLIENT_ID);

export class XBudgetReached extends Error {}
/** X itself refused: the developer account's prepaid balance is empty. */
export class XNoCredits extends XBudgetReached {}

/**
 * Whether a call that may cost `estimate` dollars fits. The month's cap is hard. Each day may also
 * spend its share of what's left, plus whatever earlier days didn't use, so quiet days roll over.
 */
export function canSpend(estimate: number, now = new Date()): boolean {
  const left = monthlyBudget() - Number(kvGet(`x.spent.${month(now)}`) ?? 0);
  if (estimate > left) return false;
  const today = Number(kvGet(`x.spentDay.${day(now)}`) ?? 0);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = daysInMonth - now.getUTCDate() + 1;
  const todayShare = (left + today) / daysLeft;
  return today + estimate <= Math.max(todayShare, monthlyBudget() / daysInMonth);
}

function charge(dollars: number) {
  kvSet(`x.spent.${month()}`, (spentThisMonth() + dollars).toFixed(4));
  kvSet(`x.spentDay.${day()}`, (spentToday() + dollars).toFixed(4));
}

// ---------- Login (my account) ----------

interface Token { access_token: string; refresh_token?: string; expires_at: number; scope?: string }

const readToken = (): Token => JSON.parse(readFileSync(PATHS.xToken, "utf8"));
const saveToken = (t: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }, old?: Token) =>
  writeFileSync(PATHS.xToken, JSON.stringify({
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? old?.refresh_token,
    expires_at: Date.now() + (t.expires_in ?? 7200) * 1000 - 60_000,
    scope: t.scope ?? old?.scope,
  }, null, 2), { mode: 0o600 });

async function tokenRequest(body: Record<string, string>) {
  const id = process.env.X_CLIENT_ID ?? "";
  const secret = process.env.X_CLIENT_SECRET ?? "";
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  // A confidential app authenticates with its secret; a public one sends its id in the body.
  if (secret) headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST", headers, body: new URLSearchParams({ ...body, ...(secret ? {} : { client_id: id }) }),
  });
  if (!res.ok) throw new Error(`X login: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>;
}

async function userToken(): Promise<string> {
  const t = readToken();
  if (Date.now() < t.expires_at) return t.access_token;
  if (!t.refresh_token) throw new Error("X login expired. Run: npm run jh -- auth:x");
  const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  saveToken(fresh, t);
  return fresh.access_token;
}

/** One-time consent in the browser, with a local callback (the same pattern as Google). */
export async function connectX(): Promise<void> {
  if (!process.env.X_CLIENT_ID) throw new Error("Set X_CLIENT_ID (and X_CLIENT_SECRET for a confidential app) in .env first. See README, X setup.");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const url = `https://x.com/i/oauth2/authorize?${new URLSearchParams({
    response_type: "code", client_id: process.env.X_CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPES.join(" "), state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  })}`;
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${REDIRECT_PORT}`);
      if (u.pathname !== "/callback") return void res.end();
      const got = u.searchParams.get("code");
      const ok = got && u.searchParams.get("state") === state;
      res.end(ok ? "X connected. You can close this tab." : "Login didn't complete.");
      server.close();
      ok ? resolve(got!) : reject(new Error(u.searchParams.get("error") ?? "State mismatch"));
    });
    server.listen(REDIRECT_PORT, "127.0.0.1", () => console.log(`\nOpen this link to connect X (read-only: posts and your bookmarks):\n\n${url}\n`));
  });
  saveToken(await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }));
  kvSet("x.me", "");
  console.log("X connected.");
}

// ---------- Calls ----------

export interface XUser { id: string; name: string; username: string; description?: string }
export interface XPost {
  id: string; text: string; author_id: string; created_at?: string; conversation_id?: string;
  entities?: { urls?: Array<{ expanded_url?: string; unwound_url?: string }> };
  note_tweet?: { text: string };
  public_metrics?: { reply_count?: number };
  referenced_tweets?: Array<{ type: string; id: string }>;
}
interface Page { data?: XPost[]; includes?: { users?: XUser[] }; meta?: { next_token?: string; newest_id?: string; result_count?: number } }

const POST_FIELDS = {
  "tweet.fields": "created_at,author_id,conversation_id,entities,note_tweet,public_metrics,referenced_tweets",
  expansions: "author_id",
  "user.fields": "name,username,description",
};

/**
 * One GET. `kind` sets the price: "owned" for my bookmarks, "read" for anything else. The cost
 * is estimated from the page size before the call and settled from what came back after.
 */
async function xGet<T extends object>(path: string, params: Record<string, string | number | undefined>, opts: { kind: "owned" | "read"; maxItems: number; auth?: "user" | "app" }): Promise<T> {
  const estimate = opts.maxItems * PRICE[opts.kind];
  if (!canSpend(estimate)) throw new XBudgetReached(`X budget reached ($${spentThisMonth().toFixed(2)} of $${monthlyBudget()} this month)`);
  const app = opts.auth !== "user" ? await appBearer() : null;
  if (!app && !existsSync(PATHS.xToken)) throw new Error("X isn't connected: add X_BEARER_TOKEN (or X_API_KEY and X_API_SECRET) to .env, or run auth:x");
  const token = app ?? await userToken();
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${API}${path}?${qs}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 429) {
    const reset = Number(res.headers.get("x-rate-limit-reset") ?? 0) * 1000;
    kvSet("x.backoffUntil", new Date(Math.max(reset, Date.now() + 15 * 60_000)).toISOString());
    throw new Error("X is rate limiting; trying again later");
  }
  if (res.status === 402) {
    // The X developer account has no prepaid credit. That's not my monthly budget: try again in
    // 6 hours, in case it's been topped up.
    kvSet("x.backoffUntil", new Date(Date.now() + 6 * 3600_000).toISOString());
    kvSet("x.noCredits", new Date().toISOString());
    throw new XNoCredits("The X developer account has no credits. Add a prepaid balance at console.x.com (Billing).");
  }
  kvSet("x.noCredits", "");
  if (!res.ok) throw new Error(`X ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as T & Page;
  const items = (json.data && Array.isArray(json.data) ? json.data.length : json.data ? 1 : 0) + (json.includes?.users?.length ?? 0);
  const cost = items * PRICE[opts.kind];
  charge(cost);
  logEvent("x.call", path.replace(/\/\d+/g, "/:id"), { items, cost: Number(cost.toFixed(4)) });
  return json;
}

export const backingOff = () => (kvGet("x.backoffUntil") ?? "") > new Date().toISOString();

/** Posts with their author attached, and the full text of long posts. */
function withAuthors(page: Page): Array<XPost & { author?: XUser }> {
  const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
  return (page.data ?? []).map((p) => ({ ...p, text: p.note_tweet?.text ?? p.text, author: users.get(p.author_id) }));
}

export async function me(): Promise<XUser> {
  const cached = kvGet("x.me");
  if (cached) return JSON.parse(cached);
  const r = await xGet<{ data: XUser }>("/users/me", {}, { kind: "owned", maxItems: 1, auth: "user" });
  kvSet("x.me", JSON.stringify(r.data));
  return r.data;
}

/** My bookmarks, newest first, stopping at the first one already seen. */
export async function bookmarks(isKnown: (id: string) => boolean, maxPages = 2) {
  const { id } = await me();
  const out: Array<XPost & { author?: XUser }> = [];
  let token: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await xGet<Page>(`/users/${id}/bookmarks`, { max_results: 50, pagination_token: token, ...POST_FIELDS }, { kind: "owned", maxItems: 51, auth: "user" });
    const posts = withAuthors(page);
    const fresh = posts.filter((p) => !isKnown(p.id));
    out.push(...fresh);
    token = page.meta?.next_token;
    if (!token || fresh.length < posts.length) break;
  }
  return out;
}

/** Posts from the last 7 days matching a search, newer than `sinceId`. */
export async function searchRecent(query: string, sinceId?: string, max = 25) {
  const page = await xGet<Page>("/tweets/search/recent", { query, since_id: sinceId, max_results: Math.max(10, Math.min(100, max)), ...POST_FIELDS }, { kind: "read", maxItems: max * 2 });
  return { posts: withAuthors(page), newestId: page.meta?.newest_id };
}

export async function userByName(username: string): Promise<XUser> {
  const key = `x.user.${username.toLowerCase()}`;
  const cached = kvGet(key);
  if (cached) return JSON.parse(cached);
  const r = await xGet<{ data: XUser }>(`/users/by/username/${encodeURIComponent(username)}`, { "user.fields": "name,username,description" }, { kind: "read", maxItems: 1 });
  if (!r.data) throw new Error(`No X account @${username}`);
  kvSet(key, JSON.stringify(r.data));
  return r.data;
}

/** An account's own new posts (no retweets or replies), newer than `sinceId`. */
export async function userPosts(userId: string, sinceId?: string, max = 10) {
  const page = await xGet<Page>(`/users/${userId}/tweets`, {
    since_id: sinceId, max_results: Math.max(5, Math.min(100, max)), exclude: "retweets,replies", ...POST_FIELDS,
  }, { kind: "read", maxItems: max * 2 });
  return { posts: withAuthors(page), newestId: page.meta?.newest_id };
}

export async function post(id: string) {
  const page = await xGet<{ data?: XPost; includes?: { users?: XUser[] } }>(`/tweets/${id}`, POST_FIELDS, { kind: "read", maxItems: 2 });
  return page.data ? withAuthors({ data: [page.data], includes: page.includes })[0] : null;
}

/** New replies in a thread (last 7 days), via search on its conversation id. */
export async function replies(conversationId: string, sinceId?: string, max = 50) {
  return searchRecent(`conversation_id:${conversationId}`, sinceId, max);
}

/** Post id from an x.com or twitter.com link. */
export const postIdFromUrl = (url: string) => url.match(/(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i)?.[1] ?? null;
export const postUrl = (p: { id: string; author?: XUser }) => `https://x.com/${p.author?.username ?? "i"}/status/${p.id}`;
/** Links in a post, minus links back to X itself. */
export const postLinks = (p: XPost) => [...new Set((p.entities?.urls ?? []).map((u) => u.unwound_url ?? u.expanded_url ?? "")
  .filter((u) => u && !/^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(u)))];

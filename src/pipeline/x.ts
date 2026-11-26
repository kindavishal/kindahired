import { z } from "zod";
import { loadProfile, searchTerms, TIMEZONE } from "../config.ts";
import { upsertContact } from "../db/contacts.ts";
import { all, get, kvGet, kvSet, logEvent, nowIso, run } from "../db/index.ts";
import { llm } from "../llm/client.ts";
import {
  backingOff, bookmarks, post, postIdFromUrl, postLinks, postUrl, replies, searchRecent, userByName, userPosts,
  XBudgetReached, xConfigured, xUserConnected, type XPost, type XUser,
} from "../sources/x.ts";
import { addOpportunity, screenerSystem } from "./ingest.ts";

/**
 * Roles posted on X, from four places: my bookmarks, searches for hiring posts in my target roles,
 * accounts I watch (founders, hiring managers, team leads), and threads I send or that look like
 * they'll collect roles in the replies. Every post is screened once (seen posts are never paid
 * for again), and roles that fit go through the same steps as an email alert.
 */

type Post = XPost & { author?: XUser };
export type XOrigin = "bookmark" | "search" | "account" | "thread";

const THREAD_DAYS = 14;
const THREAD_CHECK_HOURS = 6;

// ---------- What to look for ----------

/** Searches built from my target roles: hiring language plus role words, no retweets or replies. Long lists split across queries. */
export function defaultQueries(): string[] {
  const hiring = `("we're hiring" OR "we are hiring" OR hiring OR "looking for" OR "join our team")`;
  const build = (terms: string[]) => `${hiring} (${terms.map((t) => `"${t}"`).join(" OR ")}) -is:retweet -is:reply lang:en`;
  const out: string[] = [];
  let group: string[] = [];
  for (const t of searchTerms()) {
    if (group.length && build([...group, t]).length > 480) { out.push(build(group)); group = []; }
    group.push(t);
  }
  if (group.length) out.push(build(group));
  return out;
}
export const queries = (): string[] => JSON.parse(kvGet("x.queries") ?? "null") ?? defaultQueries();
export const setQueries = (q: string[]) => kvSet("x.queries", JSON.stringify(q));

export interface WatchedAccount { username: string; id?: string; sinceId?: string }
export const accounts = (): WatchedAccount[] => JSON.parse(kvGet("x.accounts") ?? "[]");
const saveAccounts = (a: WatchedAccount[]) => kvSet("x.accounts", JSON.stringify(a));
export function followAccount(handle: string) {
  const username = handle.replace(/^@|^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/[/?].*$/, "").trim();
  if (!/^\w{1,15}$/.test(username)) throw new Error(`"${handle}" isn't an X handle`);
  const list = accounts();
  if (!list.some((a) => a.username.toLowerCase() === username.toLowerCase())) saveAccounts([...list, { username }]);
  return username;
}
export function unfollowAccount(handle: string) {
  const username = handle.replace(/^@/, "").toLowerCase();
  saveAccounts(accounts().filter((a) => a.username.toLowerCase() !== username));
}

// ---------- Screening ----------

const Screened = z.object({
  results: z.array(z.object({
    post_id: z.string(),
    hiring: z.boolean().describe("True if the post announces or lists open roles."),
    jobs: z.array(z.object({
      company: z.string(),
      role: z.string(),
      url: z.string().nullable().describe("A job or careers link copied exactly from the post's links. Null if there is none."),
      location: z.string().nullable(),
      relevance: z.enum(["high", "medium", "low"]),
    })),
    collects_roles_in_replies: z.boolean().describe("True for a 'who's hiring' or 'drop your openings' post, where roles arrive as replies."),
  })),
});

const screenRules = () => `You read posts from X. For each post:
- hiring: true only when it announces or lists real open roles. Not job seekers, not "open to work", not courses, not engagement bait.
- jobs: every open role named. Company: as posted, or the poster's company from their bio when they say "we" or "my team". Skip roles with no company you can tell.
- url: copy exactly from the post's links. Never invent one.
- relevance: "high" only for my target role families in a location the playbook allows (remote roles must fit working hours in ${TIMEZONE}); "medium" if adjacent or unclear; "low" otherwise.
- A paid job only. Volunteer or unpaid "ambassador programs", campaigns that recruit community members to promote a token or project, airdrops, bounties and quests are "low", even when they say "community".
- collects_roles_in_replies: true for threads asking people to post their openings.`;

const asText = (p: Post) => [
  `<post id="${p.id}">`,
  `Author: ${p.author?.name ?? "?"} (@${p.author?.username ?? "?"})${p.author?.description ? ` · bio: ${p.author.description.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  p.created_at && `Date: ${p.created_at.slice(0, 10)}`,
  p.text,
  postLinks(p).length ? `Links: ${postLinks(p).join(" ")}` : null,
  "</post>",
].filter(Boolean).join("\n");

const known = (id: string) => !!get("SELECT 1 FROM inbox_items WHERE source = 'x' AND external_id = $id", { id });

export interface XStats { read: number; screened: number; matches: number; newOpportunityIds: number[]; threadsAdded: number }
const emptyStats = (): XStats => ({ read: 0, screened: 0, matches: 0, newOpportunityIds: [], threadsAdded: 0 });

/** Screens new posts and files the roles in them. Posts already seen are skipped for free. */
export async function processPosts(posts: Post[], origin: XOrigin, stats = emptyStats()): Promise<XStats> {
  stats.read += posts.length;
  const fresh = [...new Map(posts.filter((p) => !known(p.id)).map((p) => [p.id, p])).values()];
  for (let i = 0; i < fresh.length; i += 15) {
    const batch = fresh.slice(i, i + 15);
    const { results } = await llm.structured("x.screen", Screened, {
      effort: "low", maxTokens: 12000, numCtx: 16384,
      system: `${screenerSystem()}\n\n${screenRules()}`,
      prompt: batch.map(asText).join("\n\n"),
    });
    stats.screened += batch.length;
    for (const p of batch) {
      const r = results.find((x) => x.post_id === p.id);
      const url = postUrl(p);
      let opportunityId: number | null = null;
      for (const j of r?.jobs ?? []) {
        if (j.relevance === "low") continue;
        const { opportunity, isNew } = addOpportunity(j.company, j.role, {
          source: `x:${origin}`,
          source_url: j.url && postLinks(p).includes(j.url) ? j.url : url,
          jd_text: [`Posted on X by ${p.author?.name ?? ""} (@${p.author?.username ?? "?"}): ${url}`, j.location && `Location: ${j.location}`, p.text].filter(Boolean).join("\n"),
        }, j.relevance);
        opportunityId ??= opportunity.id;
        if (isNew) { stats.matches++; stats.newOpportunityIds.push(opportunity.id); }
      }
      // Whoever posted a role is often the hiring manager or founder: keep them as a contact.
      if (opportunityId && p.author) {
        upsertContact({ name: p.author.name, x_handle: p.author.username, title: p.author.description?.slice(0, 160) ?? null, notes: `Posted a role on X: ${url}` });
      }
      if (r?.collects_roles_in_replies && origin !== "thread" && (p.public_metrics?.reply_count ?? 1) > 0) {
        if (watchThread(p.conversation_id ?? p.id, url, { via: "auto", label: p.author ? `@${p.author.username}` : undefined })) stats.threadsAdded++;
      }
      run(
        `INSERT INTO inbox_items (source, external_id, url, title, raw, status, opportunity_id) VALUES ('x', $id, $url, $title, $raw, $status, $opp)
         ON CONFLICT(source, external_id) DO NOTHING`,
        { id: p.id, url, title: p.text.slice(0, 120), raw: JSON.stringify({ origin, author: p.author?.username, hiring: r?.hiring ?? false }), status: opportunityId ? "processed" : "ignored", opp: opportunityId },
      );
    }
  }
  return stats;
}

// ---------- Threads ----------

/** Starts watching a thread's replies. Returns false if it's already watched. */
export function watchThread(conversationId: string, url: string, opts: { via: string; label?: string; days?: number }): boolean {
  const existing = get<{ status: string }>("SELECT status FROM x_threads WHERE conversation_id = $c", { c: conversationId });
  const until = new Date(Date.now() + (opts.days ?? THREAD_DAYS) * 86400_000).toISOString();
  if (existing?.status === "active") return false;
  run(
    `INSERT INTO x_threads (conversation_id, url, label, added_via, watch_until) VALUES ($c, $url, $label, $via, $until)
     ON CONFLICT(conversation_id) DO UPDATE SET status = 'active', watch_until = $until`,
    { c: conversationId, url, label: opts.label ?? null, via: opts.via, until },
  );
  return true;
}
export const stopThread = (conversationId: string) => run("UPDATE x_threads SET status = 'stopped' WHERE conversation_id = $c", { c: conversationId });
export const activeThreads = () => all<{ conversation_id: string; url: string; label: string | null; watch_until: string; last_seen_id: string | null; last_checked_at: string | null }>(
  "SELECT * FROM x_threads WHERE status = 'active' ORDER BY created_at",
);

async function checkThread(t: ReturnType<typeof activeThreads>[number], stats: XStats) {
  const { posts, newestId } = await replies(t.conversation_id, t.last_seen_id ?? undefined);
  await processPosts(posts, "thread", stats);
  run("UPDATE x_threads SET last_seen_id = coalesce($n, last_seen_id), last_checked_at = $now WHERE conversation_id = $c", { n: newestId ?? null, now: nowIso(), c: t.conversation_id });
}

/**
 * A link I sent: read the post and its replies now, file any roles, and keep watching the thread.
 */
export async function readThreadLink(url: string): Promise<{ text: string; conversationId?: string }> {
  const id = postIdFromUrl(url);
  if (!id) return { text: "That doesn't look like a link to an X post." };
  const p = await post(id);
  if (!p) return { text: "I couldn't open that post. It may be deleted or from a private account." };
  const stats = await processPosts([p], "thread");
  const conversationId = p.conversation_id ?? p.id;
  watchThread(conversationId, postUrl(p), { via: "telegram", label: p.author ? `@${p.author.username}` : undefined });
  const t = activeThreads().find((x) => x.conversation_id === conversationId);
  if (t) await checkThread(t, stats);
  const found = stats.matches ? `${stats.matches} role${stats.matches === 1 ? " that fits" : "s that fit"} (summaries follow)` : "no roles that fit yet";
  return {
    text: `Read the post by @${p.author?.username ?? "?"} and ${Math.max(0, stats.read - 1)} repl${stats.read === 2 ? "y" : "ies"}: ${found}. I'll check for new replies every ${THREAD_CHECK_HOURS} hours for ${THREAD_DAYS} days.`,
    conversationId,
  };
}

// ---------- The scheduled run ----------

const sinceKey = (q: string) => `x.since.${Buffer.from(q).toString("base64url").slice(0, 40)}`;

/**
 * One pass over everything, cheapest and most personal first: bookmarks, watched threads,
 * watched accounts, then searches. Stops quietly when the budget or a rate limit is hit.
 */
export async function scanX(now = new Date(), opts: { force?: boolean } = {}): Promise<XStats & { stopped?: string }> {
  const stats = emptyStats();
  if (!xConfigured()) return { ...stats, stopped: "X isn't connected" };
  // `force` (the x:scan command) checks straight away, e.g. right after topping up the balance.
  if (backingOff() && !opts.force) {
    return { ...stats, stopped: kvGet("x.noCredits") ? "The X developer account has no credits (checking again every 6 hours)" : "rate limited" };
  }
  try {
    if (xUserConnected()) await processPosts(await bookmarks(known), "bookmark", stats);

    for (const t of activeThreads()) {
      if (t.watch_until < now.toISOString()) { run("UPDATE x_threads SET status = 'ended' WHERE conversation_id = $c", { c: t.conversation_id }); continue; }
      if (t.last_checked_at && now.getTime() - new Date(t.last_checked_at).getTime() < THREAD_CHECK_HOURS * 3600_000) continue;
      await checkThread(t, stats);
    }

    const list = accounts();
    for (const a of list) {
      a.id ??= (await userByName(a.username)).id;
      const { posts, newestId } = await userPosts(a.id, a.sinceId);
      await processPosts(posts, "account", stats);
      a.sinceId = newestId ?? a.sinceId;
      saveAccounts(list);
    }

    for (const q of queries()) {
      const { posts, newestId } = await searchRecent(q, kvGet(sinceKey(q)));
      await processPosts(posts, "search", stats);
      if (newestId) kvSet(sinceKey(q), newestId);
    }
  } catch (err) {
    if (err instanceof XBudgetReached || /rate limiting/.test(String(err))) {
      logEvent("x.scan", null, { ...stats, stopped: String(err) });
      return { ...stats, stopped: err instanceof Error ? err.message : String(err) };
    }
    throw err;
  }
  logEvent("x.scan", null, stats);
  return stats;
}

/** For /x and the CLI: where the money and attention go. */
export function xStatus() {
  const { name } = loadProfile();
  return { name, queries: queries(), accounts: accounts().map((a) => a.username), threads: activeThreads() };
}

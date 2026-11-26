import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { all, get, kvSet, useMemoryDb } from "../src/db/index.ts";
import { llm } from "../src/llm/client.ts";
import { rankPostingResults } from "../src/pipeline/pack.ts";
import { activeThreads, processPosts, readThreadLink, scanX } from "../src/pipeline/x.ts";
import { firecrawlAvailable, firecrawlSearch, FirecrawlUnavailable } from "../src/sources/firecrawl.ts";
import { canSpend, spentThisMonth } from "../src/sources/x.ts";

// Stand-ins for Firecrawl and X: nothing here reaches the network or spends money.
const realFetch = globalThis.fetch;
let calls: string[] = [];
function fakeFetch(routes: Record<string, (url: URL) => { status?: number; body: unknown }>) {
  calls = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const hit = Object.entries(routes).find(([k]) => url.pathname.includes(k));
    if (!hit) return new Response("not found", { status: 404 });
    const r = hit[1](url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

beforeEach(() => {
  useMemoryDb();
  process.env.X_BEARER_TOKEN = "test-token";
  process.env.X_MONTHLY_BUDGET_USD = "15";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.X_BEARER_TOKEN = "";
  process.env.FIRECRAWL_API_KEY = "";
});

const author = { id: "u1", name: "Mira Shah", username: "mirashah", description: "Head of DevRel at Acme" };
const hiringPost = { id: "100", text: "We're hiring a Developer Advocate (remote, APAC) https://t.co/x", author_id: "u1", conversation_id: "100",
  entities: { urls: [{ expanded_url: "https://jobs.ashbyhq.com/acme/1" }] }, public_metrics: { reply_count: 4 } };

function fakeScreen(perPost: Record<string, unknown>) {
  llm.structured = (async (label: string, _s: unknown, opts: { prompt: string }) => {
    assert.equal(label, "x.screen");
    const ids = [...opts.prompt.matchAll(/<post id="(\d+)">/g)].map((m) => m[1]);
    return { results: ids.map((id) => ({ post_id: id, hiring: false, jobs: [], collects_roles_in_replies: false, ...(perPost[id] as object ?? {}) })) };
  }) as typeof llm.structured;
}

test("Firecrawl search counts credits and stops for the month when they run out", async () => {
  process.env.FIRECRAWL_API_KEY = "fc-test";
  fakeFetch({ "/v2/search": () => ({ body: { success: true, creditsUsed: 2, data: { web: [{ url: "https://jobs.ashbyhq.com/acme/1", title: "Developer Advocate - Acme", description: "" }] } } }) });
  const r = await firecrawlSearch("Acme Developer Advocate job");
  assert.equal(r[0].url, "https://jobs.ashbyhq.com/acme/1");
  fakeFetch({ "/v2/search": () => ({ status: 402, body: { error: "Insufficient credits" } }) });
  await assert.rejects(firecrawlSearch("again"), FirecrawlUnavailable);
  assert.equal(firecrawlAvailable(), false);
});

test("search results: the company's own posting first, job boards dropped", () => {
  const urls = rankPostingResults([
    { url: "https://www.linkedin.com/jobs/view/1", title: "Developer Advocate Acme", description: "", markdown: null },
    { url: "https://acme.dev/blog/launch", title: "Acme launch", description: "", markdown: null },
    { url: "https://jobs.ashbyhq.com/acme/1", title: "Developer Advocate", description: "", markdown: null },
  ], { company: "Acme", role: "Developer Advocate" });
  assert.deepEqual(urls, ["https://jobs.ashbyhq.com/acme/1", "https://acme.dev/blog/launch"]);
  // A board that puts the company name in its path isn't the company's page (seen live with Toast).
  const toast = rankPostingResults([
    { url: "https://startup.jobs/program-manager-workplace-operations-toast-10203812", title: "Program Manager at Toast", description: "", markdown: null },
    { url: "https://careers.toasttab.com/jobs/program-manager-inclusion-impact-apac", title: "Program Manager, Inclusion & Impact (APAC)", description: "", markdown: null },
  ], { company: "Toast", role: "Program Manager, Inclusion & Impact (APAC)" });
  assert.equal(toast[0], "https://careers.toasttab.com/jobs/program-manager-inclusion-impact-apac");
});

test("the X budget is a hard monthly cap, spread across the month", () => {
  const now = new Date("2026-11-10T10:00:00Z"); // 21 days left in November
  assert.ok(canSpend(0.5, now));
  kvSet("x.spent.2026-11", "14.9");
  assert.ok(!canSpend(0.5, now), "past the monthly cap");
  kvSet("x.spent.2026-11", "0");
  kvSet("x.spentDay.2026-11-10", "0.7");
  assert.ok(!canSpend(0.5, now), "past today's share");
});

test("a hiring post becomes a role, its author a contact, and a 'drop your openings' thread gets watched", async () => {
  fakeScreen({ "100": { hiring: true, collects_roles_in_replies: true, jobs: [{ company: "Acme", role: "Developer Advocate", url: "https://jobs.ashbyhq.com/acme/1", location: "Remote, APAC", relevance: "high" }] } });
  const stats = await processPosts([{ ...hiringPost, author }], "search");
  assert.equal(stats.matches, 1);
  const o = get<{ source: string; source_url: string; pack_status: string }>("SELECT * FROM opportunities")!;
  assert.equal(o.source, "x:search");
  assert.equal(o.source_url, "https://jobs.ashbyhq.com/acme/1");
  assert.equal(o.pack_status, "queued");
  assert.equal(get<{ x_handle: string }>("SELECT x_handle FROM contacts")!.x_handle, "mirashah");
  assert.equal(activeThreads().length, 1);
  // The same post again costs nothing to screen.
  let screened = 0;
  llm.structured = (async () => { screened++; return { results: [] }; }) as typeof llm.structured;
  await processPosts([{ ...hiringPost, author }], "search");
  assert.equal(screened, 0);
});

test("a thread link: the post and its replies are read, roles filed, and the thread watched", async () => {
  fakeFetch({
    "/2/tweets/search/recent": () => ({ body: {
      data: [{ id: "101", text: "Also hiring: Community Lead at Beta, India remote", author_id: "u2", conversation_id: "100" }],
      includes: { users: [{ id: "u2", name: "Sam", username: "sam" }] }, meta: { newest_id: "101" },
    } }),
    "/2/tweets/100": () => ({ body: { data: { ...hiringPost, text: "Drop your DevRel and community openings below 👇", entities: {} }, includes: { users: [author] } } }),
  });
  fakeScreen({ "101": { hiring: true, jobs: [{ company: "Beta", role: "Community Lead", url: null, location: "India", relevance: "high" }] } });
  const r = await readThreadLink("https://x.com/mirashah/status/100");
  assert.match(r.text, /1 reply: 1 role that fits/);
  assert.equal(r.conversationId, "100");
  assert.equal(all("SELECT * FROM opportunities").length, 1);
  assert.equal(activeThreads()[0].last_seen_id, "101");
  assert.ok(spentThisMonth() > 0);
});

test("an empty X balance pauses for a few hours, never for the month", async () => {
  fakeFetch({ "/2/": () => ({ status: 402, body: { detail: "credits depleted", status: 402 } }) });
  const r = await scanX();
  assert.match(r.stopped ?? "", /no credits/);
  assert.equal(spentThisMonth(), 0, "my monthly budget is untouched");
  const again = await scanX();
  assert.match(again.stopped ?? "", /no credits.*every 6 hours/);
  assert.equal(calls.length, 1, "no second call while paused");
  // After topping up, x:scan checks straight away.
  fakeFetch({ "/2/tweets/search/recent": () => ({ body: { data: [], meta: {} } }) });
  const forced = await scanX(new Date(), { force: true });
  assert.equal(forced.stopped, undefined);
});

test("scanX stops quietly at the budget instead of failing", async () => {
  kvSet(`x.spent.${new Date().toISOString().slice(0, 7)}`, "15");
  fakeFetch({});
  const r = await scanX();
  assert.match(r.stopped ?? "", /budget/);
  assert.equal(calls.length, 0);
});

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { useMemoryDb } from "../src/db/index.ts";
import { getOpportunity, upsertOpportunity } from "../src/db/opportunities.ts";
import { checkPostings, checkPostingUrl, postingLinks } from "../src/pipeline/liveness.ts";

beforeEach(() => useMemoryDb());

/** A fake fetch: each URL answers with a status, an optional final URL after redirects, and a body. */
function fakeFetch(routes: Record<string, { status?: number; url?: string; body?: string; json?: unknown }>) {
  return async (url: string | URL | Request) => {
    const key = String(url);
    const r = routes[key];
    if (!r) throw new Error(`unexpected fetch ${key}`);
    const body = r.json !== undefined ? JSON.stringify(r.json) : r.body ?? "";
    const res = new Response(body, { status: r.status ?? 200, headers: { "content-type": r.json !== undefined ? "application/json" : "text/html" } });
    Object.defineProperty(res, "url", { value: r.url ?? key });
    return res;
  };
}

test("a Workable job the API no longer knows is closed", async () => {
  const f = fakeFetch({ "https://apply.workable.com/api/v2/accounts/packtpublishing/jobs/11A546CFD5": { status: 404, body: "Job not found" } });
  const r = await checkPostingUrl("https://apply.workable.com/packtpublishing/j/11A546CFD5/apply", { fetch: f });
  assert.equal(r.state, "closed");
});

test("Greenhouse, Lever and Ashby are read through their APIs", async () => {
  const f = fakeFetch({
    "https://boards-api.greenhouse.io/v1/boards/arizeai/jobs/6128123004": { json: { id: 6128123004 } },
    "https://boards-api.greenhouse.io/v1/boards/arizeai/jobs/1": { status: 404, json: {} },
    "https://api.lever.co/v0/postings/aduna/abc": { status: 404, json: {} },
    "https://api.ashbyhq.com/posting-api/job-board/render": { json: { jobs: [{ id: "c7d896f2-0000-0000-0000-000000000000" }] } },
  });
  assert.equal((await checkPostingUrl("https://job-boards.greenhouse.io/arizeai/jobs/6128123004", { fetch: f })).state, "open");
  assert.equal((await checkPostingUrl("https://job-boards.greenhouse.io/arizeai/jobs/1", { fetch: f })).state, "closed");
  assert.equal((await checkPostingUrl("https://jobs.lever.co/aduna/abc/apply", { fetch: f })).state, "closed");
  assert.equal((await checkPostingUrl("https://jobs.ashbyhq.com/render/76fd7bc4-1808-4bff-8663-16c917f45f4e", { fetch: f })).state, "closed");
  assert.equal((await checkPostingUrl("https://jobs.ashbyhq.com/render/c7d896f2-0000-0000-0000-000000000000/application", { fetch: f })).state, "open");
});

test("other pages: gone, redirected away, or saying they're closed", async () => {
  const f = fakeFetch({
    "https://herodevs.applytojob.com/apply/8fF/Lead": { status: 410 },
    "https://careers.example.com/jobs/8386495": { url: "https://careers.example.com/jobs", body: "<p>All jobs</p>" },
    "https://ledby.community/jobs/lead": { body: "<h1>Lead</h1><p>This position has been filled. Thanks for your interest.</p>" },
    "https://ledby.community/jobs/open": { body: "<h1>Lead</h1><p>Apply by 30 Nov. Closing date soon.</p>" },
    "https://down.example.com/jobs/1": { status: 503 },
  });
  assert.equal((await checkPostingUrl("https://herodevs.applytojob.com/apply/8fF/Lead", { fetch: f })).state, "closed");
  assert.equal((await checkPostingUrl("https://careers.example.com/jobs/8386495", { fetch: f })).state, "closed");
  assert.equal((await checkPostingUrl("https://ledby.community/jobs/lead", { fetch: f })).state, "closed");
  assert.equal((await checkPostingUrl("https://ledby.community/jobs/open", { fetch: f })).state, "unknown");
  assert.equal((await checkPostingUrl("https://down.example.com/jobs/1", { fetch: f })).state, "unknown");
  assert.equal((await checkPostingUrl("https://x.com/someone/status/1", { fetch: f })).state, "unknown");
});

test("LinkedIn jobs are read through the browser, or left alone without it", async () => {
  const url = "https://www.linkedin.com/jobs/view/community-manager-at-acme-4489409452";
  assert.equal((await checkPostingUrl(url, { linkedin: null })).state, "unknown");
  const r = await checkPostingUrl(url, { linkedin: async (id) => ({ text: `job ${id} ` + "x".repeat(600), closed: true }) });
  assert.equal(r.state, "closed");
});

test("one LinkedIn read per role, whichever field holds the link", () => {
  assert.deepEqual(postingLinks({ apply_url: "https://in.linkedin.com/jobs/view/program-manager-at-leap-4489409452", source_url: "https://www.linkedin.com/jobs/view/4489409452/", linkedin_job_id: "4489409452" }),
    ["https://in.linkedin.com/jobs/view/program-manager-at-leap-4489409452"]);
  assert.deepEqual(postingLinks({ apply_url: "WhatsApp post by Asad", source_url: null, linkedin_job_id: null }), []);
});

test("the sweep skips closed roles not applied to, and only notes ones already applied to", async () => {
  const ready = upsertOpportunity("Packt", "Growth Lead", { status: "ready", apply_url: "https://apply.workable.com/packtpublishing/j/11A546CFD5/apply" });
  const applied = upsertOpportunity("Render", "Developer Programs Lead", { status: "applied", apply_url: "https://jobs.ashbyhq.com/render/76fd7bc4-1808-4bff-8663-16c917f45f4e" });
  const live = upsertOpportunity("Arize", "Education Engineer", { status: "ready", apply_url: "https://job-boards.greenhouse.io/arizeai/jobs/6128123004" });
  const f = fakeFetch({
    "https://apply.workable.com/api/v2/accounts/packtpublishing/jobs/11A546CFD5": { status: 404 },
    "https://api.ashbyhq.com/posting-api/job-board/render": { json: { jobs: [{ id: "other" }] } },
    "https://boards-api.greenhouse.io/v1/boards/arizeai/jobs/6128123004": { json: {} },
  });
  const r = await checkPostings({ deps: { fetch: f, linkedin: null } });
  assert.equal(r.checked, 3);
  assert.equal(r.closed.length, 2);

  const p = getOpportunity(ready.id)!;
  assert.equal(p.status, "skipped");
  assert.match(p.skip_reason!, /Posting closed/);
  const a = getOpportunity(applied.id)!;
  assert.equal(a.status, "applied");
  assert.match(a.check_notes!, /may be filled/);
  assert.equal(getOpportunity(live.id)!.status, "ready");
  assert.equal(getOpportunity(live.id)!.posting_state, "open");

  // Checked today: nothing is due again until tomorrow, and closed roles aren't re-read.
  assert.equal((await checkPostings({ deps: { fetch: f, linkedin: null } })).checked, 0);
});

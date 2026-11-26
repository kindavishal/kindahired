import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { all, get, run, useMemoryDb } from "../src/db/index.ts";
import { addSource, dueSources, fileJobs, getSource, normaliseSourceUrl } from "../src/pipeline/sources.ts";
import { htmlToLinkedText } from "../src/sources/web.ts";

beforeEach(() => useMemoryDb());

const job = (role: string, relevance: "high" | "medium" | "low", n: number) => ({
  company: `Co${n}`, role, url: `https://board.example/j/${n}`, apply_url: null, location: "Bengaluru", summary: role, relevance,
});

test("watch links keep their addresses next to their words", () => {
  const html = `<html><head><title>x</title><script>var a = "<a href='/no'>"</script></head><body>
    <article><h3><span>DevRel Lead</span><span>Acme</span></h3><a class="open" href="/j/7518">open</a>
    <a href="https://www.linkedin.com/posts/someone_hiring-activity-1">message boss &rarr;</a></article></body></html>`;
  const { text, links } = htmlToLinkedText(html, "https://jobsinthewild.tal.club/?sort=new");
  assert.deepEqual(links, ["https://jobsinthewild.tal.club/j/7518", "https://www.linkedin.com/posts/someone_hiring-activity-1"]);
  assert.match(text, /open \[→ https:\/\/jobsinthewild\.tal\.club\/j\/7518\]/);
  assert.match(text, /message boss → \[→ https:\/\/www\.linkedin\.com/);
  assert.doesNotMatch(text, /\/no/);
});

test("only web pages that don't need a login can be watched", () => {
  assert.equal(normaliseSourceUrl("jobsinthewild.tal.club/?sort=new#top"), "https://jobsinthewild.tal.club/?sort=new");
  assert.throws(() => normaliseSourceUrl("https://www.linkedin.com/jobs/search"), /login/);
  assert.throws(() => normaliseSourceUrl("ftp://example.com"), /http/);
});

test("adding the same page twice keeps one source and resumes it if paused", () => {
  const { source, isNew } = addSource("https://jobsinthewild.tal.club/", { via: "web" });
  assert.equal(isNew, true);
  assert.equal(source.label, "jobsinthewild.tal.club");
  run("UPDATE sources SET status = 'paused' WHERE id = $id", { id: source.id });
  const again = addSource("https://jobsinthewild.tal.club/", { via: "telegram" });
  assert.equal(again.isNew, false);
  assert.equal(again.source.status, "active");
  assert.equal(all("SELECT * FROM sources").length, 1);
});

test("a scan adds the postings that fit, remembers the rest, and never repeats one", () => {
  const { source } = addSource("https://board.example/", { label: "Board" });
  const first = fileJobs(source, [job("Developer Advocate", "high", 1), job("Community Manager", "medium", 2), job("Java Developer", "low", 3), job("Developer Advocate", "high", 1)]);
  assert.equal(first.postings, 4);
  assert.equal(first.newPostings, 3);
  assert.equal(first.matches, 2);
  const roles = all<{ role: string; source: string; pack_status: string; source_url: string }>("SELECT role, source, pack_status, source_url FROM opportunities ORDER BY id");
  assert.deepEqual(roles.map((r) => r.role), ["Developer Advocate", "Community Manager"]);
  assert.equal(roles[0].source, "watch:Board");
  assert.equal(roles[0].pack_status, "queued");
  assert.equal(roles[0].source_url, "https://board.example/j/1");
  // The low match is remembered, not added as a role.
  assert.equal(get<{ status: string }>("SELECT status FROM inbox_items WHERE external_id = 'https://board.example/j/3'")?.status, "ignored");

  const second = fileJobs(source, [job("Developer Advocate", "high", 1), job("Java Developer", "low", 3), job("DevRel Engineer", "high", 4)]);
  assert.equal(second.newPostings, 1);
  assert.equal(second.matches, 1);
});

test("a scan queues at most ten new matches and leaves the rest for next time", () => {
  const { source } = addSource("https://board.example/", { label: "Board" });
  const jobs = Array.from({ length: 13 }, (_, i) => job(`Community Lead ${i}`, "high", i));
  const r = fileJobs(source, jobs);
  assert.equal(r.matches, 10);
  assert.equal(r.deferred, 3);
  const next = fileJobs(source, jobs);
  assert.equal(next.matches, 3);
});

test("pages are due on their own timer, and back off after failures", () => {
  const { source } = addSource("https://board.example/", { intervalHours: 4 });
  const now = new Date("2026-11-25T12:00:00Z");
  assert.equal(dueSources(now).length, 1, "never scanned: due now");
  run("UPDATE sources SET last_scanned_at = '2026-11-25T09:00:00Z' WHERE id = $id", { id: source.id });
  assert.equal(dueSources(now).length, 0, "3 h ago on a 4 h timer");
  run("UPDATE sources SET last_scanned_at = '2026-11-25T07:00:00Z', fail_count = 2 WHERE id = $id", { id: source.id });
  assert.equal(dueSources(now).length, 0, "two failures: waits 8 h");
  run("UPDATE sources SET fail_count = 0 WHERE id = $id", { id: source.id });
  assert.equal(dueSources(now).length, 1);
  run("UPDATE sources SET status = 'paused' WHERE id = $id", { id: source.id });
  assert.equal(dueSources(now).length, 0, "paused");
  assert.equal(getSource(source.id)?.interval_hours, 4);
});

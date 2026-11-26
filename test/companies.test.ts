import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { all, get, run, useMemoryDb } from "../src/db/index.ts";
import { upsertContact } from "../src/db/contacts.ts";
import { upsertOpportunity } from "../src/db/opportunities.ts";
import {
  addCompany, autoAddCompanies, candidateCompanies, cleanCompanyName, removeCompany, dueCompanies, findBoard, knownPeopleAt, parseBoard, parseCompanyLines, readBoard, scanCompany, slugGuesses, type Posting,
} from "../src/pipeline/companies.ts";

beforeEach(() => useMemoryDb());

function fakeFetch(routes: Record<string, unknown>) {
  return async (url: string | URL | Request) => {
    const key = String(url);
    if (!(key in routes)) return new Response("not found", { status: 404 });
    const body = routes[key];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  };
}

test("board links are recognised from boards, postings and embeds", () => {
  assert.deepEqual(parseBoard("https://job-boards.greenhouse.io/arizeai/jobs/6128123004"), { type: "greenhouse", slug: "arizeai" });
  assert.deepEqual(parseBoard('<script src="https://boards.greenhouse.io/embed/job_board/js?for=toast"></script>'), { type: "greenhouse", slug: "toast" });
  assert.deepEqual(parseBoard("https://jobs.lever.co/adunaglobal/6022bac5/apply"), { type: "lever", slug: "adunaglobal" });
  assert.deepEqual(parseBoard("https://jobs.ashbyhq.com/factory/a6386a06/application"), { type: "ashby", slug: "factory" });
  assert.deepEqual(parseBoard("https://apply.workable.com/packtpublishing/j/11A546CFD5/apply"), { type: "workable", slug: "packtpublishing" });
  assert.deepEqual(parseBoard("https://jobs.smartrecruiters.com/Visa/744000"), { type: "smartrecruiters", slug: "Visa" });
  assert.deepEqual(parseBoard("https://tellent.recruitee.com/o/ops"), { type: "recruitee", slug: "tellent" });
  assert.equal(parseBoard("https://careers.toasttab.com/"), null);
});

test("company lines: names, links after a bar, and bare domains", () => {
  assert.deepEqual(parseCompanyLines("Stripe\n- Factory | https://jobs.ashbyhq.com/factory\nExa, exa.ai/careers\n\n"), [
    { name: "Stripe", link: null },
    { name: "Factory", link: "https://jobs.ashbyhq.com/factory" },
    { name: "Exa", link: "exa.ai/careers" },
  ]);
  assert.deepEqual(slugGuesses("Arize AI (now part of Dynatrace)"), ["arizeai", "arize-ai", "arize"]);
  assert.deepEqual(slugGuesses("Applied Materials"), ["appliedmaterials", "applied-materials"]);
});

test("each board's job list reads into the same shape", async () => {
  const f = fakeFetch({
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { jobs: [{ id: 1, title: "DevRel Lead", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1", location: { name: "Remote" }, first_published: "2026-11-20T10:00:00Z" }] },
    "https://boards-api.greenhouse.io/v1/boards/acme": { name: "Acme" },
    "https://api.lever.co/v0/postings/acme?mode=json": [{ id: "u1", text: "Community Manager", hostedUrl: "https://jobs.lever.co/acme/u1", applyUrl: "https://jobs.lever.co/acme/u1/apply", categories: { location: "Bengaluru", team: "Marketing" }, createdAt: 1795000000000, workplaceType: "hybrid" }],
    "https://api.ashbyhq.com/posting-api/job-board/acme": { jobs: [{ id: "a1", title: "Developer Advocate", jobUrl: "https://jobs.ashbyhq.com/acme/a1", isRemote: true, publishedAt: "2026-11-21T00:00:00Z" }, { id: "a2", title: "Hidden", jobUrl: "x", isListed: false }] },
    "https://apply.workable.com/api/v1/widget/accounts/acme": { name: "Acme", jobs: [{ shortcode: "W1", title: "Growth Lead", shortlink: "https://apply.workable.com/j/W1", country: "India", telecommuting: true, published_on: "2026-11-22" }] },
  });
  const gh = (await readBoard({ type: "greenhouse", slug: "acme" }, f))!;
  assert.equal(gh.name, "Acme");
  assert.deepEqual(gh.postings[0], { id: "1", title: "DevRel Lead", url: "https://job-boards.greenhouse.io/acme/jobs/1", applyUrl: null, location: "Remote", remote: true, department: null, publishedAt: "2026-11-20T10:00:00.000Z" });
  assert.equal((await readBoard({ type: "lever", slug: "acme" }, f))!.postings[0].department, "Marketing");
  assert.deepEqual((await readBoard({ type: "ashby", slug: "acme" }, f))!.postings.map((p) => p.id), ["a1"]);
  assert.equal((await readBoard({ type: "workable", slug: "acme" }, f))!.postings[0].location, "India");
  assert.equal(await readBoard({ type: "ashby", slug: "nobody" }, f), null);
});

test("a board found by name must have roles and the right name; a link wins", async () => {
  const f = fakeFetch({
    "https://boards-api.greenhouse.io/v1/boards/leap/jobs": { jobs: [{ id: 9, title: "x", absolute_url: "u" }] },
    "https://boards-api.greenhouse.io/v1/boards/leap": { name: "Leap Motion" },
    "https://api.ashbyhq.com/posting-api/job-board/leap": { jobs: [] },
    "https://api.lever.co/v0/postings/leapfinance?mode=json": [{ id: "l1", text: "PM", hostedUrl: "u" }],
  });
  assert.equal((await findBoard("Leap", null, f, { search: false })).board, null);
  const linked = await findBoard("Leap", "https://jobs.lever.co/leapfinance", f, { search: false });
  assert.deepEqual(linked.board, { type: "lever", slug: "leapfinance" });
  assert.equal(linked.via, "your link");
});

const P = (id: string, title: string): Posting => ({ id, title, url: `https://jobs.ashbyhq.com/acme/${id}`, applyUrl: null, location: "Remote", remote: true, department: null, publishedAt: "2026-11-24T00:00:00.000Z" });

test("a scan files new roles that fit, once; the next scan only screens what's new", async () => {
  const board = { jobs: [{ id: "a1", title: "Developer Advocate", jobUrl: "https://jobs.ashbyhq.com/acme/a1" }, { id: "a2", title: "Backend Engineer", jobUrl: "https://jobs.ashbyhq.com/acme/a2" }] };
  const f = fakeFetch({ "https://api.ashbyhq.com/posting-api/job-board/acme": board });
  const { company } = await addCompany("Acme", "https://jobs.ashbyhq.com/acme", { fetch: f });
  assert.equal(company.board_type, "ashby");
  assert.deepEqual(dueCompanies().map((c) => c.id), [company.id]);

  const screened: string[][] = [];
  const screen = async (_c: string, ps: Posting[]) => { screened.push(ps.map((p) => p.id)); return new Map(ps.map((p) => [p.id, /advocate/i.test(p.title) ? "high" as const : "low" as const])); };
  const r1 = await scanCompany(company.id, { fetch: f, screen });
  assert.deepEqual([r1.postings, r1.newPostings, r1.matches], [2, 2, 1]);
  const o = get<{ role: string; source: string; source_url: string; pack_status: string; jd_text: string }>("SELECT * FROM opportunities")!;
  assert.deepEqual([o.role, o.source, o.pack_status], ["Developer Advocate", "company:Acme", "queued"]);
  assert.match(o.jd_text, /Ashby board/);
  assert.deepEqual(dueCompanies(), []);

  board.jobs.push({ id: "a3", title: "Community Lead", jobUrl: "https://jobs.ashbyhq.com/acme/a3" });
  const r2 = await scanCompany(company.id, { fetch: f, screen });
  assert.deepEqual(screened, [["a1", "a2"], ["a3"]]);
  assert.equal(r2.matches, 0);
  assert.equal(all("SELECT * FROM opportunities").length, 1);
});

test("a board posting for a role I already track leaves that role's source and links alone", async () => {
  const mine = upsertOpportunity("Acme", "Developer Advocate", { status: "ready", source: "sheet_import", apply_url: "https://jobs.ashbyhq.com/acme/old/application" });
  const f = fakeFetch({ "https://api.ashbyhq.com/posting-api/job-board/acme": { jobs: [{ id: "new", title: "Developer Advocate", jobUrl: "https://jobs.ashbyhq.com/acme/new" }] } });
  const { company } = await addCompany("Acme", "https://jobs.ashbyhq.com/acme", { fetch: f });
  const r = await scanCompany(company.id, { fetch: f, screen: async (_c, ps) => new Map(ps.map((p) => [p.id, "high" as const])) });
  assert.equal(r.matches, 0);
  const after = get<{ source: string; apply_url: string }>("SELECT * FROM opportunities WHERE id = $id", { id: mine.id })!;
  assert.deepEqual([after.source, after.apply_url], ["sheet_import", "https://jobs.ashbyhq.com/acme/old/application"]);
});

test("a company with no board but a careers page is watched as a page instead", async () => {
  const f = fakeFetch({ "https://careers.example.com/": "<html><body>Our open roles</body></html>" });
  const { company, found } = await addCompany("Example Co", "https://careers.example.com/", { fetch: f });
  assert.equal(found.board, null);
  assert.ok(company.source_id);
  assert.equal(get<{ url: string }>("SELECT url FROM sources")!.url, "https://careers.example.com/");
  await assert.rejects(scanCompany(company.id, { fetch: f }), /careers page/);
});

test("people I already know at a company are found through any role there", () => {
  const old = upsertOpportunity("Factory", "Head of Community", { status: "applied" });
  const c = upsertContact({ name: "Matan Grinberg" });
  run("INSERT INTO outreach (opportunity_id, contact_id, status) VALUES ($o, $c, 'replied')", { o: old.id, c: c.id });
  assert.deepEqual(knownPeopleAt("Factory (relocation: US)"), [{ name: "Matan Grinberg", how: "you've talked" }]);
  assert.deepEqual(knownPeopleAt("Stripe"), []);
});

test("companies from my roles are added on their own, starting from what's open now, and stay removed once I remove them", async () => {
  assert.equal(cleanCompanyName("Factory (relocation: US)"), "Factory");
  assert.equal(cleanCompanyName("Modular, a Qualcomm company (relocation: US or Canada)"), "Modular");
  assert.equal(cleanCompanyName("Okta, Inc."), "Okta");
  upsertOpportunity("Factory (relocation: US)", "Developer Relations Lead", { status: "ready", apply_url: "https://jobs.ashbyhq.com/factory/a6/application" });
  upsertOpportunity("Factory", "Head of Community", { status: "applied" });
  upsertOpportunity("Packt", "Growth Lead", { status: "rejected", apply_url: "https://apply.workable.com/packtpublishing/j/X/apply" });
  upsertOpportunity("Unknown", "Community Manager", { status: "ready" });
  upsertOpportunity("Skipped Co", "Engineer", { status: "skipped" });
  upsertOpportunity("Mercor", "Writer", { status: "offer", apply_url: "https://work.mercor.com" });
  assert.deepEqual(candidateCompanies().map((c) => c.name).sort(), ["Factory", "Mercor", "Packt"]);

  const f = fakeFetch({
    "https://api.ashbyhq.com/posting-api/job-board/factory": { jobs: [{ id: "f1", title: "Engineer", jobUrl: "u" }, { id: "f2", title: "DevRel", jobUrl: "u" }] },
    "https://apply.workable.com/api/v1/widget/accounts/packtpublishing": { name: "Packt", jobs: [{ shortcode: "W1", title: "Sales", url: "u" }] },
    "https://work.mercor.com": "<html>no board here</html>",
  });
  const r = await autoAddCompanies(f);
  assert.deepEqual(r.added.sort(), ["Factory", "Packt"]);
  assert.deepEqual(r.noBoard, ["Mercor"]);
  const factory = get<{ id: number; seen_ids: string; added_via: string }>("SELECT * FROM companies WHERE name = 'Factory'")!;
  assert.deepEqual(JSON.parse(factory.seen_ids), ["f1", "f2"]);
  assert.equal(factory.added_via, "auto");
  assert.equal(get<{ n: number }>("SELECT count(*) n FROM sources")!.n, 0);
  assert.deepEqual(candidateCompanies(), []);

  removeCompany(factory.id);
  assert.deepEqual(candidateCompanies(), []);
});

test("a board guessed from a name that lists none of my roles waits for me to confirm it", async () => {
  upsertOpportunity("Leap", "Program Manager", { status: "applied" });
  upsertOpportunity("Kong", "Developer Advocate", { status: "ready" });
  const f = fakeFetch({
    "https://api.ashbyhq.com/posting-api/job-board/leap": { jobs: [{ id: "l1", title: "Enterprise Sales Executive", jobUrl: "u" }] },
    "https://api.ashbyhq.com/posting-api/job-board/kong": { jobs: [{ id: "k1", title: "Developer Advocate", jobUrl: "u" }] },
  });
  const r = await autoAddCompanies(f);
  assert.deepEqual(r.added, ["Kong"]);
  assert.deepEqual(r.toCheck, ["Leap"]);
  const leap = get<{ id: number; status: string; needs_check: number }>("SELECT * FROM companies WHERE name = 'Leap'")!;
  assert.deepEqual([leap.status, leap.needs_check], ["paused", 1]);
  assert.equal(dueCompanies().some((c) => c.id === leap.id), false);
});

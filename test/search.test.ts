import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { run, useMemoryDb } from "../src/db/index.ts";
import { upsertContact } from "../src/db/contacts.ts";
import { upsertOpportunity } from "../src/db/opportunities.ts";
import { isLink, linkKind, searchAll } from "../src/web/search.ts";

beforeEach(() => useMemoryDb());

test("links are told apart: posting, board, profile, post", () => {
  assert.equal(linkKind("https://job-boards.greenhouse.io/arizeai/jobs/6128123004"), "posting");
  assert.equal(linkKind("https://www.linkedin.com/jobs/view/4012345678/"), "posting");
  assert.equal(linkKind("https://boards.greenhouse.io/arizeai"), "board");
  assert.equal(linkKind("https://jobs.lever.co/factory"), "board");
  assert.equal(linkKind("https://kong.com/careers"), "board");
  assert.equal(linkKind("https://www.linkedin.com/in/someone/"), "profile");
  assert.equal(linkKind("https://x.com/founder/status/1890000000000"), "post");
  assert.ok(isLink("www.example.com/jobs"));
  assert.ok(!isLink("developer advocate"));
});

test("a job board link offers to watch the company first; a posting offers a pack", () => {
  const board = searchAll("https://jobs.lever.co/factory");
  assert.equal(board[0].label, "Add factory as a target company");
  assert.equal(board[0].post?.action, "/companies");
  const posting = searchAll("https://job-boards.greenhouse.io/arizeai/jobs/6128123004");
  assert.equal(posting[0].label, "Prepare an application for this posting");
  assert.equal(posting[0].post?.action, "/add");
});

test("a link already tracked opens the role instead of adding it again", () => {
  const o = upsertOpportunity("Arize AI", "Education Engineer", { status: "ready", apply_url: "https://job-boards.greenhouse.io/arizeai/jobs/6128123004" });
  const hits = searchAll("https://job-boards.greenhouse.io/arizeai/jobs/6128123004?gh_src=x");
  assert.equal(hits[0].href, `/o/${o.id}`);
  assert.ok(!hits.some((h) => h.post?.action === "/add"));
});

test("words search roles, companies, people and tasks, and offer to watch the company", () => {
  upsertOpportunity("Kong", "Developer Advocate", { status: "ready" });
  upsertContact({ name: "Ravi Kumar", title: "DevRel at Kong" });
  run("INSERT INTO companies (name, interval_hours, status) VALUES ('Kong', 3, 'active')");
  const groups = new Set(searchAll("kong").map((h) => h.group));
  for (const g of ["Roles", "Companies", "People"]) assert.ok(groups.has(g as never), g);
  assert.ok(!searchAll("kong").some((h) => h.label.startsWith("Watch “kong”")), "already watched");
  assert.ok(searchAll("stripe").some((h) => h.post?.action === "/companies"));
  assert.ok(searchAll("progress").some((h) => h.href === "/progress"));
});

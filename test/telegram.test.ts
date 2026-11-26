import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { useMemoryDb } from "../src/db/index.ts";
import { upsertOpportunity } from "../src/db/opportunities.ts";
import { closingNote } from "../src/notify/messages.ts";
import { chunks, truncateHtml } from "../src/notify/telegram.ts";
import { fileMessages } from "../src/pipeline/ingest.ts";
import { resumeHtml } from "../src/resume/render.ts";
import { sample } from "./resume.test.ts";

beforeEach(() => useMemoryDb());

const balanced = (t: string) => {
  const opens = (t.match(/<(b|i|s|pre|blockquote)(\s[^>]*)?>/g) ?? []).length;
  const closes = (t.match(/<\/(b|i|s|pre|blockquote)>/g) ?? []).length;
  return opens === closes;
};

test("a long message split in two keeps every tag closed in each part (the Toast pack failure)", () => {
  const para = "A sentence about the role that goes on for a while. ".repeat(12);
  const text = `<b>Application</b> · Toast\n\n<b>Cover note</b>\n<blockquote expandable>${Array(8).fill(para).join("\n\n")}</blockquote>\n\n<b>Form answers</b>\n<blockquote expandable>${Array(6).fill(para).join("\n\n")}</blockquote>`;
  const parts = chunks(text);
  assert.ok(parts.length > 1);
  for (const p of parts) { assert.ok(p.length <= 4096, `part is ${p.length} long`); assert.ok(balanced(p), p.slice(0, 80)); }
  assert.match(parts[1], /^<blockquote expandable>/);
});

test("a caption cut at Telegram's limit never breaks a tag or an entity", () => {
  const cap = `<b>Role</b> · Co\n${"Double-check: Inclusion &amp; Impact. ".repeat(40)}<i>end</i>`;
  const cut = truncateHtml(cap, 1024);
  assert.ok(cut.length <= 1024);
  assert.ok(balanced(cut));
  assert.doesNotMatch(cut, /&[a-z]*…/);
});

test("closing a quiet role drafts a note for the real conversation, and says when only a no-reply sent mail", () => {
  const g = upsertOpportunity("Garage.app", "Community Manager", { status: "interviewing" });
  const base = { jobs: [], about_company: "Garage.app", about_role: "Community Manager", person_title: null, needs_my_reply: false, update: "none" as const };
  fileMessages([
    { id: "1", threadId: "conv", from: "Charu Anand <hr@garage.app>", fromEmail: "hr@garage.app", to: "me", subject: "Re: Interview: Community Manager | Garage.app", date: "2026-09-08T10:00:00Z", fromMe: false, labels: [], body: "See you then" },
    { id: "2", threadId: "inv", from: "Charu Anand <hr@garage.app>", fromEmail: "hr@garage.app", to: "me", subject: "Updated invitation: Interview: Community Manager", date: "2026-09-09T10:00:00Z", fromMe: false, labels: [], body: "Invite" },
  ], [{ message_id: "1", kind: "conversation", person_name: "Charu Anand", ...base }, { message_id: "2", kind: "conversation", person_name: "Charu Anand", ...base }],
  { scanned: 0, newJobs: 0, conversations: 0, needsReply: 0, newOpportunityIds: [] });
  const n = closingNote(g);
  assert.match(n.where, /"Re: Interview: Community Manager \| Garage\.app" with Charu Anand/);
  assert.match(n.text, /^Hi Charu,/);
  assert.match(n.text, /Community Manager role/);
  assert.doesNotMatch(n.text, /—/);
  assert.match(n.threadUrl!, /#all\/conv$/);

  const f = upsertOpportunity("Factory", "Head of Community", { status: "applied" });
  fileMessages([{ id: "3", threadId: "ats", from: "Factory <no-reply@ashbyhq.com>", fromEmail: "no-reply@ashbyhq.com", to: "me", subject: "Factory Application", date: "2026-09-16T10:00:00Z", fromMe: false, labels: [], body: "Thanks" }],
    [{ message_id: "3", kind: "application_update", jobs: [], about_company: "Factory", about_role: "Head of Community", person_name: null, person_title: null, needs_my_reply: false, update: "applied" }],
    { scanned: 0, newJobs: 0, conversations: 0, needsReply: 0, newOpportunityIds: [] });
  const nf = closingNote(f);
  assert.match(nf.where, /no-reply address/);
  assert.equal(nf.threadUrl, null);
});

test("the resume shows my name once, as its title", () => {
  const body = resumeHtml(sample).split("<body>")[1];
  assert.equal(body.match(/Sam Rivera/g)?.length, 1);
});

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { get, run, useMemoryDb } from "../src/db/index.ts";
import { upsertContact } from "../src/db/contacts.ts";
import { getOpportunity, updateOpportunity, upsertOpportunity } from "../src/db/opportunities.ts";
import { fileEvents, type CalEvent } from "../src/pipeline/interviews.ts";
import { linkThread, type ClassifiedItem } from "../src/pipeline/ingest.ts";

beforeEach(() => useMemoryDb());

/** HackerRank: interviewing, a "thanks for your time" no on 24 Nov, then a new invite for 26 Nov. */
function rejectedRole() {
  const o = upsertOpportunity("HackerRank", "Senior DevRel Engineer", { status: "interviewing" });
  const c = upsertContact({ name: "Anushree VN", email: "anushree@hackerrank.com" });
  run("INSERT INTO threads (channel, external_id, opportunity_id, contact_id, subject, kind) VALUES ('email', 'g1', $o, $c, 'Interview', 'conversation')", { o: o.id, c: c.id });
  run("INSERT INTO events (at, kind, ref, detail) VALUES ('2026-11-24T19:27:33.764Z', 'opportunity.status', $ref, '{\"from\":\"interviewing\",\"to\":\"rejected\",\"byUser\":false}')", { ref: String(o.id) });
  run("UPDATE opportunities SET status = 'rejected', skip_reason = 'Did not clear the interview round', updated_at = '2026-11-24T19:27:33.764Z' WHERE id = $id", { id: o.id });
  return o;
}
const event = (id: string, start: string, end: string): CalEvent => ({
  id, summary: "Interview with HackerRank Careers", start: { dateTime: start }, end: { dateTime: end },
  attendees: [{ email: "careers@hackerrank.com" }, { email: "me@example.com", self: true }],
});

test("a new interview on the calendar after a rejection reopens the role and is filed", () => {
  const o = rejectedRole();
  const r = fileEvents([event("e-new", "2026-11-26T16:30:00.000Z", "2026-11-26T17:30:00.000Z")], new Date("2026-11-26T14:40:00.000Z"));
  assert.equal(r.matched, 1);
  assert.deepEqual(r.moved, [o.id]);
  const now = getOpportunity(o.id)!;
  assert.equal(now.status, "interviewing");
  assert.equal(now.skip_reason, null);
  assert.equal(get<{ opportunity_id: number }>("SELECT opportunity_id FROM meetings WHERE event_id = 'e-new'")!.opportunity_id, o.id);
});

test("an earlier round is filed as history but does not reopen a rejected role", () => {
  const o = rejectedRole();
  const r = fileEvents([event("e-old", "2026-11-19T09:30:00.000Z", "2026-11-19T10:30:00.000Z")], new Date("2026-11-26T14:40:00.000Z"));
  assert.equal(r.matched, 1);
  assert.equal(getOpportunity(o.id)!.status, "rejected");
});

test("an interview invite emailed after the rejection reopens the role; an old one does not", () => {
  const o = rejectedRole();
  const item = (over: Partial<ClassifiedItem>): ClassifiedItem => ({ message_id: "m", kind: "application_update", jobs: [], about_company: "HackerRank", about_role: "Senior DevRel Engineer", person_name: null, person_title: null, needs_my_reply: false, update: "interview", ...over });
  const mail = (id: string, date: string) => ({ id, threadId: id, from: "", fromEmail: "careers@hackerrank.com", to: "", subject: "Senior DevRel Engineer || HackerRank Interview Invitation", date, fromMe: false, labels: [], body: "" });
  linkThread(mail("old", "2026-11-17T11:10:19.000Z"), item({}));
  assert.equal(getOpportunity(o.id)!.status, "rejected");
  linkThread(mail("new", "2026-11-25T17:11:11.000Z"), item({}));
  assert.equal(getOpportunity(o.id)!.status, "interviewing");
});

test("automation still cannot move a role backwards on its own", () => {
  const o = upsertOpportunity("Kong", "Developer Advocate", { status: "interviewing" });
  updateOpportunity(o.id, { status: "applied" });
  assert.equal(getOpportunity(o.id)!.status, "interviewing");
  updateOpportunity(o.id, { status: "offer" });
  updateOpportunity(o.id, { status: "rejected" });
  assert.equal(getOpportunity(o.id)!.status, "rejected", "offer to rejected stays allowed");
});

test("a calendar event titled as an interview is kept even with no matching role; other events are not", () => {
  const now = new Date("2026-11-26T10:00:00.000Z");
  const r = fileEvents([
    { id: "x1", summary: "Interview: Community Lead with Acme", start: { dateTime: "2026-11-28T06:00:00.000Z" }, end: { dateTime: "2026-11-28T07:00:00.000Z" }, attendees: [{ email: "talent@acme.io" }] },
    { id: "x2", summary: "Dentist", start: { dateTime: "2026-11-28T09:00:00.000Z" }, end: { dateTime: "2026-11-28T10:00:00.000Z" } },
  ], now);
  assert.equal(r.matched, 1);
  assert.equal(get<{ n: number }>("SELECT count(*) n FROM meetings")!.n, 1);
  assert.equal(get<{ opportunity_id: number | null }>("SELECT opportunity_id FROM meetings WHERE event_id = 'x1'")!.opportunity_id, null);
  // Once the role is tracked, the next sync links the interview to it.
  const o = upsertOpportunity("Acme", "Community Lead", { status: "applied" });
  fileEvents([{ id: "x1", summary: "Interview: Community Lead with Acme", start: { dateTime: "2026-11-28T06:00:00.000Z" }, end: { dateTime: "2026-11-28T07:00:00.000Z" }, attendees: [{ email: "talent@acme.io" }] }], now);
  assert.equal(get<{ opportunity_id: number }>("SELECT opportunity_id FROM meetings WHERE event_id = 'x1'")!.opportunity_id, o.id);
});

test("a Greenhouse-scheduled interview naming a rejected company reopens it (the HackerRank case)", () => {
  const o = rejectedRole();
  const r = fileEvents([{ id: "gh1", summary: "Interview with HackerRank Careers", start: { dateTime: "2026-11-26T16:30:00.000Z" }, end: { dateTime: "2026-11-26T17:30:00.000Z" },
    attendees: [{ email: "schedule@rose.greenhouse.io" }, { email: "me@example.com", self: true }] }], new Date("2026-11-26T14:45:00.000Z"));
  assert.deepEqual(r.moved, [o.id]);
  assert.equal(getOpportunity(o.id)!.status, "interviewing");
  assert.equal(get<{ opportunity_id: number }>("SELECT opportunity_id FROM meetings WHERE event_id = 'gh1'")!.opportunity_id, o.id);
});

test("an interview already filed without a role is linked and reopens the role on the next sync", () => {
  const o = rejectedRole();
  run("INSERT INTO meetings (event_id, opportunity_id, title, start_at, end_at, status, attendees) VALUES ('gh2', NULL, 'Interview with HackerRank Careers', '2026-11-26T16:30:00.000Z', '2026-11-26T17:30:00.000Z', 'confirmed', '[]')");
  fileEvents([{ id: "gh2", summary: "Interview with HackerRank Careers", start: { dateTime: "2026-11-26T16:30:00.000Z" }, end: { dateTime: "2026-11-26T17:30:00.000Z" }, attendees: [{ email: "schedule@rose.greenhouse.io" }] }], new Date("2026-11-26T14:45:00.000Z"));
  assert.equal(get<{ opportunity_id: number }>("SELECT opportunity_id FROM meetings WHERE event_id = 'gh2'")!.opportunity_id, o.id);
  assert.equal(getOpportunity(o.id)!.status, "interviewing");
});

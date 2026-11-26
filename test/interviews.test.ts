import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { all, get, run, useMemoryDb } from "../src/db/index.ts";
import { upsertContact } from "../src/db/contacts.ts";
import { getOpportunity, upsertOpportunity } from "../src/db/opportunities.ts";
import { completeAction, dueActions, reconcileActions } from "../src/loops/engine.ts";
import { companyKey, fileEvents, matchEvent, type CalEvent } from "../src/pipeline/interviews.ts";

beforeEach(() => useMemoryDb());

const ev = (id: string, summary: string, start: string, over: Partial<CalEvent> = {}): CalEvent => ({
  id, summary, status: "confirmed", htmlLink: `https://calendar.google.com/e/${id}`,
  start: { dateTime: start }, end: { dateTime: new Date(new Date(start).getTime() + 45 * 60_000).toISOString() },
  attendees: [{ email: "me@example.com", self: true }], ...over,
});

test("company names reduce to the word a domain or invite would use", () => {
  assert.equal(companyKey("Helius (via Grace; Superteam Talent)"), "helius");
  assert.equal(companyKey("Garage.app"), "garage");
  assert.equal(companyKey("The Community Company"), "community");
});

test("events match by a known contact, the company's domain, or the company named in an interview", () => {
  const roles = [
    { id: 1, company: "Garage.app", status: "applied", updated_at: "2026-11-01", emails: ["charu@garage.app"] },
    { id: 2, company: "Acme", status: "applied", updated_at: "2026-11-01", emails: [] },
    { id: 3, company: "Stripe", status: "found", updated_at: "2026-11-01", emails: [] },
  ];
  assert.deepEqual(matchEvent(ev("a", "Chat", "2026-12-01T05:00:00Z", { attendees: [{ email: "charu@garage.app" }] }), roles), { id: 1, score: 3 });
  assert.deepEqual(matchEvent(ev("b", "Sync", "2026-12-01T05:00:00Z", { attendees: [{ email: "lee@acme.io" }] }), roles), { id: 2, score: 2 });
  assert.deepEqual(matchEvent(ev("c", "Acme interview: round 2", "2026-12-01T05:00:00Z"), roles), { id: 2, score: 1 });
  // A role I haven't applied to needs more than its name in the title.
  assert.equal(matchEvent(ev("d", "Stripe call", "2026-12-01T05:00:00Z"), roles), null);
  assert.equal(matchEvent(ev("e", "Dentist", "2026-12-01T05:00:00Z"), roles), null);
  assert.equal(matchEvent(ev("f", "Lunch", "2026-12-01T05:00:00Z", { attendees: [{ email: "friend@example.com" }] }), roles), null);
});

test("a booked interview: role moves to interviewing, prep is due the day before, follow-ups wait", () => {
  const o = upsertOpportunity("Garage.app", "Community Manager", { status: "applied", date_applied: "2026-11-01" });
  const c = upsertContact({ name: "Charu Anand", email: "charu@garage.app" });
  run(`INSERT INTO threads (channel, external_id, opportunity_id, contact_id, kind) VALUES ('email', 't', $o, $c, 'conversation')`, { o: o.id, c: c.id });
  const r = fileEvents([
    ev("int1", "Interview: Community Manager", "2026-11-28T05:30:00Z", { attendees: [{ email: "charu@garage.app", displayName: "Charu Anand" }], hangoutLink: "https://meet.google.com/abc" }),
    ev("other", "Dentist", "2026-11-28T09:00:00Z"),
  ], new Date("2026-11-25T10:00:00Z"));
  assert.equal(r.matched, 1);
  assert.equal(getOpportunity(o.id)!.status, "interviewing");
  assert.deepEqual(all<{ event_id: string }>("SELECT event_id FROM meetings").map((m) => m.event_id), ["int1"]);

  const now = new Date("2026-11-27T06:00:00Z");
  reconcileActions(now);
  const due = dueActions(now).filter((a) => a.opportunity_id === o.id);
  assert.deepEqual(due.map((a) => a.kind), ["interview"]);
  assert.match(due[0].title, /^Interview Sat 28 Nov/);
  assert.match(due[0].detail!, /Charu Anand/);
  assert.match(due[0].detail!, /meet\.google\.com/);
  assert.equal(due[0].urgent, 1);
});

test("after the interview: a thank-you, then the ladder from the interview date; a cancellation asks to rebook", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "interviewing", date_applied: "2026-11-01" });
  fileEvents([ev("i1", "Acme interview", "2026-11-20T05:00:00Z", { attendees: [{ email: "lee@acme.io" }] })], new Date("2026-11-18T10:00:00Z"));
  const after = new Date("2026-11-20T09:00:00Z");
  reconcileActions(after);
  const thanks = dueActions(after).find((a) => a.opportunity_id === o.id)!;
  assert.match(thanks.title, /^Send a thank-you/);
  completeAction(thanks.id, "done");
  // Five quiet days after the interview: follow up.
  const later = new Date("2026-11-25T09:00:00Z");
  reconcileActions(later);
  assert.ok(dueActions(later).some((a) => a.opportunity_id === o.id && a.rule_key.startsWith("loop:ladder:")));

  fileEvents([ev("i2", "Acme final round", "2026-11-30T05:00:00Z", { attendees: [{ email: "lee@acme.io" }] })], later);
  fileEvents([{ id: "i2", status: "cancelled" }], later);
  reconcileActions(later);
  assert.ok(dueActions(later).some((a) => a.opportunity_id === o.id && /^Rebook/.test(a.title)));
  assert.equal(get<{ status: string }>("SELECT status FROM meetings WHERE event_id = 'i2'")!.status, "cancelled");
});

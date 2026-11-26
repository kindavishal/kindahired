import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { run, useMemoryDb } from "../src/db/index.ts";
import { upsertContact } from "../src/db/contacts.ts";
import { upsertOpportunity } from "../src/db/opportunities.ts";
import { attendeesOf, countdown, getMeeting, interviewCard, interviewPage, whenLabel } from "../src/web/interviews.ts";

beforeEach(() => useMemoryDb());

const NOW = new Date("2026-12-03T06:30:00.000Z"); // 12:00 pm IST, Thu 3 Dec

test("countdown and IST labels read naturally", () => {
  assert.equal(countdown({ start_at: "2026-12-05T06:30:00.000Z", end_at: "2026-12-05T07:30:00.000Z" }, NOW), "in 2 days");
  assert.equal(countdown({ start_at: "2026-12-03T08:30:00.000Z", end_at: "2026-12-03T09:00:00.000Z" }, NOW), "in 2 hours");
  assert.equal(countdown({ start_at: "2026-12-03T06:00:00.000Z", end_at: "2026-12-03T07:00:00.000Z" }, NOW), "happening now");
  assert.equal(whenLabel("2026-12-03T08:30:00.000Z", NOW), "Today, 2:00 pm");
  assert.equal(whenLabel("2026-12-04T06:30:00.000Z", NOW), "Tomorrow, 12:00 pm");
});

test("the prep page gathers the people, the conversation and the role", () => {
  const o = upsertOpportunity("Acme Labs", "Strategic Community Lead", { status: "interviewing", fit_read: "Strong match on community programs.", jd_text: "Run India operations." });
  upsertContact({ name: "Dana Wu", email: "dana@acmelabs.example", title: "Host / Co-host" });
  run(`INSERT INTO meetings (event_id, opportunity_id, title, start_at, end_at, status, join_url, attendees)
       VALUES ('e1', $o, 'Dana / Sam - Followup', '2026-12-05T06:30:00.000Z', '2026-12-05T07:30:00.000Z', 'confirmed', 'https://meet.google.com/abc', $a)`,
    { o: o.id, a: JSON.stringify([{ email: "dana@acmelabs.example", name: null }, { email: "sam@example.com", name: null }]) });
  run("INSERT INTO threads (channel, external_id, opportunity_id, subject, kind) VALUES ('email', 'g1', $o, 'Next steps', 'conversation')", { o: o.id });
  run("INSERT INTO messages (thread_id, external_id, from_me, sender, sent_at, body) VALUES (1, 'm1', 0, 'Dana Wu <dana@acmelabs.example>', '2026-11-30T10:00:00.000Z', 'Looking forward to Saturday. Bring your India plan.')");
  const m = getMeeting(1)!;
  assert.deepEqual(attendeesOf(m).map((p) => [p.name, p.title]), [["Dana Wu", "Host / Co-host"]]);
  const html = interviewPage(1, NOW)!;
  for (const s of ["Strategic Community Lead at Acme Labs", "Dana Wu", "Bring your India plan", "Strong match on community programs", "Join the call", "Re-read their last message"]) assert.ok(html.includes(s), s);
  const card = interviewCard(m, NOW);
  assert.match(card, /Interview in 2 days/);
  assert.match(card, /Open interview prep/);
  assert.match(card, /Dana Wu wrote/);
});

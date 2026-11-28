import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { get, run, useMemoryDb } from "../src/db/index.ts";
import { getOpportunity, upsertOpportunity, updateOpportunity } from "../src/db/opportunities.ts";
import { completeAction, dueActions, reconcileActions, remindAgain, stalledRoles } from "../src/loops/engine.ts";
import { DEFAULT_TIMERS, getTimers, resetTimers, setTimers } from "../src/loops/timers.ts";

beforeEach(() => useMemoryDb());

const at = (d: string) => new Date(`${d}T10:00:00Z`);
const due = (d: string, id: number) => { reconcileActions(at(d)); return dueActions(at(d)).filter((a) => a.opportunity_id === id); };
const ladderStep = (d: string, id: number) => due(d, id).find((a) => a.rule_key.startsWith("loop:ladder:"));

test("an application walks the ladder: follow up, follow up again on another channel, close warmly", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "applied", date_applied: "2026-11-01" });
  // Day 1: reach a person. Day 7: nothing else due before then.
  assert.deepEqual(due("2026-11-02", o.id).map((a) => a.title), ["Reach a person: DevRel at Acme"]);
  completeAction(due("2026-11-02", o.id)[0].id, "done", at("2026-11-02"));
  assert.equal(due("2026-11-05", o.id).length, 0);

  // A week after the first note: follow up.
  const one = ladderStep("2026-11-09", o.id)!;
  assert.match(one.title, /^Gone quiet: DevRel at Acme \(8 days\)/);
  assert.match(one.detail!, /Step 1 of 3/);
  completeAction(one.id, "done", at("2026-11-09"));

  // Not due again until a week after that follow-up, and then on another channel.
  assert.equal(ladderStep("2026-11-12", o.id), undefined);
  const two = ladderStep("2026-11-16", o.id)!;
  assert.match(two.title, /^Follow up again/);
  assert.match(two.detail!, /different channel/);
  completeAction(two.id, "done", at("2026-11-16"));

  const three = ladderStep("2026-11-23", o.id)!;
  assert.match(three.title, /^Send a last note/);
  assert.equal(three.urgent, 1);
});

test("a reply from their side restarts the ladder", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "applied", date_applied: "2026-11-01" });
  run(`INSERT INTO events (at, kind, ref) VALUES ('2026-11-08T10:00:00Z', 'followup.sent', $id)`, { id: String(o.id) });
  assert.match(ladderStep("2026-11-16", o.id)!.title, /Follow up again/);
  run(`INSERT INTO threads (channel, external_id, opportunity_id, subject, kind, last_message_at, last_from)
       VALUES ('linkedin', 'li1', $id, 'DevRel', 'conversation', '2026-11-15T10:00:00Z', 'them')`, { id: o.id });
  assert.equal(ladderStep("2026-11-16", o.id), undefined);
  assert.match(ladderStep("2026-11-23", o.id)!.title, /^Follow up: /);
});

test("a taken-down posting moves the follow-up up to now", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "applied", date_applied: "2026-11-01" });
  updateOpportunity(o.id, { posting_state: "closed", posting_checked_at: "2026-11-03T10:00:00Z" });
  const a = ladderStep("2026-11-03", o.id)!;
  assert.match(a.title, /^Posting taken down/);
  assert.match(a.detail!, /likely filled/);
});

test("months of silence: one check-in, then the warm close", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "interviewing", date_applied: "2026-08-01" });
  const a = ladderStep("2026-11-01", o.id)!;
  assert.match(a.title, /^Likely closed: DevRel at Acme \(\d+ days\)/);
  completeAction(a.id, "done", at("2026-11-01"));
  assert.match(ladderStep("2026-11-08", o.id)!.title, /^Send a last note/);
});

test("offers, failed packs and unscreened roles all get a next step", () => {
  const offer = upsertOpportunity("Acme", "DevRel", { status: "offer" });
  const failed = upsertOpportunity("Beta", "Community Lead", { status: "found", pack_status: "failed", pack_error: "timed out" });
  const parked = upsertOpportunity("Unknown", "Community Manager", { status: "found" });
  const building = upsertOpportunity("Gamma", "Advocate", { status: "found", pack_status: "queued" });
  reconcileActions();
  const titles = dueActions(new Date(Date.now() + 60_000)).map((a) => a.title);
  assert.ok(titles.includes("Respond to the offer: DevRel at Acme"));
  assert.ok(titles.includes("Pack failed: Community Lead at Beta"));
  assert.ok(titles.includes("Not screened in: Community Manager at Unknown"));
  assert.ok(!titles.some((t) => t.includes("Gamma")));
  assert.deepEqual(stalledRoles(), []);
  void [offer, failed, parked, building];
});

test("a role no one decided on is skipped after the parked window", () => {
  const o = upsertOpportunity("Unknown", "Community Manager", { status: "found" });
  run("UPDATE opportunities SET created_at = '2026-10-01T00:00:00Z' WHERE id = $id", { id: o.id });
  reconcileActions(at("2026-10-20"));
  assert.equal(getOpportunity(o.id)!.status, "skipped");
  assert.match(getOpportunity(o.id)!.skip_reason!, /Not decided within 14 days/);
});

test("dropping a reminder without changing the role shows it as stalled, until I ask for it back", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "applied", date_applied: "2026-11-01" });
  reconcileActions(at("2026-11-20"));
  for (const a of dueActions(at("2026-11-20")).filter((x) => x.opportunity_id === o.id)) completeAction(a.id, "dropped");
  reconcileActions(at("2026-11-20"));
  assert.deepEqual(stalledRoles().map((r) => r.id), [o.id]);
  remindAgain(o.id, at("2026-11-20"));
  assert.deepEqual(stalledRoles(), []);
});

test("timers are editable, clamped to their range, and change when things are due", () => {
  assert.deepEqual(getTimers(), DEFAULT_TIMERS);
  setTimers({ followUp1Days: 3, replyOwedHours: 9999 });
  assert.equal(getTimers().followUp1Days, 3);
  assert.equal(getTimers().replyOwedHours, 168);
  const o = upsertOpportunity("Acme", "DevRel", { status: "applied", date_applied: "2026-11-01" });
  run(`INSERT INTO events (at, kind, ref, detail) VALUES ('2026-11-01T10:00:00Z', 'followup.sent', $id, 'first touch')`, { id: String(o.id) });
  assert.ok(ladderStep("2026-11-04", o.id));
  resetTimers();
  assert.equal(get<{ value: string }>("SELECT value FROM kv WHERE key = 'timers'")!.value, "{}");
  assert.equal(ladderStep("2026-11-05", o.id), undefined);
});

test("the message that opens a conversation I started is reaching out, not a follow-up", () => {
  const o = upsertOpportunity("Leap", "Program Manager", { status: "applied", date_applied: "2026-11-23" });
  run(`INSERT INTO threads (channel, external_id, opportunity_id, kind, last_message_at, last_from)
       VALUES ('linkedin', 'lv', $id, 'conversation', '2026-11-23T08:00:00Z', 'me')`, { id: o.id });
  const t = get<{ id: number }>("SELECT id FROM threads WHERE external_id = 'lv'")!;
  run(`INSERT INTO messages (thread_id, external_id, from_me, sent_at, body) VALUES ($t, 'm1', 1, '2026-11-23T08:00:00Z', 'Hi Nina')`, { t: t.id });
  const a = ladderStep("2026-11-30", o.id)!;
  assert.match(a.title, /^(Follow up|Gone quiet): /);
  assert.match(a.detail!, /Step 1 of 3/);
});

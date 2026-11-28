import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { get, run, useMemoryDb } from "../src/db/index.ts";
import { upsertContact } from "../src/db/contacts.ts";
import { upsertOpportunity } from "../src/db/opportunities.ts";
import { completeAction, dueActions, reconcileActions } from "../src/loops/engine.ts";
import { closureNote, loadRelationships, setStayInTouch } from "../src/pipeline/relationships.ts";

beforeEach(() => useMemoryDb());

/** A thread between me and a contact on a role, with messages at the given times. */
function convo(contact: string, email: string, oppId: number | null, msgs: [boolean, string][], channel = "email") {
  const c = upsertContact({ name: contact, email });
  run(`INSERT INTO threads (channel, external_id, opportunity_id, contact_id, kind, last_message_at, last_from)
       VALUES ($ch, $x, $o, $c, 'conversation', $at, $from)`,
  { ch: channel, x: `${contact}-${oppId}`, o: oppId, c: c.id, at: msgs.at(-1)![1], from: msgs.at(-1)![0] ? "me" : "them" });
  const t = get<{ id: number }>("SELECT id FROM threads WHERE external_id = $x", { x: `${contact}-${oppId}` })!;
  msgs.forEach(([me, at], i) => run("INSERT INTO messages (thread_id, external_id, from_me, sent_at, body) VALUES ($t, $id, $me, $at, 'x')",
    { t: t.id, id: `${contact}-${oppId}-${i}`, me: me ? 1 : 0, at }));
  return c;
}
const at = (d: string) => new Date(`${d}T10:00:00Z`);

test("warmth comes from real exchanges; one-way mail and machine inboxes don't count", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "applied" });
  convo("Mira Shah", "mira@acme.io", o.id, [[true, "2026-11-01T10:00:00Z"], [false, "2026-11-02T10:00:00Z"], [true, "2026-11-03T10:00:00Z"], [false, "2026-11-04T10:00:00Z"]]);
  convo("Sam Lee", "sam@acme.io", o.id, [[true, "2026-11-01T10:00:00Z"], [false, "2026-11-05T10:00:00Z"]]);
  convo("Spam Recruiter", "r@spam.io", null, [[false, "2026-11-01T10:00:00Z"]]);
  convo("Charu Anand", "hr@garage.app", null, [[false, "2026-11-01T10:00:00Z"], [true, "2026-11-02T10:00:00Z"]]);
  convo("Onboarding", "hi@tool.io", null, [[false, "2026-11-01T10:00:00Z"], [true, "2026-11-02T10:00:00Z"]]);
  const w = Object.fromEntries(loadRelationships().map((r) => [r.name, [r.warmth, r.automated]]));
  assert.deepEqual(w, {
    "Mira Shah": ["close", false], "Sam Lee": ["warm", false], "Spam Recruiter": ["cold", false],
    "Charu Anand": ["warm", false], "Onboarding": ["warm", true],
  });
});

test("a no gets a warm closing note per person; done, it becomes a stay-in-touch reminder", () => {
  const o = upsertOpportunity("Temporal", "Developer Advocate", { status: "rejected", skip_reason: "Role is Singapore-based" });
  convo("Eric Stutzman", "eric@temporal.io", o.id, [[true, "2026-11-10T10:00:00Z"], [false, "2026-11-12T10:00:00Z"], [true, "2026-11-13T10:00:00Z"], [false, "2026-11-19T10:00:00Z"]]);
  const now = at("2026-11-20");
  reconcileActions(now);
  const close = dueActions(now).find((a) => a.rule_key.startsWith("loop:close:"))!;
  assert.equal(close.title, "Send a thank-you: Eric Stutzman (Developer Advocate at Temporal)");
  assert.match(close.detail!, /by email \(eric@temporal\.io\)/);
  assert.match(close.detail!, /Hi Eric,/);
  assert.match(close.detail!, /being clear about why/);

  completeAction(close.id, "done", now);
  reconcileActions(now);
  assert.ok(!dueActions(now).some((a) => a.rule_key.startsWith("loop:close:")));
  const later = at("2027-01-20");
  reconcileActions(later);
  const touch = dueActions(later).find((a) => a.rule_key.startsWith("loop:touch:"))!;
  assert.match(touch.title, /^Check in: Eric Stutzman \(Temporal\)/);
  assert.equal(touch.due_at.slice(0, 10), "2027-01-19");
});

test("a close I already wrote myself, a low-match skip, and a closed ghosted role need no note", () => {
  const a = upsertOpportunity("Exotel", "Community Manager", { status: "rejected" });
  convo("Aishwarya", "a@exotel.com", a.id, [[true, "2026-11-10T10:00:00Z"], [false, "2026-11-12T10:00:00Z"], [true, "2026-11-13T10:00:00Z"]]);
  const b = upsertOpportunity("Garage", "Community Manager", { status: "rejected", skip_reason: "No response; closing note sent" });
  convo("Charu", "c@garage.app", b.id, [[true, "2026-11-10T10:00:00Z"], [false, "2026-11-12T10:00:00Z"]]);
  reconcileActions(at("2026-11-14"));
  assert.ok(!dueActions(at("2026-11-14")).some((x) => x.rule_key.startsWith("loop:close:")));
});

test("a new role where I know someone: tell them first; stopping reminders is respected", () => {
  const old = upsertOpportunity("Factory", "Head of Community", { status: "rejected" });
  const c = convo("Matan", "matan@factory.ai", old.id, [[true, "2026-09-01T10:00:00Z"], [false, "2026-09-02T10:00:00Z"]]);
  const fresh = upsertOpportunity("Factory (relocation: US)", "Developer Relations Lead", { status: "ready", pack_status: "ready" });
  reconcileActions(at("2026-11-20"));
  const tell = get<{ title: string; detail: string; status: string }>("SELECT * FROM actions WHERE rule_key = $k", { k: `loop:reengage:${fresh.id}:${c.id}` })!;
  assert.equal(tell.status, "open");
  assert.match(tell.title, /^Tell Matan about Developer Relations Lead/);
  assert.match(tell.detail!, /from Head of Community/);

  setStayInTouch(c.id, 0);
  reconcileActions(at("2026-11-20"));
  assert.equal(get<{ status: string }>("SELECT status FROM actions WHERE rule_key = $k", { k: `loop:reengage:${fresh.id}:${c.id}` })!.status, "done");
  assert.ok(!dueActions(at("2027-06-01")).some((x) => x.rule_key.startsWith(`loop:touch:${c.id}:`)));
});

test("closing notes read right for each way a role ends", () => {
  const role = { role: "DevRel Lead", company: "ZenRows (via X)" };
  assert.match(closureNote("rejected", { name: "Alex Morgan" }, role, { met: true, me: "Sam" }), /^Hi Alex,\n\nThanks for letting me know about the DevRel Lead role\. I enjoyed our conversation/);
  assert.match(closureNote("withdrew", { name: "Alex" }, role, { met: false, me: "Sam" }), /step back from this one/);
  assert.match(closureNote("rejected", { name: "Alex" }, role, { met: false, me: "Sam" }), /work with ZenRows at some point/);
});

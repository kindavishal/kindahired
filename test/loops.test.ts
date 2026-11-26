import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { all, get, run, useMemoryDb } from "../src/db/index.ts";
import { getOpportunity, upsertOpportunity, updateOpportunity } from "../src/db/opportunities.ts";
import { importSheetData, mapRoleStatus, parseLooseDate, readSheetFiles } from "../src/import/sheet.ts";
import { completeAction, dueActions, reconcileActions } from "../src/loops/engine.ts";

beforeEach(() => useMemoryDb());

test("parses the date formats used in the tracker", () => {
  assert.equal(parseLooseDate("18 Nov 2026"), "2026-11-18");
  assert.equal(parseLooseDate("23 Nov 2026 (WhatsApp)"), "2026-11-23");
  assert.equal(parseLooseDate("closes 5 Dec 2026, USD 120K"), "2026-12-05");
  assert.equal(parseLooseDate("Not stated"), null);
  assert.equal(mapRoleStatus("Ask before applying"), "decide");
  assert.equal(mapRoleStatus("Ready to apply"), "ready");
});

test("automation never moves status backwards or overwrites my edits", () => {
  const o = upsertOpportunity("Acme", "DevRel Lead", { status: "applied", source: "cli" });
  updateOpportunity(o.id, { status: "ready" });
  assert.equal(getOpportunity(o.id)!.status, "applied");

  updateOpportunity(o.id, { fit_read: "My own words" }, { byUser: true });
  updateOpportunity(o.id, { fit_read: "Generated words", status: "interviewing" });
  const after = getOpportunity(o.id)!;
  assert.equal(after.fit_read, "My own words");
  assert.equal(after.status, "interviewing");
});

test("the same role from two sources merges into one opportunity", () => {
  upsertOpportunity("Kong (Volcano)", "Developer Advocate, Volcano", { source: "sheet_import" });
  upsertOpportunity("Kong", "Developer Advocate Volcano", { source: "gmail", apply_url: "https://x" });
  assert.equal(all("SELECT * FROM opportunities").length, 1);
});

test("loops appear, refresh and resolve on their own", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "ready", pack_status: "ready", closes_on: "2026-11-26" });
  const now = new Date("2026-11-24T10:00:00Z");
  reconcileActions(now);
  const apply = get<{ title: string; urgent: number }>("SELECT * FROM actions WHERE rule_key = $k", { k: `loop:apply:${o.id}` })!;
  assert.match(apply.title, /closes 26 Nov/);
  assert.equal(apply.urgent, 1);

  // Applying resolves the apply loop. A day later, reaching a person is due; a week of silence
  // later, the first follow-up.
  updateOpportunity(o.id, { status: "applied", date_applied: "2026-11-24" });
  reconcileActions(now);
  assert.equal(get<{ status: string }>("SELECT status FROM actions WHERE rule_key = $k", { k: `loop:apply:${o.id}` })!.status, "done");
  assert.equal(dueActions(now).length, 0);
  assert.deepEqual(dueActions(new Date("2026-11-25T10:00:00Z")).map((a) => a.title), ["Reach a person: DevRel at Acme"]);
  const later = new Date("2026-12-07T10:00:00Z");
  reconcileActions(later);
  assert.deepEqual(dueActions(later).map((a) => a.kind), ["follow_up"]);
});

test("an action I closed stays closed", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "decide" });
  reconcileActions();
  const a = get<{ id: number }>("SELECT id FROM actions WHERE rule_key = $k", { k: `loop:decide:${o.id}` })!;
  completeAction(a.id, "dropped");
  reconcileActions();
  assert.equal(get<{ status: string }>("SELECT status FROM actions WHERE id = $id", { id: a.id })!.status, "dropped");
});

test("an email that needs my reply becomes an urgent action after a day", () => {
  run(`INSERT INTO threads (channel, external_id, subject, kind, last_message_at, last_from, needs_reply)
       VALUES ('email', 't1', 'Re: DevRel role', 'conversation', '2026-11-22T10:00:00Z', 'them', 1)`);
  reconcileActions(new Date("2026-11-24T10:00:00Z"));
  const [a] = dueActions(new Date("2026-11-24T10:00:00Z"));
  assert.equal(a.kind, "reply");
  assert.equal(a.urgent, 1);
});

test("imports the real Roles tab and produces open loops", { skip: !existsSync("data/import/roles.json") }, () => {
  const data = readSheetFiles({ roles: "data/import/roles.json" });
  data.outreach = [
    ["Company", "Person", "Their role", "Where", "Degree", "LinkedIn", "Why them", "Warm DM (use this one)", "Ice-breaker came from", "Connection note", "Full DM", "Best time to send (IST)", "Sent?", "Reply"],
    ["Codemonk", "Jordan Lee", "Co-founder", "Bengaluru", "2nd", "https://www.linkedin.com/in/jordanlee/", "Hiring manager", "Hi Jordan", "post", "(Use the warm DM)", "Thanks", "10 AM", "DM sent", "Replied 17 Nov: asked for a note"],
  ];
  data.facts = [["Fact used", "Where it comes from", "Note"], ["About 6 years", "Portfolio", "Your Context doc says 20+ hours a week. Check which is right."]];
  const stats = importSheetData(data);
  assert.equal(stats.roles, 28);
  assert.equal(stats.unlinkedOutreach.length, 0);
  assert.equal(get<{ n: number }>("SELECT count(*) n FROM evidence WHERE conflict = 1")!.n, 1);

  const kong = get<{ closes_on: string }>("SELECT closes_on FROM opportunities WHERE company LIKE 'Kong%'")!;
  assert.equal(kong.closes_on, "2026-12-05");

  const { open } = reconcileActions(new Date("2026-11-24T10:00:00Z"));
  assert.ok(open >= 20, `expected many open loops, got ${open}`);
  const reply = get<{ title: string }>("SELECT title FROM actions WHERE kind = 'reply'")!;
  assert.match(reply.title, /Jordan/);
});

test("tapping Replied on a reply I sent elsewhere starts the follow-up timer", () => {
  run(`INSERT INTO threads (channel, external_id, subject, kind, last_message_at, last_from, needs_reply)
       VALUES ('email', 't9', 'Re: role', 'conversation', '2026-11-20T10:00:00Z', 'them', 1)`);
  reconcileActions(new Date("2026-11-24T10:00:00Z"));
  const [a] = dueActions(new Date("2026-11-24T10:00:00Z"));
  completeAction(a.id, "done");

  const t = get<{ last_from: string; needs_reply: number; last_message_at: string }>("SELECT * FROM threads WHERE external_id = 't9'")!;
  assert.equal(t.last_from, "me");
  assert.equal(t.needs_reply, 0);

  // Six days after the tap, a follow-up is due.
  const later = new Date(new Date(t.last_message_at).getTime() + 6.1 * 86400_000);
  reconcileActions(later);
  assert.ok(dueActions(later).some((x) => x.kind === "follow_up"));
});

test("the same role written differently matches; different roles don't", async () => {
  const { sameRole } = await import("../src/db/opportunities.ts");
  assert.ok(sameRole("Manager, Developer Advocacy (APJ)", "Manager, Developer Advocacy, APJ"));
  assert.ok(sameRole("Senior DevRel Engineer", "Senior Developer Relations Engineer"));
  assert.ok(sameRole("Developer Relations Lead (first DevRel hire)", "Developer Relations Lead"));
  assert.ok(!sameRole("Developer Advocate", "Community Manager"));
  assert.ok(!sameRole("Developer Community Associate (6-month contract)", "Community Lead"));
  const a = upsertOpportunity("Temporal Technologies (shared by Tom Becker)", "Manager, Developer Advocacy (APJ)", { status: "interviewing" });
  const b = upsertOpportunity("Temporal", "Manager, Developer Advocacy, APJ", { source: "gmail" });
  assert.equal(a.id, b.id);
});

test("threads on a rejected role stop asking for replies or follow-ups", () => {
  const o = upsertOpportunity("Exotel", "Developer Community Manager", { status: "rejected" });
  run(`INSERT INTO threads (channel, external_id, opportunity_id, subject, kind, last_message_at, last_from, needs_reply)
       VALUES ('email', 'tz', $o, 'Re: Next steps', 'conversation', '2026-11-01T10:00:00Z', 'me', 0)`, { o: o.id });
  reconcileActions(new Date("2026-11-24T10:00:00Z"));
  assert.equal(dueActions(new Date("2026-11-24T10:00:00Z")).length, 0);
});

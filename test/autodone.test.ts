import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { get, run, useMemoryDb } from "../src/db/index.ts";
import { upsertContact } from "../src/db/contacts.ts";
import { upsertOpportunity } from "../src/db/opportunities.ts";
import { dueActions, reconcileActions } from "../src/loops/engine.ts";
import { linkThread, type ClassifiedItem } from "../src/pipeline/ingest.ts";
import type { MailMessage } from "../src/sources/gmail.ts";

beforeEach(() => useMemoryDb());

const item = (over: Partial<ClassifiedItem>): ClassifiedItem => ({
  message_id: "m", kind: "conversation", jobs: [], about_company: null, about_role: null, person_name: null, person_title: null,
  needs_my_reply: false, update: "none", ...over,
});
const mail = (over: Partial<MailMessage>): MailMessage => ({
  id: "m1", threadId: "t1", from: "", fromEmail: "", to: "", subject: "", date: "2026-11-26T10:00:00.000Z", fromMe: false, labels: [], body: "", ...over,
});

test("an application confirmation email closes the Apply task on its own", () => {
  const o = upsertOpportunity("Kong", "Developer Advocate", { status: "ready" });
  reconcileActions();
  assert.ok(dueActions(new Date("2026-12-01")).some((a) => a.kind === "apply" && a.opportunity_id === o.id));
  linkThread(mail({ subject: "Thank you for applying to Kong", fromEmail: "no-reply@greenhouse.io" }),
    item({ kind: "application_update", about_company: "Kong", about_role: "Developer Advocate", update: "applied" }));
  reconcileActions();
  assert.equal(get<{ status: string }>("SELECT status FROM opportunities WHERE id = $id", { id: o.id })!.status, "applied");
  assert.ok(!dueActions(new Date("2026-12-01")).some((a) => a.kind === "apply" && a.opportunity_id === o.id));
});

test("emailing someone with a drafted note marks the note sent and closes its task", () => {
  const o = upsertOpportunity("Arize AI", "Education Engineer", { status: "ready" });
  const c = upsertContact({ name: "Tom Becker", email: "tom@arize.com" });
  run("INSERT INTO outreach (opportunity_id, contact_id, status, connection_note) VALUES ($o, $c, 'drafted', 'Hi Tom')", { o: o.id, c: c.id });
  reconcileActions();
  assert.ok(dueActions(new Date("2026-12-01")).some((a) => a.kind === "send_note"));
  linkThread(mail({ fromMe: true, to: "Tom Becker <Tom@Arize.com>", subject: "Education Engineer role" }), item({ about_company: "Arize AI" }));
  reconcileActions();
  assert.equal(get<{ status: string }>("SELECT status FROM outreach")!.status, "dm_sent");
  assert.ok(!dueActions(new Date("2026-12-01")).some((a) => a.kind === "send_note"));
});

test("a sent LinkedIn note is marked accepted when the conversation appears, and the follow-up says so", async () => {
  const { syncLinkedInMessages } = await import("../src/pipeline/dms.ts");
  const o = upsertOpportunity("Kong", "Developer Advocate", { status: "ready" });
  const c = upsertContact({ name: "Ravi Kumar", linkedin_url: "https://www.linkedin.com/in/ravikumar" });
  run("INSERT INTO outreach (opportunity_id, contact_id, status, sent_at, connection_note) VALUES ($o, $c, 'note_sent', '2026-11-26T10:00:00.000Z', 'Hi Ravi')", { o: o.id, c: c.id });
  reconcileActions(new Date("2026-11-26T12:00:00.000Z"));
  const before = dueActions(new Date("2026-12-10")).find((a) => a.kind === "follow_up" && a.outreach_id);
  assert.match(before?.detail ?? "", /not accepted yet/);

  const ms = new Date("2026-11-27T09:00:00.000Z").getTime();
  const id = `urn:li:msg_message:(urn:li:fsd_profile:ME,2-${Buffer.from(`${ms}b70-100&abc`).toString("base64")})`;
  const conv = { index: 0, name: "Ravi Kumar", snippet: "Hi Ravi", fromMe: true, unread: false, threadId: "T9", url: "https://www.linkedin.com/messaging/thread/T9/",
    messages: [{ id, fromMe: true, sender: "Sam Rivera", at: "2026-11-27T09:00:00.000Z", body: "Hi Ravi" }] };
  await syncLinkedInMessages("Sam Rivera", {
    read: async (opts) => ({ inbox: [conv], opened: [conv].filter(opts.shouldOpen) }),
    classify: async (mails) => mails.map((m) => item({ message_id: m.id, about_company: "Kong" })),
  });
  const r = get<{ status: string; accepted_at: string | null }>("SELECT status, accepted_at FROM outreach")!;
  assert.equal(r.status, "dm_sent");
  assert.ok(r.accepted_at);
  reconcileActions(new Date("2026-11-27T12:00:00.000Z"));
  const after = dueActions(new Date("2026-12-10")).find((a) => a.kind === "follow_up" && a.outreach_id);
  assert.match(after?.detail ?? "", /accepted your connection/);
});

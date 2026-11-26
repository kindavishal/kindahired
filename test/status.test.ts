import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { all, get, run, useMemoryDb } from "../src/db/index.ts";
import { getOpportunity, upsertOpportunity } from "../src/db/opportunities.ts";
import { llm } from "../src/llm/client.ts";
import { dueActions, reconcileActions } from "../src/loops/engine.ts";
import { fileMessages, type ClassifiedItem } from "../src/pipeline/ingest.ts";
import { reviewStatus } from "../src/pipeline/review.ts";
import type { MailMessage } from "../src/sources/gmail.ts";

beforeEach(() => useMemoryDb());

const mail = (id: string, threadId: string, subject: string, date: string, fromMe = false, body = "…"): MailMessage => ({
  id, threadId, from: fromMe ? "Me <me@x.com>" : "Charu Anand <charu@garage.app>", fromEmail: fromMe ? "me@x.com" : "charu@garage.app",
  to: "me", subject, date, fromMe, labels: [], body,
});
const convo = (id: string, extra: Partial<ClassifiedItem> = {}): ClassifiedItem => ({
  message_id: id, kind: "conversation", jobs: [], about_company: "Garage.app", about_role: "Community Manager",
  person_name: "Charu Anand", person_title: null, needs_my_reply: false, update: "none", ...extra,
});
const stats = () => ({ scanned: 0, newJobs: 0, conversations: 0, needsReply: 0, newOpportunityIds: [] as number[] });

test("an interview that went quiet becomes one follow-up with context, not scattered thread nudges", () => {
  const o = upsertOpportunity("Garage.app", "Community Manager", { status: "interviewing" });
  fileMessages(
    [mail("g1", "t1", "Invitation: Interview: Community Manager", "2026-09-08T09:33:56Z"),
     mail("g2", "t2", "Re: Interview: Community Manager | Garage.app", "2026-09-08T10:13:13Z", true),
     mail("g3", "t3", "Updated invitation: Interview: Community Manager", "2026-09-09T10:43:30Z")],
    [convo("g1", { needs_my_reply: true }), convo("g2"), convo("g3")], stats(),
  );
  const now = new Date("2026-11-25T10:00:00Z");
  reconcileActions(now);
  const due = dueActions(now).filter((a) => a.opportunity_id === o.id);
  assert.equal(due.length, 1, due.map((a) => a.title).join(" | "));
  assert.match(due[0].title, /^Likely closed: Community Manager at Garage\.app \(76 days\)/);
  assert.match(due[0].detail!, /Stage: interviewing/);
  assert.match(due[0].detail!, /Last contact: 9 Sept?, a calendar invite/);
  assert.match(due[0].detail!, /most likely closed.*check-in to Charu Anand/);
});

test("a week of quiet after applying is due; fresh news restarts the clock", () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "applied", date_applied: "2026-11-10" });
  reconcileActions(new Date("2026-11-20T10:00:00Z"));
  assert.ok(dueActions(new Date("2026-11-20T10:00:00Z")).some((a) => a.opportunity_id === o.id && /Gone quiet/.test(a.title)));
  fileMessages([mail("a1", "ta", "Next steps", "2026-11-19T10:00:00Z")], [convo("a1", { about_company: "Acme", about_role: "DevRel" })], stats());
  reconcileActions(new Date("2026-11-20T10:00:00Z"));
  assert.ok(!dueActions(new Date("2026-11-20T10:00:00Z")).some((a) => a.opportunity_id === o.id));
});

test("'this role is in Singapore, we can't relocate you' closes the application with the reason", () => {
  const o = upsertOpportunity("Temporal", "Manager, Developer Advocacy (APJ)", { status: "interviewing" });
  fileMessages([mail("e1", "te", "Re: Hello from Temporal", "2026-11-18T23:00:00Z")], [convo("e1", {
    about_company: "Temporal", about_role: "Manager, Developer Advocacy (APJ)", person_name: "Eric",
    update: "closed", update_reason: "Role is Singapore-based; can't relocate due to visa limits",
  })], stats());
  const after = getOpportunity(o.id)!;
  assert.equal(after.status, "rejected");
  assert.equal(after.skip_reason, "Role is Singapore-based; can't relocate due to visa limits");
  assert.equal(get<{ status: string }>("SELECT status FROM threads")!.status, "closed");
  reconcileActions(new Date("2026-12-30T10:00:00Z"));
  assert.ok(!dueActions(new Date("2026-12-30T10:00:00Z")).some((a) => a.opportunity_id === o.id));
});

test("a review of the whole conversation corrects a status the screener missed", async () => {
  const o = upsertOpportunity("Temporal", "Developer Relations (APJ)", { status: "interviewing" });
  fileMessages([mail("r1", "tr", "Re: Hello from Temporal", "2026-11-18T23:00:00Z", false, "this role is located in Singapore")],
    [convo("r1", { about_company: "Temporal", about_role: "Developer Relations (APJ)" })], stats());
  let prompt = "";
  llm.structured = (async (_label: string, _s: unknown, opts: { prompt: string }) => {
    prompt = opts.prompt;
    return { stage: "closed", reason: "Role is Singapore-based", next_step: null };
  }) as typeof llm.structured;
  const change = await reviewStatus(o.id);
  assert.match(prompt, /located in Singapore/);
  assert.deepEqual(change, { from: "interviewing", to: "rejected", reason: "Role is Singapore-based" });
  assert.equal(getOpportunity(o.id)!.next_step, "Closed: Role is Singapore-based");
  // A later "unclear" or earlier-stage read never moves it back.
  llm.structured = (async () => ({ stage: "interviewing", reason: null, next_step: null })) as typeof llm.structured;
  assert.equal(await reviewStatus(o.id), null);
  assert.equal(getOpportunity(o.id)!.status, "rejected");
  void all; void run;
});

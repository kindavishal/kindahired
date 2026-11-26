import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { all, useMemoryDb } from "../src/db/index.ts";
import { findOpportunity, getOpportunity, sameCompany, updateOpportunity, upsertOpportunity } from "../src/db/opportunities.ts";
import { standDownPastDecisions } from "../src/jobs.ts";
import { reconcileActions } from "../src/loops/engine.ts";
import { cardText } from "../src/notify/messages.ts";
import { fileMessages, type ClassifiedItem } from "../src/pipeline/ingest.ts";
import type { MailMessage } from "../src/sources/gmail.ts";

beforeEach(() => useMemoryDb());

const stats = () => ({ scanned: 1, newJobs: 0, conversations: 0, needsReply: 0, newOpportunityIds: [] as number[] });
const mail = (id: string, threadId: string, subject: string, date: string): MailMessage => ({
  id, threadId, from: "Team <jobs@ashbyhq.com>", fromEmail: "jobs@ashbyhq.com", to: "me",
  subject, date, fromMe: false, labels: [], body: "Thanks for applying.",
});

test("an application confirmation is filed as applied, never as a new match to build", () => {
  const c: ClassifiedItem = {
    message_id: "f1", kind: "application_update", jobs: [{ company: "Factory", role: "Head of Community", url: null, location: null, relevance: "high" }],
    about_company: "Factory", about_role: "Head of Community", person_name: null, person_title: null, needs_my_reply: false, update: "applied",
  };
  const s = stats();
  fileMessages([mail("f1", "tf", "Factory Application - Sam Rivera", "2026-09-16T09:53:02Z")], [c], s);
  const opps = all<{ id: number; status: string; pack_status: string; date_applied: string }>("SELECT * FROM opportunities");
  assert.equal(opps.length, 1);
  assert.equal(opps[0].status, "applied");
  assert.equal(opps[0].date_applied, "2026-09-16");
  assert.notEqual(opps[0].pack_status, "queued");
  assert.deepEqual(s.newOpportunityIds, []);
});

test("a role I applied to shows where it stands and the next step, not Build pack / Skip", () => {
  const o = upsertOpportunity("Factory", "Head of Community", { status: "applied", date_applied: "2026-09-16" });
  fileMessages([mail("f2", "tf2", "Factory Application - Sam Rivera", "2026-09-16T09:53:02Z")], [{
    message_id: "f2", kind: "application_update", jobs: [], about_company: "Factory", about_role: "Head of Community",
    person_name: null, person_title: null, needs_my_reply: false, update: "applied",
  }], stats());
  reconcileActions(new Date("2026-11-25T10:00:00Z"));
  const text = cardText(getOpportunity(o.id)!);
  assert.match(text.split("\n")[1], /Applied<\/b> on 16 Sept?/);
  assert.match(text, /Latest: email from them, 16 Sept?/);
  assert.match(text, /Next: Likely closed: Head of Community at Factory \(70 days\)/);
  assert.doesNotMatch(text, /Good fit|Not read yet/);
});

test("a queued pack for a role I've applied to or skipped is stood down", () => {
  const a = upsertOpportunity("Factory", "Head of Community", { status: "applied", pack_status: "queued" });
  const d = upsertOpportunity("Verifinity", "Community Lead", { status: "found", pack_status: "approved" });
  updateOpportunity(d.id, { status: "dropped" }, { byUser: true });
  const keep = upsertOpportunity("Acme", "Developer Advocate", { status: "found", pack_status: "approved" });
  standDownPastDecisions();
  assert.equal(getOpportunity(a.id)!.pack_status, "none");
  assert.equal(getOpportunity(d.id)!.pack_status, "none");
  assert.equal(getOpportunity(keep.id)!.pack_status, "approved");
});

test("tapping Build never locks the pack status, so the finished pack is recorded as ready", () => {
  const o = upsertOpportunity("Verifinity", "Community Lead", { status: "found" });
  updateOpportunity(o.id, { pack_status: "approved" }, { byUser: true }); // as an older tap did
  updateOpportunity(o.id, { pack_status: "ready" });
  assert.equal(getOpportunity(o.id)!.pack_status, "ready");
});

test("a recruiter and its client are the same company; a reply in a known thread stays with its role", () => {
  assert.ok(sameCompany("Verifinity / Devrev", "DevRev"));
  assert.ok(sameCompany("Verifinity.ai", "Verifinity"));
  assert.ok(!sameCompany("Leo UK", "Next Level Pros"));
  const devrev = upsertOpportunity("DevRev", "Community Lead", { status: "found" });
  assert.equal(findOpportunity("Verifinity / Devrev", "Community Lead")?.id, devrev.id);
  const base = { person_title: null, update: "none" as const };
  fileMessages([mail("v1", "tv", "Re: Community Lead Job Description | Devrev.ai", "2026-11-05T05:00:00Z")], [{
    message_id: "v1", kind: "conversation", jobs: [], about_company: "DevRev", about_role: "Community Lead",
    person_name: "Kirti", needs_my_reply: false, ...base,
  }], stats());
  fileMessages([mail("v2", "tv", "Re: Community Lead Job Description | Devrev.ai", "2026-11-06T05:00:00Z")], [{
    message_id: "v2", kind: "conversation", jobs: [{ company: "Verifinity / Devrev", role: "Community Lead", url: null, location: null, relevance: "high" }],
    about_company: "Verifinity", about_role: "Community Lead", person_name: "Kirti", needs_my_reply: true, ...base,
  }], stats());
  assert.equal(all("SELECT * FROM opportunities").length, 1);
  assert.equal(all<{ opportunity_id: number }>("SELECT opportunity_id FROM threads")[0].opportunity_id, devrev.id);
});

test("errors reach Telegram as one readable line; network blips are retried quietly", async () => {
  const { isTransient, plainError } = await import("../src/jobs.ts");
  const raw = new Error("page.goto: net::ERR_NETWORK_CHANGED at https://www.linkedin.com/search\nCall log:\n\x1b[2m  - navigating to \"https://...\"\x1b[22m");
  assert.equal(plainError(raw), "page.goto: net::ERR_NETWORK_CHANGED at https://www.linkedin.com/search");
  assert.ok(isTransient(raw));
  assert.ok(isTransient(new TypeError("fetch failed")));
  assert.ok(!isTransient(new Error("No apply link found")));
});

test("a role that keeps restarting is stopped after three tries", async () => {
  const { runPacks } = await import("../src/jobs.ts");
  const { logEvent } = await import("../src/db/index.ts");
  const o = upsertOpportunity("Loopco", "Community Lead", { status: "found", pack_status: "approved" });
  for (let i = 0; i < 3; i++) logEvent("pack.start", o.id);
  await runPacks();
  assert.equal(getOpportunity(o.id)!.pack_status, "failed");
  assert.match(getOpportunity(o.id)!.pack_error!, /Stopped after 3 pack attempts/);
});

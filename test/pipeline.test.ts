import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { outreachForOpportunity } from "../src/db/contacts.ts";
import { all, get, run, useMemoryDb } from "../src/db/index.ts";
import { getOpportunity, upsertOpportunity } from "../src/db/opportunities.ts";
import { llm } from "../src/llm/client.ts";
import { dueActions, reconcileActions } from "../src/loops/engine.ts";
import { cardText, digestText } from "../src/notify/messages.ts";
import { addOpportunity, fileMessages, type ClassifiedItem } from "../src/pipeline/ingest.ts";
import { buildPack } from "../src/pipeline/pack.ts";
import type { MailMessage } from "../src/sources/gmail.ts";
import { sample } from "./resume.test.ts";

// Stand-in AI responses, keyed by step. Lets the whole pipeline run without network or cost.
const calls: string[] = [];
function fakeAi(overrides: Record<string, unknown> = {}) {
  calls.length = 0;
  llm.research = (async (label: string) => {
    calls.push(label);
    return `notes for ${label}`;
  }) as typeof llm.research;
  llm.structured = (async (label: string) => {
    calls.push(label);
    const step = label.split(":")[0];
    if (step in overrides) return overrides[step];
    switch (step) {
      case "posting.parse":
        return {
          still_open: true, exact_apply_url: "https://jobs.ashbyhq.com/acme/123", posting_url: "https://acme.dev/careers/devrel",
          who_can_apply: "Remote, India OK", visa_or_sponsorship: null, pay: "INR 40L", closes_on: "2026-12-10",
          form_questions: ["Why Acme?"], jd_summary: "Run the developer community.", company_brief: "Acme makes APIs.",
        };
      case "fit":
        return { gate_result: "pass", hard_gate: "None", skip_reason: null, fit_read: "Strong fit on community.", verdict: "apply", next_step: "Apply, then message Mira." };
      case "resume":
      case "resume.fix":
        return sample;
      case "application":
        return { cover_note: "Hi Mira, I'm applying…", form_answers: "Why Acme? [FILL IN: one line on why]", fill_ins: ["Why Acme"] };
      case "outreach":
        return {
          people: [{
            name: "Mira Shah", title: "Head of DevRel, Acme", linkedin_url: "https://www.linkedin.com/in/mirashah/", location: "Bengaluru",
            degree: "2nd", why_them: "The role reports to her.", hook: "her post on docs", hook_source: "Post, 1 week ago",
            connection_note: "Hi Mira, saw your post on docs…", full_dm: "Thanks for connecting…", send_time_ist: "10 AM to 12 PM IST",
          }],
        };
      default:
        throw new Error(`unexpected AI step ${label}`);
    }
  }) as typeof llm.structured;
}

beforeEach(() => {
  useMemoryDb();
  run("INSERT INTO evidence (id, claim, source) VALUES (1, 'Northwind, Head of Developer Experience, Sep 2026 to present: 116 new open-source contributors through 15 partner communities in 11 cities and 6 countries', 'sam-rivera.example')");
  run("INSERT INTO evidence (id, claim, source) VALUES (2, 'Lumen: creator-attributed referrals grew 4x, from 1.7K to 7.2K a week', 'sam-rivera.example')");
  run("INSERT INTO evidence (id, claim, source) VALUES (3, 'Harbor Hacks: 500 hackers and 14 sponsors over two editions', 'sam-rivera.example')");
});

test("a new posting becomes a full pack: link, resume, cover note, people and drafts", { timeout: 60_000 }, async () => {
  fakeAi();
  const { opportunity } = addOpportunity("Acme", "Developer Relations Lead", { source: "gmail" });
  assert.equal(getOpportunity(opportunity.id)!.pack_status, "queued");

  const result = await buildPack(opportunity.id);
  const o = getOpportunity(opportunity.id)!;
  assert.equal(o.status, "ready");
  assert.equal(o.pack_status, "ready");
  assert.equal(o.apply_url, "https://jobs.ashbyhq.com/acme/123");
  assert.equal(o.closes_on, "2026-12-10");
  assert.ok(result.resumePath && existsSync(result.resumePath));
  assert.deepEqual(result.resumeIssues, []);
  assert.deepEqual(result.fillIns, ["Why Acme"]);
  // LinkedIn isn't logged in here, so people came from public web research.
  assert.ok(calls.includes(`people:${o.id}`));

  const people = outreachForOpportunity(o.id);
  assert.equal(people.length, 1);
  assert.equal(people[0].status, "drafted");

  reconcileActions();
  const kinds = dueActions().map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["apply", "send_note"]);

  const text = cardText(o);
  assert.match(text, /Good fit/);
  assert.match(text, /closes 10 Dec/);
});

test("a role ruled out by a hard gate is skipped with the reason and no resume", async () => {
  fakeAi({ fit: { gate_result: "skip", hard_gate: "US only, no sponsorship", skip_reason: "US-only with no visa path.", fit_read: "…", verdict: "skip", next_step: "None" } });
  const { opportunity } = addOpportunity("Beta", "Community Manager", { source: "gmail" });
  const result = await buildPack(opportunity.id);
  assert.equal(result.skipped, true);
  const o = getOpportunity(opportunity.id)!;
  assert.equal(o.status, "skipped");
  assert.equal(o.skip_reason, "US-only with no visa path.");
  assert.ok(!calls.some((c) => c.startsWith("resume")));
});

test("a resume line with an invented number gets one rewrite, then is flagged", async () => {
  const bad = structuredClone(sample);
  bad.experience[1].bullets[0].text = "Creator referrals grew 9x.";
  fakeAi({ resume: bad, "resume.fix": bad });
  const { opportunity } = addOpportunity("Gamma", "DevRel", { source: "gmail" });
  const result = await buildPack(opportunity.id);
  assert.ok(calls.includes(`resume.fix:${opportunity.id}`));
  assert.equal(result.resumeIssues.length, 1);
  assert.match(getOpportunity(opportunity.id)!.pack_error ?? "", /9x/);
});

test("Gmail: alerts become queued postings, a recruiter email becomes a reply I owe", () => {
  const mail = (id: string, over: Partial<MailMessage> = {}): MailMessage => ({
    id, threadId: "t-" + id, from: "Jobs <alerts@example.com>", fromEmail: "alerts@example.com", to: "me", subject: "New jobs",
    date: "2026-11-24T00:10:00Z", fromMe: false, labels: [], body: "…", ...over,
  });
  const batch = [
    mail("m1"),
    mail("m2", { from: "Sam Lee <sam@delta.io>", fromEmail: "sam@delta.io", subject: "DevRel role at Delta", threadId: "t-delta" }),
  ];
  const classified: ClassifiedItem[] = [
    {
      message_id: "m1", kind: "job_alert",
      jobs: [
        { company: "Epsilon", role: "Developer Advocate", url: "https://e.co/j/1", location: "Remote", relevance: "high" },
        { company: "Zeta", role: "Sales Engineer", url: null, location: "NYC", relevance: "low" },
      ],
      about_company: null, about_role: null, person_name: null, person_title: null, needs_my_reply: false, update: "none",
    },
    {
      message_id: "m2", kind: "conversation", jobs: [], about_company: "Delta", about_role: "DevRel Lead",
      person_name: "Sam Lee", person_title: "Founder", needs_my_reply: true, update: "none",
    },
  ];
  const stats = { scanned: 2, newJobs: 0, conversations: 0, needsReply: 0, newOpportunityIds: [] as number[] };
  fileMessages(batch, classified, stats);

  assert.equal(stats.newJobs, 1);
  assert.equal(get<{ pack_status: string }>("SELECT pack_status FROM opportunities WHERE company = 'Epsilon'")!.pack_status, "queued");
  assert.equal(get<{ status: string }>("SELECT status FROM opportunities WHERE company = 'Zeta'")!.status, "skipped");

  reconcileActions(new Date("2026-11-24T08:00:00Z"));
  const reply = get<{ title: string; opportunity_id: number }>("SELECT * FROM actions WHERE kind = 'reply'")!;
  assert.match(reply.title, /Sam Lee/);
  assert.ok(reply.opportunity_id);

  // Filing the same mail again changes nothing.
  fileMessages(batch, classified, stats);
  assert.equal(all("SELECT * FROM messages").length, 1);
});

test("the digest groups what needs me", () => {
  upsertOpportunity("Acme", "DevRel", { status: "ready", pack_status: "ready", saved_on_linkedin: 1 });
  run(`INSERT INTO threads (channel, external_id, subject, kind, last_message_at, last_from, needs_reply)
       VALUES ('email', 't1', 'Re: role', 'conversation', '2026-11-20T10:00:00Z', 'them', 1)`);
  reconcileActions();
  const { text, top } = digestText();
  assert.match(text, /Replies you owe \(1\)/);
  assert.match(text, /Apply \(1\)/);
  assert.match(text, /Saved on LinkedIn, not applied \(1\)/);
  assert.equal(top[0].kind, "reply");
});

test("old or anonymous alerts are listed but don't use the plan on a pack", () => {
  const old = addOpportunity("Acme", "Developer Advocate", { source: "gmail" }, "high", { receivedAt: "2026-09-01T00:00:00Z" });
  const anon = addOpportunity("Unknown", "Community Manager", { source: "gmail" }, "high", { receivedAt: new Date().toISOString() });
  const fresh = addOpportunity("Beta", "Developer Advocate", { source: "gmail" }, "high", { receivedAt: new Date().toISOString() });
  assert.equal(getOpportunity(old.opportunity.id)!.pack_status, "none");
  assert.equal(getOpportunity(anon.opportunity.id)!.pack_status, "none");
  assert.equal(getOpportunity(fresh.opportunity.id)!.pack_status, "queued");
});

test("an email about a company I track joins that role, even with a different title", () => {
  const o = upsertOpportunity("Adaption Labs", "Developer Community Associate (6-month contract)", { status: "applied" });
  const m: MailMessage = {
    id: "x1", threadId: "tx", from: "Ross <ross@adaptionlabs.ai>", fromEmail: "ross@adaptionlabs.ai", to: "me",
    subject: "Re: Thank you for speaking with me", date: "2026-11-20T10:00:00Z", fromMe: false, labels: [], body: "Great chatting.",
  };
  const c: ClassifiedItem = {
    message_id: "x1", kind: "conversation", jobs: [], about_company: "Adaption", about_role: "Community Lead",
    person_name: "Ross", person_title: "Community Lead", needs_my_reply: false, update: "interview",
  };
  fileMessages([m], [c], { scanned: 1, newJobs: 0, conversations: 0, needsReply: 0, newOpportunityIds: [] });
  assert.equal(all("SELECT * FROM opportunities").length, 1);
  assert.equal(getOpportunity(o.id)!.status, "interviewing");
  assert.equal(get<{ opportunity_id: number }>("SELECT opportunity_id FROM threads")!.opportunity_id, o.id);
});

test("the summary stage reads the posting and fit only; nothing is built until approved", async () => {
  fakeAi();
  const { buildSummary } = await import("../src/pipeline/pack.ts");
  const { opportunity } = addOpportunity("Delta", "Developer Advocate", { source: "manual" });
  const r = await buildSummary(opportunity.id);
  assert.equal(r.skipped, false);
  const o = getOpportunity(opportunity.id)!;
  assert.equal(o.pack_status, "summary");
  assert.equal(o.fit_verdict, "apply");
  assert.ok(!calls.some((c) => /^(resume|application|outreach|people)/.test(c)));
  reconcileActions();
  assert.ok(dueActions().some((a) => a.kind === "decide" && a.title.startsWith("Review:")));
});

test("placeholders never reach the PDF, and every person gets a profile link", async () => {
  const withBlank = structuredClone(sample);
  withBlank.experience[0].bullets.push({ text: "Led [FILL IN: team size] people.", evidence: [1] });
  fakeAi({
    resume: withBlank, "resume.fix": withBlank,
    outreach: { people: [{
      name: "Sam Lee", title: "Founder", linkedin_url: null, location: null, degree: null, why_them: "Founder",
      hook: "a talk", hook_source: "Talk, 1 month ago", connection_note: "Hi Sam", full_dm: "Thanks Sam", send_time_ist: "10 AM IST",
    }] },
  });
  const { stripPlaceholders } = await import("../src/pipeline/pack.ts");
  assert.equal(stripPlaceholders(withBlank).experience[0].bullets.length, 1);

  const { opportunity } = addOpportunity("Epsilon", "Developer Advocate", { source: "manual" });
  await buildPack(opportunity.id);
  const [person] = outreachForOpportunity(opportunity.id);
  const notes = get<{ notes: string }>("SELECT notes FROM contacts WHERE id = $id", { id: person.contact_id })!.notes;
  assert.match(notes, /linkedin\.com\/search\/results\/people\/\?keywords=Sam%20Lee%20Epsilon/);
});

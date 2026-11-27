import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { get, run, useMemoryDb } from "../src/db/index.ts";
import { upsertContact } from "../src/db/contacts.ts";
import { upsertOpportunity } from "../src/db/opportunities.ts";
import { llm } from "../src/llm/client.ts";
import { dueActions, reconcileActions } from "../src/loops/engine.ts";
import { bestContact, getBrief, hiringTeamFrom, knownContext, researchHiring, rolesNeedingResearch } from "../src/pipeline/hiring.ts";
import type { BriefData } from "../src/pipeline/hiring-brief.ts";

beforeEach(() => useMemoryDb());

const pageText = [
  "PranaTree", "Developer Relations", "Bengaluru, Karnataka, India", "No longer accepting applications",
  "Meet the hiring team", "Anil Kumar KL", "• 2nd", "HR Leader at PranaTree.", "Message",
  "About the job", "We are looking for...",
].join("\n");

test("LinkedIn's hiring team is read from the job page text", () => {
  const team = hiringTeamFrom(pageText)!;
  assert.match(team, /Anil Kumar KL/);
  assert.doesNotMatch(team, /We are looking for/);
  assert.equal(hiringTeamFrom("About the job\nNothing here"), null);
});

test("my own threads, outreach and the post's author are part of the context", () => {
  const o = upsertOpportunity("Studio1", "DevRel Engineer", { status: "applied", source_url: "https://x.com/msbr_dev/status/1" });
  upsertContact({ name: "Mo Sabri", x_handle: "msbr_dev", title: "Founder at Studio1", notes: "Posted a role on X: https://x.com/msbr_dev/status/1" });
  const c = upsertContact({ name: "Mira Shah", email: "mira@studio1.dev", title: "Recruiter" });
  run(`INSERT INTO threads (channel, external_id, opportunity_id, contact_id, kind, last_message_at, last_from, last_snippet)
       VALUES ('email', 't', $o, $c, 'conversation', '2026-11-20T10:00:00Z', 'them', 'Thanks for applying, can we talk Friday?')`, { o: o.id, c: c.id });
  const lines = knownContext(o).join("\n");
  assert.match(lines, /email thread with Mira Shah \(Recruiter\) <mira@studio1\.dev>/);
  assert.match(lines, /posted by Mo Sabri \(@msbr_dev on X\)/);
});

const brief = (people: BriefData["people"]): BriefData => ({ people, team: "Developer Relations, led by the Head of DevRel", signals: [], angles: ["Ran 40 hackathons"], open_questions: [] });

test("research saves a brief, and the first touch names the person to write to", async () => {
  const o = upsertOpportunity("Acme", "Developer Advocate", { status: "applied", date_applied: "2026-11-24", linkedin_job_id: "4464442700" });
  let prompt = "";
  llm.research = (async (label: string) => label === "profile:Riya Shah" ? "https://www.linkedin.com/in/riya-shah-talent"
    : label.startsWith("profile:") ? "none"
    : "Web: Sam Lee is Head of DevRel at Acme (linkedin.com/in/samlee), posted about the role on 20 Nov.") as typeof llm.research;
  llm.structured = (async (_l: string, _s: unknown, opts: { prompt: string }) => {
    prompt = opts.prompt;
    return brief([
      { name: "Riya Shah", title: "Talent Partner", part: "recruiter", confidence: "high", evidence: "Listed on LinkedIn's hiring team.", source_url: null, linkedin_url: null, x_url: null },
      { name: "Sam Lee", title: "Head of DevRel", part: "hiring_manager", confidence: "medium", evidence: "Leads DevRel and posted about the role on 20 Nov.", source_url: null, linkedin_url: "https://www.linkedin.com/in/samlee", x_url: "https://twitter.com/samlee" },
      { name: "Guess Person", title: null, part: "hiring_manager", confidence: "low", evidence: "Title only.", source_url: null, linkedin_url: null, x_url: "https://x.com/search?q=guess" },
    ]);
  }) as typeof llm.structured;
  const b = await researchHiring(o.id, { linkedin: async () => ({ text: pageText.replace("Anil Kumar KL", "Riya Shah"), closed: false }) });
  assert.match(prompt, /Meet the hiring team\nRiya Shah/);
  assert.match(prompt, /Sam Lee is Head of DevRel/);
  assert.deepEqual(b.sources, ["LinkedIn hiring team", "web search"]);

  const saved = getBrief(get<{ hiring_brief: string }>("SELECT hiring_brief FROM opportunities WHERE id = $id", { id: o.id })!)!;
  assert.equal(saved.people.length, 3);
  // A profile the research missed is looked up; X profiles are kept (as x.com), anything else isn't a profile.
  assert.equal(saved.people[0].linkedin_url, "https://www.linkedin.com/in/riya-shah-talent");
  assert.equal(saved.people[1].x_url, "https://x.com/samlee");
  assert.equal(saved.people[2].linkedin_url, null);
  assert.equal(saved.people[2].x_url, null);
  // The hiring manager beats the recruiter; a low-confidence guess is never picked.
  assert.equal(bestContact(saved)!.name, "Sam Lee");

  const now = new Date("2026-11-25T10:00:00Z");
  reconcileActions(now);
  const touch = dueActions(now).find((a) => a.rule_key.startsWith("loop:firsttouch:"))!;
  assert.match(touch.detail!, /Write to Sam Lee \(Head of DevRel\), the hiring manager, likely: https:\/\/www\.linkedin\.com\/in\/samlee/);
});

test("applied roles are researched first; a fresh brief isn't redone", () => {
  const ready = upsertOpportunity("A", "Role A", { status: "ready" });
  const applied = upsertOpportunity("B", "Role B", { status: "applied" });
  upsertOpportunity("C", "Role C", { status: "skipped" });
  const done = upsertOpportunity("D", "Role D", { status: "applied" });
  run("UPDATE opportunities SET hiring_brief_at = $at WHERE id = $id", { at: new Date().toISOString(), id: done.id });
  assert.deepEqual(rolesNeedingResearch(5), [applied.id, ready.id]);
});

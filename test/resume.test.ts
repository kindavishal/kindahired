import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";
import { renderResumePdf } from "../src/resume/render.ts";
import { claimNumbers, validateResume, type Resume } from "../src/resume/schema.ts";

const evidence = new Map<number, string>([
  [1, "Northwind, Head of Developer Experience, Sep 2026 to present: 116 new open-source contributors through 15 partner communities in 11 cities and 6 countries"],
  [2, "Lumen: creator-attributed referrals grew 4x, from 1.7K to 7.2K a week"],
  [3, "Harbor Hacks: 500 hackers and 14 sponsors over two editions"],
]);

export const sample: Resume = {
  headline: "Developer Relations",
  specialties: ["Hackathons", "GitHub communities", "Developer Experience"],
  summary: { text: "I get developers to show up, build and come back. At Northwind I brought 116 new contributors to an open-source AI model.", evidence: [1] },
  experience: [
    {
      title: "Head of Developer Experience", company: "Northwind.dev", company_note: "open-source AI models", dates: "Sep 2026 – Present",
      bullets: [{ text: "Brought in 116 new open-source contributors through 15 partner communities in 11 cities and 6 countries.", evidence: [1] }],
    },
    {
      title: "Creator & Community Lead", company: "Firecrawl", company_note: "Series A, web data API for AI", dates: "Apr 2026 – May 2026",
      bullets: [{ text: "Creator-attributed referrals grew 4x, from 1.7K to 7.2K a week.", evidence: [2] }],
    },
  ],
  projects: [],
  community: [{ lead: "Harbor Hacks", text: "founder and organizer (2019–2020): 500 hackers and 14 sponsors over two editions.", evidence: [3] }],
  education: ["B.Tech, Computer Science and Engineering — Lovely Professional University (2017–2021)"],
  certifications: ["Meta Certified Community Manager", "Trained GitHub Campus Expert"],
  skills: [{ label: "Developer relations", items: "hackathons and build events, GitHub contributor programs" }],
  fill_ins: [],
};

test("pulls claim numbers and ignores years", () => {
  assert.deepEqual(claimNumbers("Grew 4x, from 1.7K to 7.2K in 2026, 300+ partners, 41%."), ["4x", "1.7K", "7.2K", "300+", "41%"]);
});

test("a supported resume passes the check", () => {
  assert.deepEqual(validateResume(sample, evidence), []);
});

test("an invented number is caught", () => {
  const bad: Resume = structuredClone(sample);
  bad.experience[1].bullets[0].text = "Creator-attributed referrals grew 6x in a month.";
  bad.summary.evidence = [99];
  const issues = validateResume(bad, evidence).map((i) => i.problem);
  assert.ok(issues.some((p) => p.includes('"6x"')));
  assert.ok(issues.some((p) => p.includes("E99")));
});

test("renders a PDF in the resume layout", { timeout: 60_000 }, async () => {
  const out = await renderResumePdf(sample, "test_resume.pdf");
  assert.ok(existsSync(out) && statSync(out).size > 10_000);
});

test("blanks are stripped from every field, keeping the rest of a list", async () => {
  const { stripPlaceholders } = await import("../src/resume/schema.ts");
  const r: Resume = structuredClone(sample);
  r.community.push({ lead: "Talks", text: "[FILL IN: talks you've given, with event and year]", evidence: [] });
  r.education.push("[FILL IN: degree, institution, years]");
  r.certifications.push("PMP or other training: [FILL IN]");
  r.skills.push({ label: "Stack", items: "Next.js, Supabase, Linux / Ubuntu: [FILL IN]" });
  assert.ok(validateResume(r, evidence).length >= 4);
  const s = stripPlaceholders(r);
  assert.doesNotMatch(JSON.stringify(s), /FILL IN/);
  assert.equal(s.community.length, sample.community.length);
  assert.equal(s.skills.at(-1)!.items, "Next.js, Supabase");
  assert.deepEqual(validateResume(s, evidence), []);
});

test("editor edits apply in place: changed, removed and added lines, evidence kept", async () => {
  const { applyEdits, blanksIn } = await import("../src/resume/edit.ts");
  const e0 = sample.experience[0];
  const edits: [string, string][] = [
    ["summary", "New summary."],
    ["exp.0.bullet.0", "Edited first bullet."],
    ["exp.0.bullet.new", "A bullet I added."],
    ["exp.1.bullet.0", "  "],
    ["edu.0", "BTech, Somewhere, 2017"],
    ["edu.new", "[FILL IN: second degree]"],
  ];
  const out = applyEdits(sample, edits);
  assert.equal(out.summary.text, "New summary.");
  assert.deepEqual(out.summary.evidence, sample.summary.evidence);
  assert.deepEqual(out.experience[0].bullets, [
    { text: "Edited first bullet.", evidence: e0.bullets[0].evidence },
    { text: "A bullet I added.", evidence: [] },
  ]);
  assert.deepEqual(out.experience[1].bullets, []);
  assert.equal(out.experience[1].company, "Firecrawl");
  assert.deepEqual(out.education, ["BTech, Somewhere, 2017", "[FILL IN: second degree]"]);
  assert.deepEqual(out.skills, sample.skills);
  assert.deepEqual(blanksIn(out), ["Education"]);
});

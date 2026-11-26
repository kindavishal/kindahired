import { z } from "zod";

const Cited = z.object({
  text: z.string(),
  evidence: z.array(z.number().int()).describe("Evidence ids (the number after E) that support every fact in this text."),
});

export const ResumeSchema = z.object({
  headline: z.string().describe("Role family in bold, e.g. 'Developer Relations'."),
  specialties: z.array(z.string()).describe("Two to four short specialties shown after the headline, closest to this job first."),
  summary: Cited,
  experience: z.array(
    z.object({
      title: z.string(),
      company: z.string(),
      company_note: z.string().nullable().describe("Short descriptor in brackets after the company, e.g. 'open-source AI models'."),
      dates: z.string().describe("e.g. 'Sep 2026 – Present'"),
      bullets: z.array(Cited),
    }),
  ),
  projects: z.array(z.object({ name: z.string(), link: z.string().nullable(), text: z.string(), evidence: z.array(z.number().int()) })),
  community: z.array(z.object({ lead: z.string().describe("Bold lead, e.g. 'Autumn Hacks'"), text: z.string(), evidence: z.array(z.number().int()) })),
  education: z.array(z.string()),
  certifications: z.array(z.string()),
  skills: z.array(z.object({ label: z.string(), items: z.string() })),
  fill_ins: z.array(z.string()).describe("Things to double-check that you left out or kept cautious. Never put [FILL IN] or any placeholder in the resume text itself."),
});
export type Resume = z.infer<typeof ResumeSchema>;

export interface ResumeIssue { where: string; problem: string }

const PLACEHOLDER = /\[(FILL|TODO|TBD|ADD|INSERT)[^\]]*\]/i;
export const hasPlaceholder = (t: string | null | undefined) => !!t && PLACEHOLDER.test(t);

/** "Next.js, Linux: [FILL IN]" → "Next.js": drops only the list items that hold a blank. */
function stripFromList(t: string): string {
  return t.split(/\s*[,;·]\s*/).filter((part) => part && !hasPlaceholder(part)).join(", ");
}

/**
 * Drops anything with a placeholder, in every field: the PDF goes out as is, so blanks never
 * ship. A list keeps its other items; a line that is mostly the blank goes.
 */
export function stripPlaceholders(r: Resume): Resume {
  const keep = (t: string) => !hasPlaceholder(t);
  return {
    ...r,
    headline: r.headline.replace(new RegExp(PLACEHOLDER.source, "gi"), "").trim(),
    specialties: r.specialties.filter(keep),
    summary: { ...r.summary, text: r.summary.text.replace(/\s*[^.]*\[(FILL|TODO|TBD|ADD|INSERT)[^\]]*\][^.]*\.?/gi, "").trim() },
    experience: r.experience.map((e) => ({
      ...e,
      company_note: hasPlaceholder(e.company_note) ? null : e.company_note,
      bullets: e.bullets.filter((b) => keep(b.text)),
    })),
    projects: r.projects.filter((p) => keep(p.text) && keep(p.name)).map((p) => ({ ...p, link: hasPlaceholder(p.link) ? null : p.link })),
    community: r.community.filter((c) => keep(c.text) && keep(c.lead)),
    education: r.education.filter(keep),
    certifications: r.certifications.map((c) => (keep(c) ? c : stripFromList(c))).filter(Boolean),
    skills: r.skills.map((s) => ({ ...s, items: keep(s.items) ? s.items : stripFromList(s.items) })).filter((s) => s.items && keep(s.label)),
  };
}

/** Pulls numbers that carry a claim: 116, 1,941, 4x, 60K+, 41%, 300+. Years and list numbering are ignored. */
export function claimNumbers(text: string): string[] {
  const found = text.match(/\d[\d,.]*\s?(?:[kKmM]\+?|\+|x|%)?/g) ?? [];
  return found
    .map((n) => n.replace(/\s/g, "").replace(/[.,]$/, ""))
    .filter((n) => !/^(19|20)\d\d$/.test(n) && !/^\d$/.test(n));
}

const norm = (s: string) => s.toLowerCase().replace(/[\s,]/g, "");

/**
 * The no-invention check. Every line must cite evidence that exists, and every number in the
 * line must appear in the cited evidence. Lines that fail are sent back for one rewrite, and
 * anything still failing is shown to me before I use the resume.
 */
export function validateResume(resume: Resume, evidence: Map<number, string>): ResumeIssue[] {
  const issues: ResumeIssue[] = [];
  const check = (where: string, text: string, ids: number[]) => {
    if (hasPlaceholder(text)) {
      issues.push({ where, problem: "has a placeholder; a resume PDF can't be edited, so leave the claim out instead" });
      return;
    }
    const missing = ids.filter((id) => !evidence.has(id));
    if (missing.length) issues.push({ where, problem: `cites evidence that doesn't exist: ${missing.map((m) => "E" + m).join(", ")}` });
    const cited = ids.filter((id) => evidence.has(id)).map((id) => norm(evidence.get(id)!)).join(" | ");
    if (!ids.length && claimNumbers(text).length) {
      issues.push({ where, problem: "states numbers but cites no evidence" });
      return;
    }
    for (const n of claimNumbers(text)) {
      const bare = norm(n).replace(/[+%x]$|[km]\+?$/i, "");
      if (!cited.includes(norm(n)) && !cited.includes(bare)) {
        issues.push({ where, problem: `the number "${n}" is not in the cited evidence` });
      }
    }
  };
  check("Summary", resume.summary.text, resume.summary.evidence);
  resume.experience.forEach((e) =>
    e.bullets.forEach((b, i) => check(`${e.title} — ${e.company}, bullet ${i + 1}`, b.text, b.evidence)),
  );
  resume.projects.forEach((p) => check(`Project ${p.name}`, p.text, p.evidence));
  resume.community.forEach((c) => check(`${c.lead}`, `${c.lead} ${c.text}`, c.evidence));
  // Lines that carry no evidence still can't hold a blank.
  const plain: [string, string][] = [
    ["Headline", resume.headline],
    ...resume.specialties.map((s, i): [string, string] => [`Specialty ${i + 1}`, s]),
    ...resume.experience.map((e): [string, string] => [`${e.title} — ${e.company}`, `${e.title} ${e.company} ${e.company_note ?? ""} ${e.dates}`]),
    ...resume.projects.map((p): [string, string] => [`Project ${p.name}`, `${p.name} ${p.link ?? ""}`]),
    ...resume.education.map((e, i): [string, string] => [`Education ${i + 1}`, e]),
    ...resume.certifications.map((c, i): [string, string] => [`Certification ${i + 1}`, c]),
    ...resume.skills.map((s): [string, string] => [`Skills: ${s.label}`, `${s.label} ${s.items}`]),
  ];
  for (const [where, text] of plain) {
    if (hasPlaceholder(text)) issues.push({ where, problem: "has a placeholder; leave the claim out instead" });
  }
  return issues;
}

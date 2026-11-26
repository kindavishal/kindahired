import { z } from "zod";

/** The shape of a who's-hiring brief, and small readers for it. No imports beyond zod, so the reminder engine can use it. */

export const Brief = z.object({
  people: z.array(z.object({
    name: z.string(),
    title: z.string().nullable(),
    part: z.enum(["hiring_manager", "recruiter", "team_lead", "team_member", "job_poster", "founder", "referrer"]).describe(
      "hiring_manager: the person the role reports to or who decides. recruiter: talent or HR running the hiring. team_lead: leads the team but may not be the manager. job_poster: posted or shared the opening. referrer: could refer me in.",
    ),
    confidence: z.enum(["high", "medium", "low"]).describe(
      "high: a source says so directly (LinkedIn's hiring team, their own post, the job description, their email to me). medium: strong inference (title and team match). low: a guess worth checking.",
    ),
    evidence: z.string().describe("Why this person, in one sentence, naming the source and its date."),
    source_url: z.string().nullable().describe("Link to the evidence, copied exactly from the notes. Null if none."),
    linkedin_url: z.string().nullable().describe("Their linkedin.com/in/ profile, copied exactly from the notes. Null if not in the notes."),
  })).max(6),
  team: z.string().nullable().describe("The team the role sits in, who leads it, and anything known about its size or recent changes. Null if unknown."),
  signals: z.array(z.object({
    what: z.string().describe("One line: a post about this opening, a related hire, news about the team or company that matters for this role."),
    source_url: z.string().nullable(),
    date: z.string().nullable().describe("YYYY-MM-DD if known."),
  })).max(8),
  angles: z.array(z.string()).max(4).describe("What would strengthen my application or first message here, each tied to a fact about me from the evidence list."),
  open_questions: z.array(z.string()).max(3).describe("What's still unknown and worth finding out (e.g. 'Who leads DevRel since the acquisition?')."),
});
export type BriefData = z.infer<typeof Brief>;

export interface HiringBrief extends BriefData {
  known: { name: string; how: string }[];
  related: { title: string; url: string; location: string | null }[];
  sources: string[];
  researched_at: string;
}

export function getBrief(o: { hiring_brief?: string | null }): HiringBrief | null {
  if (!o.hiring_brief) return null;
  try { return JSON.parse(o.hiring_brief) as HiringBrief; } catch { return null; }
}

/** The person to reach first: the hiring manager if named with some confidence, else the recruiter, else whoever posted it. */
export function bestContact(b: HiringBrief | null): BriefData["people"][number] | null {
  if (!b) return null;
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const order = ["hiring_manager", "team_lead", "recruiter", "job_poster", "founder", "referrer", "team_member"];
  return [...b.people].filter((p) => p.confidence !== "low")
    .sort((a, b2) => order.indexOf(a.part) - order.indexOf(b2.part) || rank[a.confidence] - rank[b2.confidence])[0] ?? null;
}


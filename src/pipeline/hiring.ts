import { existsSync } from "node:fs";
import { loadPlaybook, loadProfile, PATHS } from "../config.ts";
import { all, get, logEvent, nowIso, run } from "../db/index.ts";
import { getOpportunity, roleTokens, type Opportunity } from "../db/opportunities.ts";
import { llm } from "../llm/client.ts";
import { LinkedInUnavailable, readLinkedInJob } from "../sources/linkedin.ts";
import { evidenceBlock } from "./evidence.ts";
import { findCompanyByName, knownPeopleAt, readBoard } from "./companies.ts";
import { Brief, type HiringBrief } from "./hiring-brief.ts";
import { findLinkedInProfile, isLinkedInProfile, isXProfile } from "./profiles.ts";

export { bestContact, getBrief, type HiringBrief } from "./hiring-brief.ts";

/**
 * Who's hiring, for one role: the likely hiring manager and recruiter (each with how sure, and
 * why), the team, who's posted about the opening, the people I already know there, related
 * openings, and what would make the application stronger. Built from the surest sources first:
 * LinkedIn's own "Meet the hiring team", my email and DM threads with them, the post the role
 * came from, the company's job board, then one web search. Nothing is guessed: each person
 * comes with the evidence for naming them.
 */

/** LinkedIn's "Meet the hiring team" and "People you can reach out to", from the job page text. */
export function hiringTeamFrom(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^(meet the hiring team|people you can reach out to|job poster)$/i.test(l.trim()));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^(about the job|about the company|show more|more jobs|similar jobs|people also viewed)$/i.test(l.trim()));
  return lines.slice(start, end > start ? Math.min(end, start + 40) : start + 40).join("\n");
}

const linkedinId = (o: Opportunity) =>
  [o.source_url, o.apply_url].map((l) => l?.match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/)?.[1]).find(Boolean) ?? o.linkedin_job_id;

/** Everything already known about who's involved, from my own data. */
export function knownContext(o: Opportunity): string[] {
  const out: string[] = [];
  const threads = all<{ channel: string; name: string | null; title: string | null; email: string | null; last_from: string; last_message_at: string; last_snippet: string | null; subject: string | null; kind: string }>(
    `SELECT t.channel, c.name, c.title, c.email, t.last_from, t.last_message_at, t.last_snippet, t.subject, t.kind FROM threads t
     LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.opportunity_id = $id ORDER BY t.last_message_at DESC LIMIT 8`, { id: o.id },
  );
  for (const t of threads) {
    out.push(`- ${t.channel} thread${t.name ? ` with ${t.name}${t.title ? ` (${t.title})` : ""}${t.email ? ` <${t.email}>` : ""}` : ""}, ${t.kind}, last ${t.last_from === "me" ? "from me" : "from them"} ${t.last_message_at?.slice(0, 10)}: "${(t.last_snippet ?? t.subject ?? "").replace(/\s+/g, " ").slice(0, 200)}"`);
  }
  const outreach = all<{ name: string; title: string | null; linkedin_url: string | null; status: string; why_them: string | null; reply: string | null }>(
    `SELECT c.name, c.title, c.linkedin_url, r.status, r.why_them, r.reply FROM outreach r JOIN contacts c ON c.id = r.contact_id WHERE r.opportunity_id = $id`, { id: o.id },
  );
  for (const r of outreach) out.push(`- Outreach to ${r.name}${r.title ? ` (${r.title})` : ""}${r.linkedin_url ? ` ${r.linkedin_url}` : ""}: ${r.status}${r.why_them ? `; picked because: ${r.why_them}` : ""}${r.reply ? `; they said: "${r.reply.slice(0, 200)}"` : ""}`);
  // The person who posted the role (X posts and shared posts keep their author as a contact).
  if (o.source_url) {
    const poster = get<{ name: string; title: string | null; x_handle: string | null }>("SELECT name, title, x_handle FROM contacts WHERE notes LIKE $u", { u: `%${o.source_url}%` });
    if (poster) out.push(`- The role was posted by ${poster.name}${poster.x_handle ? ` (@${poster.x_handle} on X)` : ""}${poster.title ? `: ${poster.title.slice(0, 160)}` : ""}. Post: ${o.source_url}`);
    else if (/linkedin\.com\/posts\/|x\.com\/|twitter\.com\//i.test(o.source_url)) out.push(`- The role came from this post: ${o.source_url}`);
  }
  return out;
}

/** Other open roles at the company that share words with this one (same team, likely). */
async function relatedOpenings(o: Opportunity): Promise<HiringBrief["related"]> {
  const c = findCompanyByName(o.company);
  if (!c?.board_type || !c.board_slug || c.needs_check) return [];
  const board = await readBoard({ type: c.board_type, slug: c.board_slug }).catch(() => null);
  if (!board) return [];
  const words = [...roleTokens(o.role)].filter((w) => !/^(senior|lead|manager|head|staff|principal|associate|junior)$/.test(w));
  const own = [o.apply_url, o.source_url].filter(Boolean).join(" ");
  return board.postings
    .filter((p) => !own.includes(p.id) && words.some((w) => p.title.toLowerCase().includes(w)))
    .slice(0, 6).map((p) => ({ title: p.title, url: p.url, location: p.location }));
}

/** Researches one role and saves the brief. */
export async function researchHiring(id: number, deps: { linkedin?: typeof readLinkedInJob | null } = {}): Promise<HiringBrief> {
  const o = getOpportunity(id);
  if (!o) throw new Error(`No opportunity ${id}`);
  const company = o.company.replace(/\(.*?\)/g, "").trim();
  const sources: string[] = [];
  const notes: string[] = [];

  // 1. LinkedIn's own hiring team, when the role is on LinkedIn.
  const li = linkedinId(o);
  const readLi = deps.linkedin === undefined ? (existsSync(PATHS.browserProfile) ? readLinkedInJob : null) : deps.linkedin;
  if (li && readLi) {
    try {
      const job = await readLi(li);
      const team = hiringTeamFrom(job.text);
      if (team) { notes.push(`LinkedIn job page https://www.linkedin.com/jobs/view/${li}/ shows:\n${team}`); sources.push("LinkedIn hiring team"); }
    } catch (err) {
      if (!(err instanceof LinkedInUnavailable)) logEvent("hiring.linkedin_failed", id, String(err).slice(0, 200));
    }
  }

  // 2. My own threads, outreach and the post it came from.
  const known = knownContext(o);
  if (known.length) { notes.push(`From my own messages and records:\n${known.join("\n")}`); sources.push("your messages"); }

  // 3. The company's board, for related openings.
  const related = await relatedOpenings(o);
  if (related.length) sources.push("the company's job board");

  // 4. One web search for who's hiring and who's talking about it.
  const web = await llm.research(`hiring:${id}`, {
    effort: "medium", maxSearches: 10,
    system: `You research who is hiring for one job opening, for ${loadProfile().name}. Public information only. Give a link and a date for every claim, and say plainly when you're unsure.`,
    prompt: [
      `Role: ${o.role}`, `Company: ${company}`,
      o.apply_url && `Posting: ${o.apply_url}`, o.source_url && `Found via: ${o.source_url}`,
      o.jd_text && `Job description (summary):\n${o.jd_text.slice(0, 2500)}`,
      "\nFind: (1) the hiring manager or the person this role reports to; (2) the recruiter or talent partner hiring for it; " +
        "(3) anyone who posted or shared this opening on LinkedIn or X (with the post link and date); (4) the team it sits in and who leads it; " +
        "(5) recent news about that team or the company that matters for this role. For each person give name, title and the evidence.\n" +
        "Then, for each person you name, search for their own profiles (for example \"<name> <company> linkedin\" and \"<name> <company> x.com\") " +
        "and give the exact URLs: their linkedin.com/in/ profile and their x.com/<handle> profile. Only give a profile you're confident is the same person; say \"not found\" otherwise.",
    ].filter(Boolean).join("\n"),
  }).catch((err) => { logEvent("hiring.research_failed", id, String(err).slice(0, 200)); return ""; });
  if (web.trim()) { notes.push(`Web research:\n${web}`); sources.push("web search"); }

  // 5. One structured read of all of it, with my evidence for the angles.
  const { text: evidence } = evidenceBlock();
  const data = await llm.structured(`hiring.brief:${id}`, Brief, {
    effort: "medium",
    system: [
      `You write a short "who's hiring" brief for ${loadProfile().name}'s job application. Use only the notes and the evidence list; never invent a person, title, link or date.`,
      "Copy links exactly from the notes. A person named only by a weak inference is 'low' confidence; say what would confirm them.",
      "People already in my own messages are the most reliable: a recruiter who emailed me about this role is the recruiter.",
      "Angles: what in my evidence speaks to this team's work, in one line each.",
      "Playbook (for tone and what matters to me):", loadPlaybook().split("## 2.")[0].slice(0, 3000),
    ].join("\n"),
    prompt: `<evidence>\n${evidence}\n</evidence>\n\nRole: ${o.role} at ${company}\n${o.jd_text ? `Job description:\n${o.jd_text.slice(0, 3000)}\n` : ""}\n<notes>\n${notes.join("\n\n") || "(nothing found)"}\n</notes>`,
  });

  // Profiles the research didn't turn up: look each one up, so every person on the page links somewhere real.
  // One at a time: the LinkedIn lookups share one logged-in browser.
  const people: HiringBrief["people"] = [];
  for (const p of data.people) {
    people.push({
      ...p,
      linkedin_url: isLinkedInProfile(p.linkedin_url) ? p.linkedin_url : await findLinkedInProfile(p.name, company).catch(() => null),
      x_url: isXProfile(p.x_url) ? p.x_url.replace("twitter.com", "x.com") : null,
    });
  }

  const brief: HiringBrief = { ...data, people, known: knownPeopleAt(o.company), related, sources, researched_at: nowIso() };
  run("UPDATE opportunities SET hiring_brief = $b, hiring_brief_at = $at WHERE id = $id", { b: JSON.stringify(brief), at: brief.researched_at, id });
  logEvent("hiring.researched", id, { people: brief.people.length, sources });
  return brief;
}

/**
 * Roles that need a brief: ones I'm about to apply to or have applied to, without one yet (or
 * with one older than a month). Applied roles first: their first touch needs a person.
 */
export function rolesNeedingResearch(limit = 2): number[] {
  return all<{ id: number }>(
    `SELECT id FROM opportunities WHERE status IN ('applied', 'interviewing', 'ready', 'decide')
       AND (hiring_brief_at IS NULL OR hiring_brief_at < $stale)
     ORDER BY CASE status WHEN 'interviewing' THEN 0 WHEN 'applied' THEN 1 ELSE 2 END, updated_at DESC LIMIT $n`,
    { stale: new Date(Date.now() - 30 * 86400_000).toISOString(), n: limit },
  ).map((r) => r.id);
}

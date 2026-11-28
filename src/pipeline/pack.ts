import { z } from "zod";
import { fileName, loadPlaybook, loadProfile } from "../config.ts";
import { upsertContact, upsertOutreach } from "../db/contacts.ts";
import { logEvent, nowIso, run } from "../db/index.ts";
import { getOpportunity, roleTokens, updateOpportunity, type Opportunity } from "../db/opportunities.ts";
import { reconcileActions } from "../loops/engine.ts";
import { llm } from "../llm/client.ts";
import { renderResumePdf } from "../resume/render.ts";
import { ResumeSchema, stripPlaceholders, validateResume, type Resume, type ResumeIssue } from "../resume/schema.ts";
import { evidenceBlock } from "./evidence.ts";
import { isGenericJobsLink } from "./liveness.ts";
import { getBrief } from "./hiring-brief.ts";
import { findLinkedInProfile, linkedInSearchUrl } from "./profiles.ts";
import { readPage } from "../sources/web.ts";
import { firecrawlAvailable, firecrawlSearch, FirecrawlUnavailable, type SearchResult } from "../sources/firecrawl.ts";
import {
  findPeopleOnLinkedIn, LinkedInUnavailable, readLinkedInJob, type PersonCandidate,
} from "../sources/linkedin.ts";

function systemPrompt(extra: string): string {
  const p = loadProfile();
  return [
    `You work for ${p.name} on their job search. Today is ${new Date().toDateString()}.`,
    "Follow this playbook exactly. It overrides your defaults:",
    "<playbook>",
    loadPlaybook(),
    "</playbook>",
    extra,
  ].join("\n\n");
}

// ---------- 1. Find and read the real posting ----------

const Posting = z.object({
  still_open: z.boolean().nullable(),
  exact_apply_url: z.string().nullable().describe("The application link on the company's own careers page or ATS (Greenhouse, Lever, Ashby, Workable...). Not a job-board copy."),
  posting_url: z.string().nullable(),
  who_can_apply: z.string().describe("Location rules in plain words, including remote limits and time zones."),
  visa_or_sponsorship: z.string().nullable(),
  pay: z.string().nullable(),
  closes_on: z.string().nullable().describe("ISO date (YYYY-MM-DD) if stated, else null."),
  form_questions: z.array(z.string()).describe("Questions on the application form, word for word where possible."),
  jd_summary: z.string().describe("The job description: responsibilities, must-haves, nice-to-haves, years, reporting line."),
  company_brief: z.string().describe("What the company does, stage, recent news worth knowing, and who leads the team."),
});
type Posting = z.infer<typeof Posting>;

const ATS = /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|recruitee\.com|bamboohr\.com|jobvite\.com|teamtailor\.com|breezy\.hr|personio\.|rippling\.com|wellfound\.com\/jobs/i;

/** The company's own careers page or applicant tracking system, not a job board's copy. */
export function onCompanyPage(url: string, company: string): boolean {
  const slug = company.toLowerCase().replace(/\(.*?\)/g, " ").trim().split(/\s+/)[0]?.replace(/[^a-z0-9]/g, "") ?? "";
  // The name must be in the site's own domain (careers.toasttab.com), not just somewhere in the
  // path: job boards put the company in their links too (startup.jobs/...-toast-123).
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a URL */ }
  return ATS.test(url) || (slug.length > 2 && host.includes(slug));
}

const BOARDS = /linkedin\.com|indeed\.|glassdoor\.|naukri\.|ziprecruiter\.|monster\.|simplyhired\.|talent\.com|jooble\.|builtin\.com/i;

/** Search results most likely to be the real posting first: ATS and company pages, then the rest; boards last. */
export function rankPostingResults(results: SearchResult[], o: Pick<Opportunity, "company" | "role">): string[] {
  const words = [...roleTokens(o.role)];
  const score = (r: SearchResult) => {
    const text = `${r.title} ${r.description}`.toLowerCase();
    return (ATS.test(r.url) ? 4 : 0) + (onCompanyPage(r.url, o.company) ? 3 : 0)
      + words.filter((w) => text.includes(w)).length / Math.max(1, words.length) * 2
      - (BOARDS.test(r.url) ? 5 : 0);
  };
  return [...results].sort((a, b) => score(b) - score(a)).filter((r) => !BOARDS.test(r.url)).map((r) => r.url);
}

async function resolvePosting(o: Opportunity, context: string): Promise<Posting> {
  const parse = (notes: string) => llm.structured(`posting.parse:${o.id}`, Posting, {
    effort: "low",
    system: "Turn the job page or research notes into the given fields. Use only what they say; null when they don't say. " +
      "exact_apply_url is the application link on the company's own careers page or applicant tracking system, never a job-board copy.",
    prompt: notes,
  });

  // Fast path for LinkedIn jobs: read the job page through my logged-in browser.
  const linkedinId = [o.source_url, o.apply_url].map((l) => l?.match(/linkedin\.com\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1]).find(Boolean) ?? o.linkedin_job_id;
  if (linkedinId) {
    const job = await readLinkedInJob(linkedinId).catch(() => null);
    if (job && job.text.length > 500) {
      const posting = await parse(`Role: ${o.role} at ${o.company}\nPage: LinkedIn job ${linkedinId}\n\n${job.text}`);
      const linkedinUrl = `https://www.linkedin.com/jobs/view/${linkedinId}/`;
      // LinkedIn doesn't show the company's own apply link without clicking Apply, so the
      // LinkedIn page is the link unless the text names a better one.
      if (!posting.exact_apply_url || /linkedin\.com/i.test(posting.exact_apply_url) || isGenericJobsLink(posting.exact_apply_url)) posting.exact_apply_url = linkedinUrl;
      posting.posting_url ??= linkedinUrl;
      if (job.closed) posting.still_open = false;
      if (posting.jd_summary.length > 200) return posting;
    }
  }

  // Reads candidate pages and pulls the details out of the first that's the company's own posting.
  const fromPages = async (candidates: string[]): Promise<Posting | null> => {
    // Application-form links (".../application", "#app") often hold no description; try the posting page too.
    const links = candidates.flatMap((l) => [l.replace(/\/application\/?$|#app$/i, ""), l]);
    for (const link of [...new Set(links)]) {
      const page = await readPage(link).catch(() => null);
      if (!page) continue;
      const posting = await parse(`Role: ${o.role} at ${o.company}\nPage: ${page.url}\n\n${page.text}`);
      if (onCompanyPage(page.url, o.company) && posting.jd_summary.length > 200) {
        posting.exact_apply_url ??= page.url;
        posting.posting_url ??= page.url;
        return posting;
      }
    }
    return null;
  };

  // Fast path: read the posting's own page. Seconds, not minutes.
  const known = await fromPages([o.apply_url, o.source_url].filter((l): l is string => !!l));
  if (known) return known;

  // Quick search: one Firecrawl search (2 credits), then the best-looking results are read in my
  // own browser for free. Most roles from email alerts are found here without the slow research.
  if (firecrawlAvailable()) {
    try {
      const results = await firecrawlSearch(`${o.company.replace(/\(.*?\)/g, "").trim()} ${o.role} job`, { limit: 8, label: `posting:${o.id}` });
      const found = await fromPages(rankPostingResults(results, o).slice(0, 3));
      if (found) { logEvent("posting.found_by", o.id, "firecrawl"); return found; }
    } catch (err) {
      if (!(err instanceof FirecrawlUnavailable)) logEvent("firecrawl.failed", o.id, String(err).slice(0, 200));
    }
  }

  // Slow path: search the web for the company's own posting.
  const notes = await llm.research(`posting:${o.id}`, {
    effort: "medium",
    maxSearches: 10,
    system: systemPrompt("Right now your job is step 1 of the playbook: find and check the role."),
    prompt: [
      `Role: ${o.role}`,
      `Company: ${o.company}`,
      o.source_url && `Where I found it: ${o.source_url}`,
      o.apply_url && `Link I have: ${o.apply_url}`,
      context && `What the source said:\n${context}`,
      "\nFind the exact application link on the company's own careers page or ATS, open the real posting and read it. " +
        "Write down: whether it's still open, the exact apply link, location rules, visa or sponsorship, pay, closing date, the questions on the form, " +
        "the full job description, and a short brief on the company (what it does, stage, recent news, who leads this team). " +
        "If you can't find something, say so. Don't guess.",
    ].filter(Boolean).join("\n"),
  });
  return parse(notes);
}

// ---------- 2. Honest fit read and hard gates ----------

const FitRead = z.object({
  gate_result: z.enum(["pass", "ask", "skip"]).describe("skip: a hard gate rules me out with no path. ask: a gate I must decide on (e.g. relocation, language). pass: no blocking gate."),
  hard_gate: z.string().describe("The gates in one line, or 'None'."),
  skip_reason: z.string().nullable(),
  fit_read: z.string().describe("What fits, what's a stretch, any hard gate. Honest, in my voice, three to five sentences."),
  verdict: z.enum(["apply", "stretch", "skip"]),
  next_step: z.string().describe("The single next thing I should do, in one or two short sentences."),
});

// ---------- 3. Cover note and form answers ----------

const Application = z.object({
  cover_note: z.string().describe("Short note to paste into the application, in my voice. Ends with my name and portfolio."),
  form_answers: z.string().describe("Each form question with a suggested answer. Use [FILL IN: ...] where only I know."),
  fill_ins: z.array(z.string()),
});

// ---------- 4. People to reach out to ----------

const Outreach = z.object({
  people: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      linkedin_url: z.string().nullable(),
      location: z.string().nullable(),
      degree: z.string().nullable(),
      why_them: z.string(),
      hook: z.string().describe("The recent post or public thing I'll mention, in a few words."),
      hook_source: z.string().describe("Where the hook came from and how old it is."),
      connection_note: z.string().describe("Under 300 characters. Fits a LinkedIn connection request."),
      full_dm: z.string().describe("The message to send once they accept (or now, if already connected)."),
      send_time_ist: z.string().describe("Best time to send, in my time zone, based on theirs."),
    }),
  ).max(3),
});

export interface PackResult {
  opportunity: Opportunity;
  resumePath: string | null;
  resumeIssues: ResumeIssue[];
  fillIns: string[];
  skipped: boolean;
}

function roleBlock(o: Opportunity): string {
  return [
    `Role: ${o.role} at ${o.company}`,
    o.who_can_apply && `Who can apply: ${o.who_can_apply}`,
    o.visa && `Visa: ${o.visa}`,
    o.pay && `Pay: ${o.pay}`,
    o.jd_text && `\nJob description:\n${o.jd_text}`,
    o.company_brief && `\nCompany:\n${o.company_brief}`,
  ].filter(Boolean).join("\n");
}

/**
 * Stage 1, the quick part: find and read the real posting, then the honest fit read.
 * Runs on the fast model. The result is a summary card; nothing else is built until I say go.
 */
export async function buildSummary(opportunityId: number, opts: { context?: string } = {}): Promise<{ opportunity: Opportunity; skipped: boolean }> {
  const o = getOpportunity(opportunityId);
  if (!o) throw new Error(`No opportunity ${opportunityId}`);
  updateOpportunity(o.id, { pack_status: "summarizing", pack_error: null });
  logEvent("summary.start", o.id);
  try {
    const posting = await resolvePosting(o, opts.context ?? o.jd_text ?? "");
    updateOpportunity(o.id, {
      // A careers homepage isn't this job's link: it can't be applied through or checked later.
      apply_url: [posting.exact_apply_url, o.apply_url, posting.posting_url].find((l) => l && !isGenericJobsLink(l)) ?? posting.exact_apply_url ?? o.apply_url,
      source_url: o.source_url ?? posting.posting_url,
      who_can_apply: posting.who_can_apply,
      visa: posting.visa_or_sponsorship,
      pay: posting.pay,
      closes_on: posting.closes_on,
      jd_text: posting.jd_summary,
      company_brief: posting.company_brief,
      form_questions: JSON.stringify(posting.form_questions),
    });
    const { text: evidence } = evidenceBlock();
    const fit = await llm.structured(`fit:${o.id}`, FitRead, {
      effort: "medium",
      system: systemPrompt("Your job now is step 2 of the playbook: the honest fit read. Facts about me are in the evidence list; nothing else counts."),
      prompt: `<evidence>\n${evidence}\n</evidence>\n\n${roleBlock(getOpportunity(o.id)!)}${posting.still_open === false ? "\nNOTE: the posting looks closed." : ""}`,
    });
    const skipped = fit.gate_result === "skip" || fit.verdict === "skip" || posting.still_open === false;
    updateOpportunity(o.id, {
      gate_result: fit.gate_result,
      hard_gate: fit.hard_gate,
      fit_read: fit.fit_read,
      fit_verdict: fit.verdict,
      next_step: fit.next_step,
      skip_reason: skipped ? fit.skip_reason ?? (posting.still_open === false ? "Posting is closed." : fit.hard_gate) : null,
      status: skipped ? "skipped" : undefined,
      pack_status: "summary",
    });
    // A fresh read can overturn an earlier automatic skip (my own Skip is a "dropped", untouched).
    if (!skipped && o.status === "skipped") run("UPDATE opportunities SET status = 'found' WHERE id = $id", { id: o.id });
    logEvent(skipped ? "summary.skipped" : "summary.ready", o.id, fit.verdict);
    reconcileActions();
    return { opportunity: getOpportunity(o.id)!, skipped };
  } catch (err) {
    updateOpportunity(o.id, { pack_status: "failed", pack_error: String(err instanceof Error ? err.message : err) });
    logEvent("summary.failed", o.id, String(err));
    throw err;
  }
}

export { stripPlaceholders } from "../resume/schema.ts";

/** LinkedIn profile for a named person, or a people-search link when none is found. */
async function profileLink(name: string, company: string): Promise<string> {
  return (await findLinkedInProfile(name, company)) ?? linkedInSearchUrl(name, company);
}

/** The tailored resume on its own: written from evidence, checked, blanks stripped, rendered. */
async function writeResume(o: Opportunity, facts: string, rows: { id: number; claim: string }[]) {
  const role = roleBlock(o);
  const resumeSystem = systemPrompt(
    "Your job now is step 4: one tailored resume for this role. Build it only from the evidence list, and cite evidence ids on every line. " +
      "Lead with the proof points closest to this job. Copy numbers exactly as the evidence states them. " +
      "Where evidence is marked UNSETTLED, prefer the portfolio's version and note it in fill_ins. " +
      "Never write [FILL IN] or any placeholder anywhere, including education, certifications and skills: this becomes a PDF that goes out as is. If something is uncertain, leave it out and say so in fill_ins. " +
      "Keep it to two or three pages, in the same sections as my usual resume.",
  );
  const evidenceMap = new Map(rows.map((r) => [r.id, r.claim]));
  let resume: Resume = await llm.structured(`resume:${o.id}`, ResumeSchema, {
    effort: "high", maxTokens: 32000, system: resumeSystem, prompt: `${facts}\n\n${role}`,
  });
  let issues = validateResume(resume, evidenceMap);
  if (issues.length) {
    resume = await llm.structured(`resume.fix:${o.id}`, ResumeSchema, {
      effort: "medium", maxTokens: 32000, system: resumeSystem,
      prompt: `${facts}\n\n${role}\n\nYour draft:\n${JSON.stringify(resume)}\n\nThese lines failed the evidence check. Fix each one: cite the right evidence, or remove the claim.\n${issues.map((i) => `- ${i.where}: ${i.problem}`).join("\n")}`,
    });
  }
  // Always, not only after a failed check: a blank in education or skills used to reach the PDF.
  resume = stripPlaceholders(resume);
  issues = validateResume(resume, evidenceMap);
  const slug = `${o.company}_${o.role}`.replace(/[^\w]+/g, "_").slice(0, 60);
  return { resume, issues, path: await renderResumePdf(resume, `${fileName(loadProfile().name)}_Resume_${slug}.pdf`) };
}

/** Writes just the resume again (from the dashboard), leaving the drafts and people as they are. */
export async function rebuildResume(opportunityId: number): Promise<{ path: string; issues: ResumeIssue[] }> {
  const o = getOpportunity(opportunityId);
  if (!o) throw new Error(`No opportunity ${opportunityId}`);
  const { text, rows } = evidenceBlock();
  const out = await writeResume(o, `<evidence>\n${text}\n</evidence>`, rows);
  updateOpportunity(o.id, {
    resume_path: out.path,
    check_notes: out.resume.fill_ins.length ? out.resume.fill_ins.join("\n") : null,
    pack_error: out.issues.length ? `Check these resume lines: ${out.issues.map((i) => `${i.where} (${i.problem})`).join("; ")}` : null,
  }, { byUser: false });
  logEvent("resume.rebuilt", o.id, { issues: out.issues.length });
  return { path: out.path, issues: out.issues };
}

/**
 * Stage 2, after I tap Build pack: the tailored resume, the cover note and form answers, and the
 * people to contact. The resume, the application and the people search run at the same time.
 */
export async function buildFullPack(opportunityId: number): Promise<PackResult> {
  let o = getOpportunity(opportunityId);
  if (!o) throw new Error(`No opportunity ${opportunityId}`);
  updateOpportunity(o.id, { pack_status: "building", pack_error: null }, { byUser: false });
  logEvent("pack.start", o.id);
  try {
    const { text: evidence, rows } = evidenceBlock();
    const facts = `<evidence>\n${evidence}\n</evidence>`;
    const role = roleBlock(o);
    const formQuestions: string[] = o.form_questions ? JSON.parse(o.form_questions) : [];

    const makeResume = () => writeResume(o!, facts, rows);
    const makeApplication = () => llm.structured(`application:${o!.id}`, Application, {
      effort: "medium",
      system: systemPrompt(
        "Your job now: the cover note and form answers for this application. Facts only from the evidence list. Answer location and visa questions honestly, per the playbook. " +
        "Use [FILL IN: short question] only for things only I can answer, and list each of those questions in fill_ins in the same order.",
      ),
      prompt: `${facts}\n\n${role}\n\nForm questions:\n${formQuestions.map((q) => `- ${q}`).join("\n") || "(none found)"}`,
    });
    const findPeople = async (): Promise<{ notes: string; source: string }> => {
      try {
        const candidates: PersonCandidate[] = await findPeopleOnLinkedIn(o!.company, o!.role);
        if (candidates.length) {
          return {
            source: "linkedin",
            notes: candidates.map((c) => `- ${c.name} | ${c.headline} | ${c.location ?? ""} | ${c.degree ?? ""} | ${c.url}\n  Recent posts:\n${c.recentPosts.map((p) => `   • ${p}`).join("\n") || "   (none found)"}`).join("\n"),
          };
        }
      } catch (err) {
        if (!(err instanceof LinkedInUnavailable)) throw err;
      }
      return {
        source: "web",
        notes: await llm.research(`people:${o!.id}`, {
          effort: "medium", maxSearches: 8,
          system: systemPrompt("Your job now is step 5: find the right people. Use only public information."),
          prompt: `${role}\n\nFind the best 3 people to contact about this role: the hiring manager, whoever posted the job, the lead of the team this role sits in, or a founder. For each, give name, title, their LinkedIn profile URL (linkedin.com/in/...), location, and one recent public post or talk I could mention, with its date.`,
        }),
      };
    };

    const [resumeOut, app, people] = await Promise.all([makeResume(), makeApplication(), findPeople()]);

    const outreach = await llm.structured(`outreach:${o.id}`, Outreach, {
      effort: "medium",
      system: systemPrompt(
        "Your job now is step 5 of the playbook: pick up to 3 people and draft outreach. Never invent a post or a fact. " +
        "Copy each person's LinkedIn URL exactly from the notes. If a person has no usable hook, say so in hook_source and keep the note plain.",
      ),
      prompt: `${facts}\n\n${role}\n\nMy application angle (cover note):\n${app.cover_note}\n\nPeople found (${people.source}):\n${people.notes}${briefNotes(getOpportunity(o.id)!)}`,
    });

    // Every person gets a profile link, so every note can be sent with one tap.
    const links: string[] = [];
    for (const p of outreach.people) {
      links.push(p.linkedin_url && /linkedin\.com\/in\//i.test(p.linkedin_url) ? p.linkedin_url : await profileLink(p.name, o.company));
    }
    outreach.people.forEach((p, i) => {
      const contact = upsertContact({ name: p.name, title: p.title, linkedin_url: links[i].includes("/in/") ? links[i] : null, location: p.location, degree: p.degree });
      upsertOutreach({
        opportunity_id: o!.id, contact_id: contact.id, why_them: p.why_them, hook: p.hook, hook_source: p.hook_source,
        connection_note: p.connection_note, full_dm: p.full_dm, send_time: p.send_time_ist,
      });
      if (!links[i].includes("/in/")) {
        run("UPDATE contacts SET notes = coalesce(notes, $n) WHERE id = $id", { n: `Profile search: ${links[i]}`, id: contact.id });
      }
    });

    updateOpportunity(o.id, {
      status: o.gate_result === "ask" ? "decide" : "ready",
      cover_note: app.cover_note,
      form_answers: app.form_answers,
      resume_path: resumeOut.path,
      pack_status: "ready",
      pack_ready_at: nowIso(),
      check_notes: resumeOut.resume.fill_ins.length ? resumeOut.resume.fill_ins.join("\n") : null,
      pack_error: resumeOut.issues.length ? `Check these resume lines: ${resumeOut.issues.map((i) => `${i.where} (${i.problem})`).join("; ")}` : null,
    });
    logEvent("pack.ready", o.id, { issues: resumeOut.issues.length, people: outreach.people.length, peopleSource: people.source });
    reconcileActions();
    o = getOpportunity(o.id)!;
    return { opportunity: o, resumePath: resumeOut.path, resumeIssues: resumeOut.issues, fillIns: app.fill_ins, skipped: false };
  } catch (err) {
    updateOpportunity(o.id, { pack_status: "failed", pack_error: String(err instanceof Error ? err.message : err) });
    logEvent("pack.failed", o.id, String(err));
    throw err;
  }
}

/** The who's-hiring brief, when there is one: the hiring manager and recruiter come first. */
function briefNotes(o: Opportunity): string {
  const b = getBrief(o);
  if (!b?.people.length) return "";
  return `\n\nWho's hiring (researched ${b.researched_at.slice(0, 10)}; prefer these people, in this order, when they fit):\n${b.people.map((p) =>
    `- ${p.name}${p.title ? `, ${p.title}` : ""} | ${p.part} | ${p.confidence} | ${p.evidence}${p.linkedin_url ? ` | ${p.linkedin_url}` : ""}`).join("\n")}${b.angles.length ? `\nAngles: ${b.angles.join("; ")}` : ""}`;
}

/** Both stages in one go (command line and tests). */
export async function buildPack(opportunityId: number, opts: { context?: string } = {}): Promise<PackResult> {
  const summary = await buildSummary(opportunityId, opts);
  if (summary.skipped) return { opportunity: summary.opportunity, resumePath: null, resumeIssues: [], fillIns: [], skipped: true };
  return buildFullPack(opportunityId);
}

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadPlaybook, loadProfile } from "../config.ts";
import { upsertContact } from "../db/contacts.ts";
import { all, get, kvGet, kvSet, logEvent, run } from "../db/index.ts";
import {
  findOpportunity, getOpportunity, opportunitiesAtCompany, rejectedAt, sameCompany, sameRole, STATUS_RANK, updateOpportunity, upsertOpportunity, type Opportunity,
} from "../db/opportunities.ts";
import { reconcileActions } from "../loops/engine.ts";
import { llm, willRunLocally } from "../llm/client.ts";
import { PlanUnavailableError } from "../llm/providers.ts";
import { backfillQuery, getMessages, listMessageIds, RECENT_QUERY, type MailMessage } from "../sources/gmail.ts";
import { readLinkedInJob, syncLinkedInJobs, type SavedJob } from "../sources/linkedin.ts";
import { readPage } from "../sources/web.ts";
import { reviewInFlight } from "./review.ts";

// ---------- Screening: is this worth a full pack? ----------

export const screenerSystem = () => {
  const p = loadProfile();
  return [
    `You screen job-search messages for ${p.name} (${p.location}). Target roles: ${p.targets.join("; ")}.`,
    "Playbook rules that matter for screening:",
    loadPlaybook().split("## 2.")[0],
    "Be strict about relevance: 'high' only for roles in the target families that the location rules don't rule out.",
    SCREENING_RULES,
  ].join("\n\n");
};

// Spelled out in the prompt, not only in the answer format: smaller local models don't read
// field descriptions in the schema.
const SCREENING_RULES = `How to sort each message:
- kind "conversation": a real person writing to me personally, or me writing to them. Replies ("Re:"), intros, a recruiter or founder reaching out to me by name. Even if it mentions a role, it is a conversation, not an alert.
- kind "application_update": an automated email from a company or applicant tracking system (Greenhouse, Lever, Ashby, Workable, Workday, SmartRecruiters, LinkedIn "application sent") about an application I made: confirmation, rejection, interview or assessment invite, offer.
- kind "job_alert": an automated list or newsletter of open roles not addressed to me personally (LinkedIn, Indeed, Wellfound, Naukri alerts, job newsletters).
- kind "other": anything else (shopping, banking, social notifications).
- update: what the message means for my application, for an application_update or a conversation with the company or its recruiter: "applied" for a confirmation, "interview" for an interview or call invite, "rejected" for a no, "offer" for an offer. Use "closed" when they say the role isn't open to me even without the word rejection: it's limited to another country or region (for example "this role is located in Singapore", "we can't relocate you", "we can't hire in India"), there's a visa or work-permit block, the role is filled, paused or cancelled, or they won't move forward. Otherwise "none".
- update_reason: for "rejected" or "closed", the reason in their words, under 15 words (for example "Role is Singapore-based; can't relocate due to visa limits"). Otherwise null.
- jobs: every role named. For a conversation or update, list the one role it's about.
- about_company and about_role: only the company name and the role title, for conversations and updates. Never a description. Null for alerts and other.
- person_name and person_title: the other person in a conversation, otherwise null.
- needs_my_reply: true only for a conversation where they wrote last and asked me something or expect an answer.`;

const Classified = z.object({
  results: z.array(
    z.object({
      message_id: z.string(),
      kind: z.enum(["job_alert", "conversation", "application_update", "other"]).describe(
        "job_alert: automated list of postings. conversation: a person writing to me (or me to them) about a role or intro. application_update: an ATS or company email about my application. other: not job-related.",
      ),
      jobs: z.array(
        z.object({
          company: z.string(),
          role: z.string(),
          url: z.string().nullable(),
          location: z.string().nullable(),
          relevance: z.enum(["high", "medium", "low"]),
        }),
      ).describe("Every posting mentioned (alerts may list many)."),
      about_company: z.string().nullable().describe("For conversations and updates: the company the thread is about."),
      about_role: z.string().nullable(),
      person_name: z.string().nullable().describe("The other person in the conversation (not me)."),
      person_title: z.string().nullable(),
      needs_my_reply: z.boolean().describe("True if the latest message is from them and asks me something or expects an answer."),
      update: z.enum(["applied", "rejected", "closed", "interview", "offer", "none"]),
      update_reason: z.string().nullable().optional().describe("For rejected or closed: why, in under 15 words."),
    }),
  ),
});
export type ClassifiedItem = z.infer<typeof Classified>["results"][number];

const ClassifiedOne = Classified.shape.results.element.omit({ message_id: true });
const asText = (m: MailMessage) =>
  `<message id="${m.id}" from_me="${m.fromMe}">\nFrom: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body.slice(0, 4000)}\n</message>`;

export async function classifyMail(batch: MailMessage[]): Promise<ClassifiedItem[]> {
  // The local model does better, and faster, on one short message at a time.
  if (await willRunLocally("gmail.classify")) {
    const out: ClassifiedItem[] = [];
    for (const m of batch) {
      const one = await llm.structured("gmail.classify", ClassifiedOne, {
        effort: "low", numCtx: 8192, system: screenerSystem(), prompt: asText(m),
      });
      out.push({ ...one, message_id: m.id });
    }
    return out;
  }
  const { results } = await llm.structured("gmail.classify", Classified, {
    effort: "low",
    maxTokens: 16000,
    system: screenerSystem(),
    prompt: batch.map(asText).join("\n\n"),
  });
  return results;
}

/** New opportunity from any source. High or medium relevance gets a full pack queued. */
export function addOpportunity(
  company: string,
  role: string,
  fields: { source: string; source_url?: string | null; apply_url?: string | null; jd_text?: string | null; linkedin_job_id?: string | null; saved_on_linkedin?: number },
  relevance: "high" | "medium" | "low" = "high",
  opts: { receivedAt?: string } = {},
): { opportunity: Opportunity; isNew: boolean } {
  const existing = findOpportunity(company, role, fields.linkedin_job_id);
  const opportunity = upsertOpportunity(company, role, { ...fields, status: "found" });
  const isNew = !existing;
  // A full pack costs several minutes of my Claude plan, so only for postings that can still be
  // acted on: a named company, and (for email) an alert from the last week. Older or anonymous
  // ones stay listed as found, with a button to build the pack.
  const fresh = !opts.receivedAt || Date.now() - new Date(opts.receivedAt).getTime() < 7 * 86400_000;
  const named = !/^(unknown|confidential|undisclosed|n\/?a|stealth)\b/i.test(company.trim());
  if (isNew && relevance !== "low" && fresh && named && opportunity.pack_status === "none") {
    updateOpportunity(opportunity.id, { pack_status: "queued" });
  }
  if (isNew && relevance === "low") updateOpportunity(opportunity.id, { status: "skipped", skip_reason: "Low match on first screen", pack_status: "ready" });
  return { opportunity: findOpportunity(company, role, fields.linkedin_job_id)!, isNew };
}

/** Files one message on its thread (any channel) and applies what it says about the application. */
export function linkThread(m: MailMessage, c: ClassifiedItem, channel = "email", contactId: number | null = null): number | null {
  // A message in an email thread I already track is about that thread's role, whatever the
  // screener calls the company this time ("Verifinity" in one reply, "DevRev" in the next).
  let opportunityId: number | null = get<{ opportunity_id: number | null }>(
    "SELECT opportunity_id FROM threads WHERE channel = $channel AND external_id = $t", { t: m.threadId, channel },
  )?.opportunity_id ?? null;
  if (!opportunityId && c.about_company) {
    // A conversation or update about a company I already track belongs to that role, even when
    // the email words the title differently. Only an unknown company gets a new role.
    const atCompany = opportunitiesAtCompany(c.about_company);
    const active = atCompany.filter((o) => !["dropped", "skipped", "rejected"].includes(o.status));
    // When a company has two records for one role, the one I've applied to or am interviewing for wins.
    const byProgress = [...atCompany].sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0));
    const match = (c.about_role && byProgress.find((o) => sameRole(o.role, c.about_role!)))
      || (active.length ? active.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] : atCompany[0]);
    opportunityId = match?.id
      ?? (c.about_role ? upsertOpportunity(c.about_company, c.about_role, { source: "gmail" }).id : null);
  }
  const contact = contactId ? { id: contactId } : !m.fromMe && c.person_name
    ? upsertContact({ name: c.person_name, title: c.person_title, email: m.fromEmail || null })
    : null;

  run(
    `INSERT INTO threads (channel, external_id, opportunity_id, contact_id, subject, kind)
     VALUES ($channel, $tid, $opp, $contact, $subject, $kind)
     ON CONFLICT(channel, external_id) DO UPDATE SET
       opportunity_id = coalesce(threads.opportunity_id, excluded.opportunity_id),
       contact_id = coalesce(threads.contact_id, excluded.contact_id)`,
    { channel, tid: m.threadId, opp: opportunityId, contact: contact?.id ?? null, subject: m.subject, kind: c.kind === "conversation" ? "conversation" : c.kind },
  );
  const thread = get<{ id: number; last_message_at: string | null }>("SELECT id, last_message_at FROM threads WHERE channel = $channel AND external_id = $t", { t: m.threadId, channel })!;
  run(
    `INSERT INTO messages (thread_id, external_id, from_me, sender, sent_at, body)
     VALUES ($thread, $id, $me, $sender, $at, $body) ON CONFLICT(external_id) DO NOTHING`,
    { thread: thread.id, id: m.id, me: m.fromMe ? 1 : 0, sender: m.from, at: m.date, body: m.body.slice(0, 8000) },
  );
  // An email I sent to someone with a drafted note counts as the note sent: its task closes on
  // its own and the follow-up clock starts, with no need to mark it on the dashboard.
  if (m.fromMe && channel === "email") {
    for (const addr of new Set((m.to.toLowerCase().match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []))) {
      run(`UPDATE outreach SET status = 'dm_sent', sent_at = coalesce(sent_at, $at)
           WHERE status IN ('drafted', 'note_sent') AND contact_id IN (SELECT id FROM contacts WHERE lower(email) = $e)`, { at: m.date, e: addr });
    }
  }
  if (!thread.last_message_at || m.date >= thread.last_message_at) {
    run(
      `UPDATE threads SET last_message_at = $at, last_from = $from, last_snippet = $snip, needs_reply = $nr, status = 'open' WHERE id = $id`,
      { at: m.date, from: m.fromMe ? "me" : "them", snip: m.body.slice(0, 280), nr: !m.fromMe && c.needs_my_reply ? 1 : 0, id: thread.id },
    );
  }

  // An interview invite or offer sent after a rejection: they came back, so the role reopens.
  if (opportunityId && (c.update === "interview" || c.update === "offer")) {
    const cur = getOpportunity(opportunityId);
    const noAt = cur?.status === "rejected" ? rejectedAt(opportunityId) : null;
    if (noAt && m.date > noAt) {
      updateOpportunity(opportunityId, { status: c.update === "offer" ? "offer" : "interviewing", skip_reason: null, next_step: `They came back after the earlier no: ${m.subject}` }, { reopen: true });
      logEvent("opportunity.reopened", opportunityId, { via: "email", subject: m.subject });
      run("UPDATE threads SET status = 'open', closed_reason = NULL WHERE opportunity_id = $o AND status = 'closed' AND last_message_at >= $at", { o: opportunityId, at: noAt });
    }
  }
  if (opportunityId && c.update !== "none") {
    // "Closed" (wrong region, visa block, role filled) ends the application the same way a no does.
    const status = { applied: "applied", rejected: "rejected", closed: "rejected", interview: "interviewing", offer: "offer" }[c.update];
    const ended = c.update === "rejected" || c.update === "closed";
    const reason = c.update_reason?.trim() || (c.update === "rejected" ? "They said no" : "Role closed to me");
    updateOpportunity(opportunityId, {
      status,
      ...(c.update === "applied" ? { date_applied: m.date.slice(0, 10) } : {}),
      ...(ended ? { skip_reason: reason, next_step: `Closed: ${reason}` } : {}),
    });
    if (ended) run("UPDATE threads SET status = 'closed', closed_reason = $r WHERE id = $id", { id: thread.id, r: reason });
  }
  return opportunityId;
}

type MailStats = {
  scanned: number; newJobs: number; conversations: number; needsReply: number; newOpportunityIds: number[];
  /** Roles that got a new email this sync, so their status can be re-read. */
  touchedOpportunityIds?: number[];
};

/** Files each classified message: new postings, conversations, and application updates. */
export function fileMessages(batch: MailMessage[], classified: ClassifiedItem[], stats: MailStats) {
  for (const m of batch) {
    const c = classified.find((r) => r.message_id === m.id);
    run(
      `INSERT INTO inbox_items (source, external_id, title, raw, status) VALUES ('gmail', $id, $title, $raw, $status)
       ON CONFLICT(source, external_id) DO NOTHING`,
      { id: m.id, title: m.subject, raw: JSON.stringify(c ?? null), status: c && c.kind !== "other" ? "processed" : "ignored" },
    );
    if (!c || c.kind === "other") continue;
    for (const job of c.jobs) {
      // The role an update or conversation is about is filed with its thread below, so it isn't
      // also added as a fresh posting (that's how an application confirmation became a "new match").
      if (c.kind === "application_update") continue;
      if (c.kind === "conversation" && c.about_company && sameCompany(job.company, c.about_company)) continue;
      const { opportunity, isNew } = addOpportunity(job.company, job.role, { source: "gmail", source_url: job.url, jd_text: `${m.subject}\n${m.body.slice(0, 3000)}` }, job.relevance);
      if (isNew && job.relevance !== "low") { stats.newJobs++; stats.newOpportunityIds.push(opportunity.id); }
    }
    if (c.kind === "conversation" || c.kind === "application_update") {
      const touched = linkThread(m, c);
      if (touched) (stats.touchedOpportunityIds ??= []).includes(touched) || stats.touchedOpportunityIds!.push(touched);
      if (c.kind === "conversation") stats.conversations++;
      if (!m.fromMe && c.needs_my_reply) stats.needsReply++;
    }
  }
}

/** Pulls new mail, files every job-related message, and returns what's new and urgent. */
export async function syncGmail(opts: { backfill?: boolean } = {}) {
  const query = opts.backfill ? backfillQuery() : RECENT_QUERY;
  const ids = await listMessageIds(query, opts.backfill ? 1000 : 200);
  const known = new Set(all<{ external_id: string }>("SELECT external_id FROM inbox_items WHERE source = 'gmail'").map((r) => r.external_id));
  const fresh = ids.filter((m) => !known.has(m.id));
  const stats: MailStats = { scanned: fresh.length, newJobs: 0, conversations: 0, needsReply: 0, newOpportunityIds: [] };

  for (let i = 0; i < fresh.length; i += 10) {
    const batch = await getMessages(fresh.slice(i, i + 10).map((m) => m.id));
    let classified: ClassifiedItem[];
    try {
      classified = await classifyMail(batch);
    } catch (err) {
      logEvent("gmail.classify_failed", null, String(err));
      // Account problems (no credit, bad key) affect every batch: stop now, retry on the next run.
      if (err instanceof PlanUnavailableError || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
        || (err instanceof Anthropic.BadRequestError && /credit|billing/i.test(err.message))) throw err;
      continue; // not marked as seen, so it's retried next time
    }
    fileMessages(batch, classified, stats);
  }
  // A new email on an application in flight gets the whole conversation re-read, so a status the
  // screener couldn't judge from one message ("we can't relocate you") is still corrected.
  if (stats.touchedOpportunityIds?.length) {
    const changed = await reviewInFlight(stats.touchedOpportunityIds);
    if (changed.length) logEvent("status.corrected", null, changed);
  }
  kvSet("gmail.lastSync", new Date().toISOString());
  if (opts.backfill) kvSet("gmail.backfilled", "1");
  reconcileActions();
  logEvent("gmail.sync", null, stats);
  return stats;
}

// ---------- LinkedIn saved and applied jobs ----------

function parseAgo(meta: string[]): string | null {
  const line = meta.find((l) => /applied/i.test(l));
  const m = line?.match(/(\d+)\s*(m|h|d|w|mo|y)/i);
  if (!m) return line ? new Date().toISOString().slice(0, 10) : null;
  const n = Number(m[1]);
  const days = { m: 0, h: 0, d: n, w: n * 7, mo: n * 30, y: n * 365 }[m[2].toLowerCase() as "d"] ?? 0;
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

export async function syncLinkedIn() {
  const { saved, applied } = await syncLinkedInJobs();
  const stats = { saved: saved.length, applied: applied.length, newSaved: 0, newOpportunityIds: [] as number[] };
  const fromCard = (j: SavedJob) => ({ source: "linkedin_saved", source_url: j.url, linkedin_job_id: j.jobId });

  for (const j of saved) {
    const closed = j.meta.some((l) => /no longer accepting/i.test(l));
    const { opportunity, isNew } = addOpportunity(j.company, j.title, { ...fromCard(j), saved_on_linkedin: 1 }, closed ? "low" : "high");
    updateOpportunity(opportunity.id, { saved_on_linkedin: 1 });
    if (closed) updateOpportunity(opportunity.id, { status: "skipped", skip_reason: "LinkedIn says it's no longer accepting applications" });
    if (isNew && !closed) { stats.newSaved++; stats.newOpportunityIds.push(opportunity.id); }
  }
  for (const j of applied) {
    // Already applied: record it, no pack needed.
    const existing = findOpportunity(j.company, j.title, j.jobId);
    const opportunity = upsertOpportunity(j.company, j.title, { ...fromCard(j), status: "applied", date_applied: parseAgo(j.meta) ?? undefined });
    if (existing?.pack_status === "queued") updateOpportunity(opportunity.id, { pack_status: "none" });
  }
  kvSet("linkedin.lastSync", new Date().toISOString());
  reconcileActions();
  logEvent("linkedin.sync", null, stats);
  return stats;
}

// ---------- Manual add: a link from Telegram or the command line ----------

const Identified = z.object({
  company: z.string(),
  role: z.string(),
  is_job_posting: z.boolean(),
});

export async function addFromLink(url: string, note?: string): Promise<{ opportunity: Opportunity; isNew: boolean } | null> {
  const linkedinId = url.match(/linkedin\.com\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1] ?? url.match(/currentJobId=(\d+)/)?.[1] ?? null;

  // LinkedIn needs a login, so read those through my own browser session when it's free.
  let pageText: string | null = null;
  let closed = false;
  if (linkedinId) {
    try {
      const job = await readLinkedInJob(linkedinId);
      pageText = job.text;
      closed = job.closed;
    } catch (err) {
      logEvent("linkedin.read_failed", linkedinId, String(err));
    }
  }

  // Any other public page is read directly (free, seconds); web research is only for pages that won't load.
  if (!pageText && !linkedinId) {
    const page = await readPage(url).catch(() => null);
    if (page) pageText = `Page: ${page.url}\n${page.text}`;
  }

  const notes = pageText
    ? `Page text:\n${pageText.slice(0, 8000)}`
    : await llm.research("identify", {
        effort: "low",
        maxSearches: 3,
        system: "Identify the job posting at a link. Read the page if you can; search if the page needs a login.",
        prompt: `Link: ${url}${note ? `\nMy note: ${note}` : ""}\n\nWhich company and which role is this? Say if it isn't a job posting.`,
      });
  const id = await llm.structured("identify.parse", Identified, {
    effort: "low",
    system: "Extract the company name and the role title from the notes. is_job_posting is false if the notes don't describe a job opening.",
    prompt: `${notes}${note ? `\n\nMy note: ${note}` : ""}`,
  });
  if (!id.is_job_posting) return null;
  const result = addOpportunity(id.company, id.role, {
    source: "manual", source_url: url, linkedin_job_id: linkedinId,
    jd_text: [note && `My note: ${note}`, pageText].filter(Boolean).join("\n\n") || null,
  }, "high");
  if (closed) updateOpportunity(result.opportunity.id, { status: "skipped", skip_reason: "LinkedIn says it's no longer accepting applications", pack_status: "ready" });
  return { opportunity: findOpportunity(id.company, id.role, linkedinId)!, isNew: result.isNew };
}

export function lastSync(source: "gmail" | "linkedin"): string | undefined {
  return kvGet(`${source}.lastSync`);
}

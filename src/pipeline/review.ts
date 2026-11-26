import { z } from "zod";
import { all, logEvent, run } from "../db/index.ts";
import { getOpportunity, updateOpportunity } from "../db/opportunities.ts";
import { llm } from "../llm/client.ts";
import { reconcileActions } from "../loops/engine.ts";

/**
 * Re-reads a role's recent emails, across all its threads, and corrects its status. The screener
 * sees one message at a time; this sees the conversation, so "this role is in Singapore, we can't
 * relocate you" two messages after an interview invite still ends the application.
 */

const Review = z.object({
  stage: z.enum(["applied", "interviewing", "offer", "rejected", "closed", "unclear"]).describe(
    "Where the application stands after the latest message. closed: they said the role isn't open to me " +
      "(another country or region, visa block, filled, paused, not moving forward). unclear: the emails don't say.",
  ),
  reason: z.string().nullable().describe("For rejected or closed: why, in their words, under 15 words."),
  next_step: z.string().nullable().describe("One short sentence: the next thing I should do, if anything. Null if nothing."),
});

const SYSTEM = `You read the email history of one job application and say where it stands now. Go by the latest messages: a later message overrides an earlier one (an interview invite followed by "this role is Singapore-based, we can't relocate you" means closed). Use only what the emails say. If they're friendly but rule me out ("I'll reach out when roles open in India"), that is closed. If nothing new was said, use the stage the emails show (applied after a confirmation, interviewing after an invite), and unclear only when they don't show one.`;

export async function reviewStatus(opportunityId: number): Promise<{ from: string; to: string; reason: string | null } | null> {
  const o = getOpportunity(opportunityId);
  if (!o) return null;
  const msgs = all<{ sent_at: string; from_me: number; sender: string | null; subject: string | null; body: string | null }>(
    `SELECT m.sent_at, m.from_me, m.sender, t.subject, m.body FROM messages m JOIN threads t ON t.id = m.thread_id
     WHERE t.opportunity_id = $id ORDER BY m.sent_at DESC LIMIT 8`, { id: o.id },
  ).reverse();
  if (!msgs.length) return null;
  const history = msgs.map((m) => `<email date="${m.sent_at.slice(0, 10)}" from="${m.from_me ? "me" : (m.sender ?? "them").replace(/"/g, "'")}">\nSubject: ${m.subject ?? ""}\n${(m.body ?? "").replace(/\r/g, "").slice(0, 1500)}\n</email>`).join("\n\n");
  const r = await llm.structured(`status.review:${o.id}`, Review, {
    effort: "low", system: SYSTEM,
    prompt: `Role: ${o.role} at ${o.company}. The tracker says: ${o.status}.\n\n${history}`,
  });
  logEvent("status.review", o.id, r);
  const to = { applied: "applied", interviewing: "interviewing", offer: "offer", rejected: "rejected", closed: "rejected", unclear: o.status }[r.stage];
  if (to === o.status) return null;
  const ended = to === "rejected";
  const reason = r.reason?.trim() || (r.stage === "closed" ? "Role closed to me" : ended ? "They said no" : null);
  // Automation only moves a status forward; a review that reads an earlier stage changes nothing.
  updateOpportunity(o.id, { status: to, ...(ended ? { skip_reason: reason, next_step: r.next_step ?? `Closed: ${reason}` } : {}) });
  if (getOpportunity(o.id)!.status === o.status) return null;
  if (ended) run("UPDATE threads SET status = 'closed', closed_reason = $r WHERE opportunity_id = $id AND status = 'open'", { id: o.id, r: reason });
  reconcileActions();
  return { from: o.status, to, reason };
}

/** Every application still in flight, reviewed. Used once to correct old records, and after new mail. */
export async function reviewInFlight(ids?: number[]) {
  const rows = ids?.length
    ? ids.map((id) => getOpportunity(id)).filter((o) => o && ["applied", "interviewing"].includes(o.status)).map((o) => o!.id)
    : all<{ id: number }>("SELECT id FROM opportunities WHERE status IN ('applied', 'interviewing')").map((r) => r.id);
  const changed: { id: number; from: string; to: string; reason: string | null }[] = [];
  for (const id of rows) {
    const c = await reviewStatus(id).catch((err) => { logEvent("status.review_failed", id, String(err)); return null; });
    if (c) changed.push({ id, ...c });
  }
  return changed;
}

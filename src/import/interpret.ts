import { z } from "zod";
import { all, get, logEvent, run } from "../db/index.ts";
import { updateOpportunity } from "../db/opportunities.ts";
import { reconcileActions } from "../loops/engine.ts";
import { llm } from "../llm/client.ts";

/**
 * The tracker keeps real progress in free text ("Replied 17 Nov…", "call scheduled",
 * "Not cleared Technical Round 1 (24 Nov)…"). This reads that text once and turns it into
 * a status, an applied date and dated next actions, so the loop engine can track them.
 */

const Interpreted = z.object({
  roles: z.array(
    z.object({
      id: z.number().int(),
      status: z.enum(["decide", "ready", "applied", "interviewing", "offer", "rejected", "dropped"]),
      date_applied: z.string().nullable().describe("YYYY-MM-DD if the text says when I applied, else null."),
      actions: z.array(
        z.object({
          title: z.string().describe("Short imperative, e.g. 'Send the revenue note to Ashwin (Codemonk)'."),
          detail: z.string().nullable(),
          kind: z.enum(["reply", "follow_up", "apply", "decide", "custom"]),
          due_date: z.string().describe("YYYY-MM-DD. Use today if overdue or undated."),
          urgent: z.boolean(),
        }),
      ).describe("Only concrete to-dos the tracker can't see on its own: a reply owed, a call to prepare, a demo to build, a decision, an email or WhatsApp message drafted outside the outreach list, something to fill in. Empty if nothing like that."),
    }),
  ),
});

export async function interpretImported(today = new Date().toISOString().slice(0, 10)) {
  const rows = all<{ id: number; company: string; role: string; status: string; next_step: string | null; date_applied: string | null; people: string | null }>(
    `SELECT o.id, o.company, o.role, o.status, o.next_step, o.date_applied,
       (SELECT group_concat(c.name || ' [' || r.status || ']', '; ') FROM outreach r JOIN contacts c ON c.id = r.contact_id WHERE r.opportunity_id = o.id) AS people
     FROM opportunities o WHERE o.source = 'sheet_import' AND o.next_step IS NOT NULL`,
  );
  // Replace earlier readings so a rerun doesn't pile up duplicates. Actions I already closed stay closed.
  run("DELETE FROM actions WHERE rule_key LIKE 'import:%' AND status = 'open'");
  if (!rows.length) return { updated: 0, actions: 0 };
  const { roles } = await llm.structured("import.interpret", Interpreted, {
    effort: "medium",
    maxTokens: 32000,
    system:
      `Today is ${today}. You read a job-search tracker's notes and record where each application really stands. ` +
      "Use only what the notes say. 'Interviewing' means a call or round is scheduled or happened and I'm still in. " +
      "A failed round with a possible next conversation is still 'interviewing'. Keep the sheet's status unless the notes clearly say otherwise. " +
      "The tracker already reminds me to apply to every 'ready' role, to send each drafted LinkedIn note or DM to the people listed for that role, " +
      "to reply when one of them replies, and to follow up later. Don't create actions for any of those.",
    prompt: rows
      .map((r) => `id ${r.id}: ${r.role} at ${r.company}\nSheet status: ${r.status}\nPeople already tracked: ${r.people ?? "none"}\nNotes: ${r.next_step}`)
      .join("\n\n"),
  });

  let updated = 0, actions = 0;
  for (const r of roles) {
    const before = get<{ status: string }>("SELECT status FROM opportunities WHERE id = $id", { id: r.id });
    if (!before) continue;
    updateOpportunity(r.id, { status: r.status, date_applied: r.date_applied ?? undefined });
    if (get<{ status: string }>("SELECT status FROM opportunities WHERE id = $id", { id: r.id })!.status !== before.status) updated++;
    r.actions.forEach((a, i) => {
      const res = run(
        `INSERT INTO actions (rule_key, kind, title, detail, due_at, urgent, opportunity_id)
         VALUES ($k, $kind, $title, $detail, $due, $urgent, $opp) ON CONFLICT(rule_key) DO NOTHING`,
        {
          k: `import:${r.id}:${i}`, kind: a.kind, title: a.title, detail: a.detail,
          due: new Date(a.due_date + "T09:00:00+05:30").toISOString(), urgent: a.urgent ? 1 : 0, opp: r.id,
        },
      );
      actions += Number(res.changes);
    });
  }
  logEvent("import.interpreted", null, { updated, actions });
  reconcileActions();
  return { updated, actions };
}

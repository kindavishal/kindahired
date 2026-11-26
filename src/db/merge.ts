import { all, db, logEvent } from "./index.ts";
import { getOpportunity, sameCompany, sameRole, STATUS_RANK, type Opportunity } from "./opportunities.ts";

/** Pairs of roles that are the same role at the same company: [keep (older), duplicate]. */
export function findDuplicates(): [Opportunity, Opportunity][] {
  const opps = all<Opportunity>("SELECT * FROM opportunities ORDER BY id");
  const pairs: [Opportunity, Opportunity][] = [];
  const merged = new Set<number>();
  for (const dup of opps) {
    if (merged.has(dup.id)) continue;
    const keep = opps.find((o) => o.id < dup.id && !merged.has(o.id) && sameCompany(o.company, dup.company) && sameRole(o.role, dup.role));
    if (keep) { pairs.push([keep, dup]); merged.add(dup.id); }
  }
  return pairs;
}

/**
 * Folds a duplicate into the role I already track: its email threads, outreach and actions move
 * over, gaps are filled from it, the further-along status wins, and the duplicate is removed.
 */
export function mergeOpportunities(keepId: number, dupId: number) {
  const keep = getOpportunity(keepId)!, dup = getOpportunity(dupId)!;
  const d = db();
  d.exec("BEGIN");
  try {
    d.prepare("UPDATE threads SET opportunity_id = ? WHERE opportunity_id = ?").run(keepId, dupId);
    d.prepare("UPDATE actions SET opportunity_id = ? WHERE opportunity_id = ?").run(keepId, dupId);
    d.prepare("UPDATE inbox_items SET opportunity_id = ? WHERE opportunity_id = ?").run(keepId, dupId);
    // Outreach to someone already linked to the kept role is dropped, not doubled.
    d.prepare(`DELETE FROM outreach WHERE opportunity_id = ? AND contact_id IN (SELECT contact_id FROM outreach WHERE opportunity_id = ?)`).run(dupId, keepId);
    d.prepare("UPDATE outreach SET opportunity_id = ? WHERE opportunity_id = ?").run(keepId, dupId);
    const status = (STATUS_RANK[dup.status] ?? 0) > (STATUS_RANK[keep.status] ?? 0) && !["skipped"].includes(dup.status) ? dup.status : keep.status;
    d.prepare(`UPDATE opportunities SET status = ?, date_applied = coalesce(date_applied, ?), apply_url = coalesce(apply_url, ?),
      source_url = coalesce(source_url, ?), linkedin_job_id = coalesce(linkedin_job_id, ?) WHERE id = ?`)
      .run(status, dup.date_applied, dup.apply_url, dup.source_url, null, keepId);
    d.prepare("DELETE FROM sheet_rows WHERE entity = 'role' AND entity_id = ?").run(dupId);
    d.prepare("DELETE FROM opportunities WHERE id = ?").run(dupId);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  logEvent("opportunity.merged", keepId, { from: dupId, role: dup.role, status: keep.status === dup.status ? keep.status : undefined });
}

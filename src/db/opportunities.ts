import { all, get, logEvent, nowIso, run } from "./index.ts";

export interface Opportunity {
  id: number;
  dedupe_key: string;
  company: string;
  role: string;
  status: string;
  source: string | null;
  source_url: string | null;
  apply_url: string | null;
  who_can_apply: string | null;
  hard_gate: string | null;
  gate_result: string | null;
  skip_reason: string | null;
  fit_read: string | null;
  fit_verdict: string | null;
  pay: string | null;
  closes_on: string | null;
  cover_note: string | null;
  form_answers: string | null;
  company_brief: string | null;
  jd_text: string | null;
  next_step: string | null;
  date_applied: string | null;
  resume_path: string | null;
  resume_url: string | null;
  linkedin_job_id: string | null;
  saved_on_linkedin: number;
  pack_status: string;
  pack_error: string | null;
  pack_ready_at: string | null;
  user_locked: string;
  form_questions: string | null;
  visa: string | null;
  card_message_id: number | null;
  check_notes: string | null;
  posting_checked_at: string | null;
  posting_state: string | null;
  hiring_brief: string | null;
  hiring_brief_at: string | null;
  created_at: string;
  updated_at: string;
}

export type OpportunityFields = Partial<Omit<Opportunity, "id" | "dedupe_key" | "created_at" | "updated_at">>;

const WRITABLE = new Set<string>([
  "company", "role", "status", "source", "source_url", "apply_url", "who_can_apply", "hard_gate",
  "gate_result", "skip_reason", "fit_read", "fit_verdict", "pay", "closes_on", "cover_note",
  "form_answers", "company_brief", "jd_text", "next_step", "date_applied", "resume_path",
  "resume_url", "linkedin_job_id", "saved_on_linkedin", "pack_status", "pack_error", "pack_ready_at",
  "user_locked", "form_questions", "visa", "card_message_id", "check_notes",
  "posting_checked_at", "posting_state",
]);

/**
 * Workflow state, not my data: a tap that sets these must never lock them, or the pack worker
 * can't move a role past "approved" and keeps rebuilding it.
 */
const NEVER_LOCKED = new Set(["pack_status", "card_message_id", "pack_error", "pack_ready_at", "user_locked", "posting_checked_at", "posting_state"]);

/** Fields automation may set back to empty. */
const CLEARABLE = new Set(["pack_error", "check_notes", "card_message_id", "skip_reason"]);

/** Status order: automation may only move an opportunity forward, never back. */
export const STATUS_RANK: Record<string, number> = {
  found: 0, decide: 1, ready: 2, applied: 3, interviewing: 4, offer: 5, rejected: 5, dropped: 5, skipped: 5,
};

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|labs?|ai|technologies|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeKey(company: string, role: string): string {
  return `${normalise(company)}|${normalise(role)}`;
}

export function getOpportunity(id: number): Opportunity | undefined {
  return get<Opportunity>("SELECT * FROM opportunities WHERE id = $id", { id });
}

// Different ways people write the same role title.
const SYNONYMS: [RegExp, string][] = [
  [/\bdev ?rel\b/g, "developer relations"], [/\bsr\.?\b/g, "senior"], [/\bjr\.?\b/g, "junior"],
  [/\bmgr\b/g, "manager"], [/\beng\b/g, "engineer"], [/\bdx\b/g, "developer experience"],
  [/\bpm\b/g, "product manager"], [/\bapac\b/g, "apj"],
  // Advocacy and relations name the same DevRel job.
  [/\bdeveloper advoca(cy|tes?)\b/g, "developer relations"],
  // A bare "advocate" ("DevRel / Advocate") is the same job too.
  [/\badvoca(cy|tes?)\b/g, "relations"],
];
const ROLE_NOISE = new Set(["the", "a", "an", "and", "of", "for", "at", "in", "remote", "contract", "full", "time", "role", "team", "hire", "first"]);

/** Role title as a set of words, with synonyms and brackets folded in. */
export function roleTokens(role: string): Set<string> {
  let r = role.toLowerCase().replace(/[()[\],/&|–—-]+/g, " ");
  for (const [re, to] of SYNONYMS) r = r.replace(re, to);
  return new Set(r.split(/[^a-z0-9]+/).filter((w) => w && !ROLE_NOISE.has(w)));
}

/** True when two titles are the same role written differently. */
export function sameRole(a: string, b: string): boolean {
  const x = roleTokens(a), y = roleTokens(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  const smaller = Math.min(x.size, y.size);
  // Mostly the same words, or one title is a fuller version of the other.
  return shared / (x.size + y.size - shared) >= 0.6 || (smaller >= 2 && shared === smaller);
}

/** First word of the company name. Unnamed companies ("Unknown", "Confidential") match nothing. */
export function companyKey(company: string): string {
  const key = normalise(company).split(" ")[0] ?? "";
  return /^(unknown|confidential|undisclosed|stealth|na|n)$/.test(key) ? "" : key;
}

/**
 * Every name a company goes by in one field. A recruiter hiring for a client is often written
 * "Verifinity / Devrev" or "Verifinity (for DevRev)", and either name means the same role.
 */
export function companyKeys(company: string): string[] {
  // Only a bracket that names a client counts ("(for DevRev)"); "(shared by Jim)" or "(relocation: US)" don't.
  const inBrackets = [...company.matchAll(/\(\s*(?:for|via|client:?)\s+([^)]*)\)/gi)].map((m) => m[1]);
  const parts = [company.replace(/\(.*?\)/g, " "), ...inBrackets].flatMap((p) => p.split(/\s*(?:\/|\||\bvia\b)\s*/i));
  return [...new Set(parts.map((p) => companyKey(p.replace(/\.(ai|io|com|co|dev|app)\b/gi, ""))).filter(Boolean))];
}

/** True when two company fields name the same company (or a recruiter and its client). */
export function sameCompany(a: string, b: string): boolean {
  const x = companyKeys(a);
  return x.length > 0 && companyKeys(b).some((k) => x.includes(k));
}

/** Every role at this company, oldest first. */
export function opportunitiesAtCompany(company: string): Opportunity[] {
  if (!companyKeys(company).length) return [];
  return all<Opportunity>("SELECT * FROM opportunities ORDER BY id").filter((o) => sameCompany(o.company, company));
}

/** I've already acted on it (applied or further), so a "Build pack / Skip" choice no longer makes sense. */
export const PAST_DECISION = new Set(["applied", "interviewing", "offer", "rejected", "dropped"]);

export function findOpportunity(company: string, role: string, linkedinJobId?: string | null): Opportunity | undefined {
  if (linkedinJobId) {
    const byJob = get<Opportunity>("SELECT * FROM opportunities WHERE linkedin_job_id = $j", { j: linkedinJobId });
    if (byJob) return byJob;
  }
  return get<Opportunity>("SELECT * FROM opportunities WHERE dedupe_key = $k", { k: dedupeKey(company, role) })
    ?? opportunitiesAtCompany(company).find((o) => sameRole(o.role, role));
}

export function lockedFields(o: Pick<Opportunity, "user_locked">): Set<string> {
  try {
    return new Set((JSON.parse(o.user_locked) as string[]).filter((k) => !NEVER_LOCKED.has(k)));
  } catch {
    return new Set();
  }
}

/**
 * Insert or merge an opportunity. Existing values win over empty new ones, fields I locked
 * by hand are never overwritten, and status only moves forward unless `byUser` is set.
 */
export function upsertOpportunity(
  company: string,
  role: string,
  fields: OpportunityFields,
  opts: { byUser?: boolean } = {},
): Opportunity {
  const existing = findOpportunity(company, role, fields.linkedin_job_id);
  if (!existing) {
    const data: Record<string, unknown> = { ...fields, company, role };
    const cols = Object.keys(data).filter((k) => WRITABLE.has(k) && data[k] !== undefined);
    run(
      `INSERT INTO opportunities (dedupe_key, ${cols.join(", ")}) VALUES ($dedupe_key, ${cols.map((c) => "$" + c).join(", ")})`,
      Object.fromEntries([["dedupe_key", dedupeKey(company, role)], ...cols.map((c) => [c, data[c] as never])]),
    );
    const created = findOpportunity(company, role, fields.linkedin_job_id)!;
    logEvent("opportunity.created", created.id, { company, role, source: fields.source });
    return created;
  }
  updateOpportunity(existing.id, fields, opts);
  return getOpportunity(existing.id)!;
}

/**
 * When a role was last marked rejected (from the status log), or null. A later interview means
 * the process is open again.
 */
export function rejectedAt(id: number): string | null {
  const ev = get<{ at: string }>(
    "SELECT at FROM events WHERE kind = 'opportunity.status' AND ref = $ref AND detail LIKE '%\"to\":\"rejected\"%' ORDER BY at DESC LIMIT 1", { ref: String(id) });
  return ev?.at ?? (getOpportunity(id)?.status === "rejected" ? getOpportunity(id)!.updated_at : null);
}

/**
 * `reopen`: an interview or offer that arrived after a rejection may move the role back to
 * interviewing or offer (the only backward step automation may take).
 */
export function updateOpportunity(id: number, fields: OpportunityFields, opts: { byUser?: boolean; reopen?: boolean } = {}) {
  const current = getOpportunity(id);
  if (!current) throw new Error(`No opportunity ${id}`);
  const locked = lockedFields(current);
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!WRITABLE.has(key) || value === undefined) continue;
    if (!opts.byUser && locked.has(key)) continue;
    if (!opts.byUser && !CLEARABLE.has(key) && (value === null || value === "") && (current as never)[key]) continue;
    if (key === "status" && !opts.byUser) {
      const from = STATUS_RANK[current.status] ?? 0;
      const to = STATUS_RANK[value as string] ?? 0;
      const reopening = opts.reopen && current.status === "rejected" && (value === "interviewing" || value === "offer");
      if (to < from && !reopening) continue;
    }
    changes[key] = value;
  }
  if (opts.byUser) {
    for (const key of Object.keys(changes)) if (!NEVER_LOCKED.has(key)) locked.add(key);
    changes.user_locked = JSON.stringify([...locked]);
  }
  const keys = Object.keys(changes);
  if (keys.length === 0) return;
  run(
    `UPDATE opportunities SET ${keys.map((k) => `${k} = $${k}`).join(", ")}, updated_at = $now WHERE id = $id`,
    { ...(changes as Record<string, never>), now: nowIso(), id },
  );
  if (changes.status && changes.status !== current.status) {
    logEvent("opportunity.status", id, { from: current.status, to: changes.status, byUser: !!opts.byUser });
  }
}

export function listOpportunities(where = "1=1", params: Record<string, never> = {}): Opportunity[] {
  return all<Opportunity>(`SELECT * FROM opportunities WHERE ${where} ORDER BY updated_at DESC`, params);
}

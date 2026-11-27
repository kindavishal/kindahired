import type { DatabaseSync } from "node:sqlite";

/**
 * Early-access requests, kept in the router's database. The landing page's form adds one; the
 * operator approves or declines it from Telegram or /admin. Approving runs the steps in
 * provision.ts and records how each one went, so a step that failed can be tried again.
 */

export type RequestStatus = "pending" | "approved" | "declined";

export interface AccessRequest {
  id: number;
  email: string;
  linkedin: string;
  created_at: number;
  status: RequestStatus;
  decided_at: number | null;
  /** The person id given on approval. */
  person: string | null;
  /** JSON of the approval steps (see provision.ts). */
  steps: string | null;
  /** The Telegram message that announced it, so it can be updated. */
  telegram_message: number | null;
  /** 1 when it came from someone signed in, so the email is proven. */
  verified: number;
}

export function initRequests(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  linkedin TEXT NOT NULL,
  ip TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at INTEGER,
  person TEXT,
  steps TEXT,
  telegram_message INTEGER
);
CREATE INDEX IF NOT EXISTS access_requests_ip ON access_requests (ip, created_at);
`);
  const cols = (db.prepare("PRAGMA table_info(access_requests)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("verified")) db.exec("ALTER TABLE access_requests ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
}

/** Checks the form: an email address and a LinkedIn profile link. */
export function validateRequest(rawEmail: unknown, rawLinkedin: unknown): { email: string; linkedin: string } | { error: string } {
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter your email address." };
  let text = String(rawLinkedin ?? "").trim();
  if (!text) return { error: "Add your LinkedIn profile link." };
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { error: "That isn't a LinkedIn profile link." };
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname) || !/^\/in\/[^/]+/i.test(u.pathname)) return { error: "Use your profile link, like linkedin.com/in/your-name." };
  const slug = u.pathname.split("/")[2];
  return { email, linkedin: `https://www.linkedin.com/in/${slug}` };
}

/** At most this many new requests from one address an hour. */
export const PER_IP_PER_HOUR = 5;

/**
 * Adds a request. An email that already asked gets the existing request back (`created` false), so
 * asking twice is harmless and tells nobody whether an address was already there.
 */
export function addRequest(db: DatabaseSync, r: { email: string; linkedin: string; ip: string; verified?: boolean }, now = Date.now()): { request: AccessRequest; created: boolean } | { error: "rate" } {
  const existing = db.prepare("SELECT * FROM access_requests WHERE email = ?").get(r.email) as AccessRequest | undefined;
  if (existing) {
    if (r.verified && !existing.verified) db.prepare("UPDATE access_requests SET verified = 1 WHERE id = ?").run(existing.id);
    return { request: { ...existing, verified: r.verified ? 1 : existing.verified }, created: false };
  }
  const recent = db.prepare("SELECT count(*) AS n FROM access_requests WHERE ip = ? AND created_at > ?").get(r.ip, now - 3_600_000) as { n: number };
  if (recent.n >= PER_IP_PER_HOUR) return { error: "rate" };
  const request = db.prepare("INSERT INTO access_requests (email, linkedin, ip, created_at, verified) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .get(r.email, r.linkedin, r.ip, now, r.verified ? 1 : 0) as unknown as AccessRequest;
  return { request, created: true };
}

export const requestByEmail = (db: DatabaseSync, email: string) =>
  db.prepare("SELECT * FROM access_requests WHERE email = ?").get(email.trim().toLowerCase()) as AccessRequest | undefined;

export const getRequest = (db: DatabaseSync, id: number) =>
  db.prepare("SELECT * FROM access_requests WHERE id = ?").get(id) as AccessRequest | undefined;

/** Pending first (oldest first), then the decided ones (newest first). */
export const listRequests = (db: DatabaseSync, limit = 200) =>
  db.prepare(`SELECT * FROM access_requests ORDER BY status = 'pending' DESC,
    CASE WHEN status = 'pending' THEN created_at ELSE -coalesce(decided_at, created_at) END LIMIT ?`).all(limit) as unknown as AccessRequest[];

export function setTelegramMessage(db: DatabaseSync, id: number, messageId: number): void {
  db.prepare("UPDATE access_requests SET telegram_message = ? WHERE id = ?").run(messageId, id);
}

export function recordDecision(db: DatabaseSync, id: number, d: { status: RequestStatus; person?: string | null; steps?: unknown }, now = Date.now()): void {
  db.prepare("UPDATE access_requests SET status = ?, decided_at = ?, person = coalesce(?, person), steps = ? WHERE id = ?")
    .run(d.status, now, d.person ?? null, d.steps === undefined ? null : JSON.stringify(d.steps), id);
}

/** A person id from an email: its local part in [a-z0-9-], unique among `taken`. */
export function personIdFor(email: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "person";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

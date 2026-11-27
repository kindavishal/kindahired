import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * kindahired's own sign-in, run by the gateway: an email gets a 6-digit code, the code gets a
 * session cookie. Anyone can prove their email this way; whether they have a dashboard is decided
 * afterwards, against people.json. Only hashes are stored: codes keyed with the gateway secret,
 * sessions as plain SHA-256 of a 256-bit random token.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
/** New codes allowed per email and per address, in an hour. */
export const SENDS_PER_EMAIL = 5;
export const SENDS_PER_IP = 20;

export const SESSION_COOKIE = "__Host-kh_session";

export type CodeCheck = { ok: true } | { ok: false; reason: "wrong"; left: number } | { ok: false; reason: "expired" | "none" | "too-many" };

export interface SigninStore {
  /** A new code for this email (replacing any earlier one), or why not. */
  newCode(email: string, ip: string): { code: string } | { error: "email-limit" | "ip-limit" };
  checkCode(email: string, code: string): CodeCheck;
  /** A new session for this email: the cookie's value. */
  newSession(email: string): string;
  /** The email behind a session cookie, or null. Extends the session as it's used. */
  sessionEmail(token: string): string | null;
  endSession(token: string): void;
  close(): void;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function openSigninStore(file: string, secret: string, now: () => number = Date.now): SigninStore {
  if (!secret) throw new Error("The sign-in store needs the gateway secret.");
  const db = new DatabaseSync(file);
  // Only the hub's own user reads it (and its WAL files, which SQLite creates with the same mode).
  try { chmodSync(file, 0o600); } catch { /* an in-memory or test path */ }
  db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS signin_codes (email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS signin_sends (email TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS signin_sends_email ON signin_sends (email, at);
CREATE INDEX IF NOT EXISTS signin_sends_ip ON signin_sends (ip, at);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`);
  const codeHash = (email: string, code: string) => createHmac("sha256", secret).update(`${email}\n${code}`).digest("hex");
  const sweep = () => {
    const t = now();
    db.prepare("DELETE FROM signin_codes WHERE expires_at < ?").run(t);
    db.prepare("DELETE FROM signin_sends WHERE at < ?").run(t - 3_600_000);
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(t);
  };

  return {
    newCode(email, ip) {
      sweep();
      const t = now();
      const count = (col: "email" | "ip", v: string) =>
        (db.prepare(`SELECT count(*) AS n FROM signin_sends WHERE ${col} = ? AND at > ?`).get(v, t - 3_600_000) as { n: number }).n;
      if (count("email", email) >= SENDS_PER_EMAIL) return { error: "email-limit" };
      if (count("ip", ip) >= SENDS_PER_IP) return { error: "ip-limit" };
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      db.prepare("INSERT OR REPLACE INTO signin_codes (email, hash, expires_at, attempts) VALUES (?, ?, ?, 0)").run(email, codeHash(email, code), t + CODE_TTL_MS);
      db.prepare("INSERT INTO signin_sends (email, ip, at) VALUES (?, ?, ?)").run(email, ip, t);
      return { code };
    },
    checkCode(email, code) {
      const row = db.prepare("SELECT * FROM signin_codes WHERE email = ?").get(email) as { hash: string; expires_at: number; attempts: number } | undefined;
      if (!row) return { ok: false, reason: "none" };
      if (row.expires_at < now()) {
        db.prepare("DELETE FROM signin_codes WHERE email = ?").run(email);
        return { ok: false, reason: "expired" };
      }
      if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too-many" };
      if (same(row.hash, codeHash(email, code.replace(/\D/g, "")))) {
        db.prepare("DELETE FROM signin_codes WHERE email = ?").run(email);
        return { ok: true };
      }
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare("DELETE FROM signin_codes WHERE email = ?").run(email);
        return { ok: false, reason: "too-many" };
      }
      db.prepare("UPDATE signin_codes SET attempts = ? WHERE email = ?").run(attempts, email);
      return { ok: false, reason: "wrong", left: MAX_ATTEMPTS - attempts };
    },
    newSession(email) {
      const token = randomBytes(32).toString("base64url");
      const t = now();
      db.prepare("INSERT INTO sessions (hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha(token), email, t, t + SESSION_TTL_MS);
      return token;
    },
    sessionEmail(token) {
      if (!token || token.length > 100) return null;
      const t = now();
      const row = db.prepare("SELECT email, expires_at FROM sessions WHERE hash = ?").get(sha(token)) as { email: string; expires_at: number } | undefined;
      if (!row || row.expires_at < t) return null;
      // Sliding: a session in use stays alive, written at most once a day.
      if (row.expires_at - t < SESSION_TTL_MS - 86_400_000) db.prepare("UPDATE sessions SET expires_at = ? WHERE hash = ?").run(t + SESSION_TTL_MS, sha(token));
      return row.email;
    },
    endSession(token) {
      if (token) db.prepare("DELETE FROM sessions WHERE hash = ?").run(sha(token));
    },
    close: () => db.close(),
  };
}

/** The session cookie's value from a Cookie header. */
export function sessionToken(cookieHeader: string | undefined): string {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=");
  }
  return "";
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
export const clearedCookie = () => `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/** A path to return to after signing in: on this site only. */
export function safeNext(raw: unknown): string {
  const s = String(raw ?? "");
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") && !s.startsWith("/signin") ? s : "/";
}

export function validEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

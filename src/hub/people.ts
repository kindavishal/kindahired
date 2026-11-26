import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";

/**
 * The hub's people registry, `<JH_HUB_DIR>/people.json`. One entry per person: their engine port,
 * the secret their engine uses toward the Telegram router, their desktop worker's token, and the
 * Telegram chat they linked. Writes are atomic (a temp file, then a rename), so a reader never
 * sees half a file.
 */

export interface Person {
  /** [a-z0-9-], also the name of the person's data folder. */
  id: string;
  /** The Cloudflare Access identity. */
  email: string;
  /** That person's engine port. */
  port: number;
  /** The engine's "bot token" toward the router. */
  relaySecret: string;
  /** The desktop worker's bearer token. */
  workerToken: string;
  /** Set by the router when the person links Telegram. */
  chatId: number | null;
}

export const hubDir = () => process.env.JH_HUB_DIR || "/srv/jobhunt/hub";
export const peoplePath = (dir = hubDir()) => path.join(dir, "people.json");

export function loadPeople(dir = hubDir()): Person[] {
  const file = peoplePath(dir);
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf8")) as { people?: Person[] };
  return data.people ?? [];
}

export function savePeople(people: Person[], dir = hubDir()): void {
  mkdirSync(dir, { recursive: true });
  const file = peoplePath(dir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ people }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Compares secrets without leaking how much of them matched. */
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

export const findById = (id: string, dir = hubDir()) => loadPeople(dir).find((p) => p.id === id);
export const findByEmail = (email: string, dir = hubDir()) =>
  loadPeople(dir).find((p) => p.email.toLowerCase() === email.trim().toLowerCase());
export const findByRelaySecret = (secret: string, dir = hubDir()) => loadPeople(dir).find((p) => sameSecret(p.relaySecret, secret));
export const findByWorkerToken = (token: string, dir = hubDir()) => loadPeople(dir).find((p) => sameSecret(p.workerToken, token));
export const findByChatId = (chatId: number | string, dir = hubDir()) =>
  loadPeople(dir).find((p) => p.chatId !== null && String(p.chatId) === String(chatId));

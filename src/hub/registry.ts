import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Person {
  id: string;
  email: string;
  port: number;
  relaySecret: string;
  workerToken: string;
  chatId: number | string | null;
}

export const FIRST_PORT = 4401;

export function hubDir(): string {
  return process.env.JH_HUB_DIR || "/srv/jobhunt/hub";
}

export function peopleFile(dir = hubDir()): string {
  return path.join(dir, "people.json");
}

export function loadPeople(dir = hubDir()): Person[] {
  const file = peopleFile(dir);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { people?: Person[] };
  return Array.isArray(parsed.people) ? parsed.people : [];
}

/** Write to a temp file in the same folder, then rename, so readers never see a half-written file. */
export function savePeople(people: Person[], dir = hubDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = peopleFile(dir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ people }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const findById = (people: Person[], id: string) => people.find((p) => p.id === id);
export const findByEmail = (people: Person[], email: string) => {
  const e = email.trim().toLowerCase();
  return people.find((p) => p.email.trim().toLowerCase() === e);
};
export const findByWorkerToken = (people: Person[], token: string) => people.find((p) => p.workerToken === token);
export const findByRelaySecret = (people: Person[], secret: string) => people.find((p) => p.relaySecret === secret);

export const nextPort = (people: Person[]): number => {
  const used = new Set(people.map((p) => p.port));
  let port = FIRST_PORT;
  while (used.has(port)) port++;
  return port;
};

export const newSecret = (): string => randomBytes(32).toString("hex");

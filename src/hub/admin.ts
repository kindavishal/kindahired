import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hubDir, loadPeople, newSecret, nextPort, pick, savePeople, type Person } from "./people.ts";

export const peopleDir = () => process.env.JH_PEOPLE_DIR || "/srv/jobhunt/people";

const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "hub", "person.env.template");

export function renderEnv(vars: Record<string, string>): string {
  return fs.readFileSync(templatePath, "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

export function addPerson(id: string, email: string): string[] {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("id must be lowercase letters, digits and dashes");
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("that does not look like an email");
  const dir = hubDir();
  const people = loadPeople(dir);
  if (pick.id(people, id)) throw new Error(`${id} already exists`);
  if (pick.email(people, email)) throw new Error(`${email} already exists`);
  const person: Person = { id, email, port: nextPort(people), relaySecret: newSecret(), workerToken: newSecret(), chatId: null };
  const dataDir = path.join(peopleDir(), id);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const envFile = path.join(dataDir, ".env");
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, renderEnv({
      email, relaySecret: person.relaySecret, workerToken: person.workerToken, port: String(person.port),
      publicUrl: process.env.JH_PUBLIC_URL || "https://hub.example.com/",
    }), { mode: 0o600 });
  }
  savePeople([...people, person], dir);
  return [
    `Added ${id} (${email}) on port ${person.port}.`,
    `Data folder: ${dataDir}`,
    `Add their keys to ${envFile}, then start the engine:`,
    `  sudo systemctl enable --now jobhunt-engine@${id}`,
  ];
}

export function listPeople(): string[] {
  const people = loadPeople();
  if (!people.length) return ["No people yet."];
  return people.map((p) => `${p.id}\t${p.email}\t${p.port}\t${p.chatId ? "telegram linked" : "telegram not linked"}`);
}

/** The command table the hub CLI imports. Each command returns lines to print. */
export const adminCommands: Record<string, (args: string[]) => string[]> = {
  "add-person": ([id, email]) => {
    if (!id || !email) throw new Error("usage: add-person <id> <email>");
    return addPerson(id, email);
  },
  list: () => listPeople(),
};

import { addPerson } from "./admin.ts";
import { startPersonEngine } from "./mac.ts";
import { mailFrom, smtpSender, type SendMail } from "./mail.ts";
import { loadPeople } from "./people.ts";
import { personIdFor, type AccessRequest } from "./early-access.ts";

/**
 * What approving an early-access request does, step by step: an account on the hub, their engine
 * started, and a "you're in" email. Signing in is kindahired's own (the gateway's email codes), so
 * an account is all it takes to get in. Each step reports how it went; a step that already
 * happened counts as done, so approving again retries only what failed.
 */

export type StepName = "account" | "engine" | "email";
export interface Step { name: StepName; ok: boolean; detail: string }

export interface ProvisionDeps {
  addPerson: (id: string, email: string) => void;
  startEngine: (id: string) => string;
  sendInvite: (email: string) => Promise<string>;
  people: () => { id: string; email: string }[];
}

export const realDeps = (): ProvisionDeps => ({
  addPerson: (id, email) => { addPerson(id, email); },
  startEngine: (id) => {
    if (process.platform !== "darwin") throw new Error(`Start it with: sudo systemctl enable --now kindahired-engine@${id}`);
    return startPersonEngine(id);
  },
  sendInvite: (email) => sendInvite(email),
  people: () => loadPeople(),
});

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function provision(req: Pick<AccessRequest, "email" | "person">, deps: ProvisionDeps, previous: Step[] = []): Promise<{ person: string; steps: Step[] }> {
  const done = (name: StepName) => previous.some((s) => s.name === name && s.ok);
  const steps: Step[] = [];
  const people = deps.people();
  const existing = people.find((p) => p.email.toLowerCase() === req.email.toLowerCase());
  const person = existing?.id ?? req.person ?? personIdFor(req.email, people.map((p) => p.id));

  if (existing) steps.push({ name: "account", ok: true, detail: `Account ${person}` });
  else {
    try {
      deps.addPerson(person, req.email);
      steps.push({ name: "account", ok: true, detail: `Account ${person} created` });
    } catch (err) {
      steps.push({ name: "account", ok: false, detail: message(err) });
      return { person, steps };
    }
  }

  const run = async (name: StepName, fn: () => string | Promise<string>) => {
    if (done(name)) return steps.push(previous.find((s) => s.name === name)!);
    try {
      steps.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      steps.push({ name, ok: false, detail: message(err) });
    }
  };
  await run("engine", () => deps.startEngine(person));
  // The invite goes out only once their dashboard is running, so signing in works straight away.
  if (steps.find((s) => s.name === "engine")?.ok) await run("email", () => deps.sendInvite(req.email));
  else steps.push({ name: "email", ok: false, detail: "Not sent: their dashboard isn't running yet." });
  return { person, steps };
}

// ---------- The invite email ----------

export function inviteText(email: string, site: string): { subject: string; text: string; html: string } {
  const subject = "You're in: kindahired early access";
  const steps = [
    `Download the app for Mac, Windows or Linux: ${site}`,
    "Install Claude Code and sign in to your Claude account: https://claude.com/claude-code",
    `Open kindahired and sign in with ${email}. We'll email you a code.`,
  ];
  const text = `You're in.\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nReply to this email if anything gets in the way.\n\nkindahired`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const link = (s: string) => esc(s).replace(/(https:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
  const html = `<p>You're in.</p><ol>${steps.map((s) => `<li>${link(s)}</li>`).join("")}</ol><p>Reply to this email if anything gets in the way.</p><p>kindahired</p>`;
  return { subject, text, html };
}

export async function sendInvite(email: string, env: NodeJS.ProcessEnv = process.env, send: SendMail = smtpSender(env)): Promise<string> {
  const site = env.LANDING_URL || "https://kindahired.kindavishal.dev";
  await send({ to: email, ...inviteText(email, site) });
  return `Invite sent from ${mailFrom(env).replace(/^.*<|>$/g, "")}`;
}

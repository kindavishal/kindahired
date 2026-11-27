import nodemailer from "nodemailer";
import { addPerson } from "./admin.ts";
import { startPersonEngine } from "./mac.ts";
import { loadPeople } from "./people.ts";
import { personIdFor, type AccessRequest } from "./early-access.ts";

/**
 * What approving an early-access request does, step by step: an account on the hub, their engine
 * started, their email added to the Cloudflare Access sign-in list, and a "you're in" email. Each
 * step reports how it went; a step that already happened counts as done, so approving again
 * retries only what failed.
 */

export type StepName = "account" | "engine" | "sign-in" | "email";
export interface Step { name: StepName; ok: boolean; detail: string }

export interface ProvisionDeps {
  addPerson: (id: string, email: string) => void;
  startEngine: (id: string) => string;
  allowEmail: (email: string) => Promise<string>;
  sendInvite: (email: string) => Promise<string>;
  people: () => { id: string; email: string }[];
}

export const realDeps = (): ProvisionDeps => ({
  addPerson: (id, email) => { addPerson(id, email); },
  startEngine: (id) => {
    if (process.platform !== "darwin") throw new Error(`Start it with: sudo systemctl enable --now kindahired-engine@${id}`);
    return startPersonEngine(id);
  },
  allowEmail: (email) => allowEmail(email),
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
  await run("sign-in", () => deps.allowEmail(req.email));
  // The invite goes out only once they can actually sign in.
  if (steps.find((s) => s.name === "sign-in")?.ok) await run("email", () => deps.sendInvite(req.email));
  else steps.push({ name: "email", ok: false, detail: "Not sent: they can't sign in yet." });
  return { person, steps };
}

// ---------- Cloudflare Access: the sign-in list ----------

type Rule = Record<string, unknown>;
interface Policy { name: string; decision: string; include: Rule[]; exclude?: Rule[]; require?: Rule[]; [k: string]: unknown }

/** The fields a policy update sends back; everything else in the GET answer is read-only. */
const WRITABLE = ["name", "decision", "include", "exclude", "require", "session_duration", "approval_required", "approval_groups",
  "isolation_required", "purpose_justification_required", "purpose_justification_prompt"] as const;

/**
 * Adds an email to the Access policy that lets people sign in to the dashboard. Needs CF_API_TOKEN
 * (Access: Apps and Policies, Edit), CF_ACCOUNT_ID and CF_ACCESS_POLICY_ID; with CF_ACCESS_APP_ID
 * set too, the policy is the app's own rather than a reusable one.
 */
export async function allowEmail(email: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { CF_API_TOKEN: token, CF_ACCOUNT_ID: account, CF_ACCESS_POLICY_ID: policy, CF_ACCESS_APP_ID: app } = env;
  if (!token || !account || !policy) throw new Error("Cloudflare isn't set up: add CF_API_TOKEN, CF_ACCOUNT_ID and CF_ACCESS_POLICY_ID to hub.env.");
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/access/${app ? `apps/${app}/` : ""}policies/${policy}`;
  const call = async (init: RequestInit = {}) => {
    const res = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { success?: boolean; result?: Policy; errors?: { message?: string }[] } | null;
    if (!res.ok || !body?.success || !body.result) throw new Error(`Cloudflare answered ${res.status}: ${body?.errors?.map((e) => e.message).join("; ") || "no details"}`);
    return body.result;
  };
  const current = await call();
  const has = current.include.some((r) => String((r.email as { email?: string } | undefined)?.email ?? "").toLowerCase() === email.toLowerCase());
  if (has) return "Already on the sign-in list";
  const update: Record<string, unknown> = {};
  for (const k of WRITABLE) if (current[k] !== undefined) update[k] = current[k];
  update.include = [...current.include, { email: { email } }];
  await call({ method: "PUT", body: JSON.stringify(update) });
  return "Added to the sign-in list";
}

// ---------- The invite email ----------

export function inviteText(email: string, site: string): { subject: string; text: string; html: string } {
  const subject = "You're in: kindahired early access";
  const steps = [
    `Download the app for Mac or Linux: ${site}`,
    "Install Claude Code and sign in to your Claude account: https://claude.com/claude-code",
    `Open kindahired and sign in with ${email}.`,
  ];
  const text = `You're in.\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nReply to this email if anything gets in the way.\n\nkindahired`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const link = (s: string) => esc(s).replace(/(https:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
  const html = `<p>You're in.</p><ol>${steps.map((s) => `<li>${link(s)}</li>`).join("")}</ol><p>Reply to this email if anything gets in the way.</p><p>kindahired</p>`;
  return { subject, text, html };
}

/**
 * Sends the "you're in" email over SMTP: by default Gmail's server with SMTP_USER (the Gmail address)
 * and SMTP_PASS (an app password), from INVITE_FROM, an alias set up in that Gmail account.
 */
export async function sendInvite(email: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { SMTP_USER: user, SMTP_PASS: pass } = env;
  if (!user || !pass) throw new Error("Email isn't set up: add SMTP_USER and SMTP_PASS to hub.env.");
  const from = env.INVITE_FROM || "kindahired <hired@kindavishal.dev>";
  const site = env.LANDING_URL || "https://kindahired.kindavishal.dev";
  const transport = nodemailer.createTransport({ host: env.SMTP_HOST || "smtp.gmail.com", port: Number(env.SMTP_PORT || 587), secure: false, requireTLS: true, auth: { user, pass } });
  const msg = inviteText(email, site);
  await transport.sendMail({ from, to: email, replyTo: from, ...msg });
  return `Invite sent from ${from.replace(/^.*<|>$/g, "")}`;
}

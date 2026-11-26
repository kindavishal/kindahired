/**
 * The direct action behind each task: the button does the work (opens the application, copies a
 * note and opens LinkedIn, opens the email thread) instead of asking to be marked done. Tasks
 * close on their own when the sync sees the result: an application confirmation email, a sent
 * reply in Gmail, a DM in the LinkedIn inbox. Opening a task is logged so Home can set it aside
 * while it waits for that signal.
 */

import { all, get, logEvent, run } from "../db/index.ts";
import type { ActionRow } from "../loops/engine.ts";

export type Direct = {
  label: string;
  href: string;
  /** Opens another site in a new tab. */
  external: boolean;
  /** Text copied to the clipboard on click (a drafted note). */
  copy?: string;
  /** Shown under the button: what happens next. */
  note?: string;
  /** Opening it counts as doing it (a LinkedIn note: LinkedIn shows nothing until they accept). */
  countsOnOpen?: boolean;
};

type Opp = { id: number; apply_url: string | null; status: string };
type Person = { id: number; name: string; linkedin_url: string | null; email: string | null };
type Out = Person & { outreach_id: number; connection_note: string | null; full_dm: string | null; status: string };
type Thread = { id: number; channel: string; external_id: string | null; subject: string | null };
type Meeting = { id: number; event_id: string; join_url: string | null; start_at: string };

const inList = (xs: (number | string)[]) => xs.map((x) => (typeof x === "number" ? x : `'${String(x).replace(/'/g, "''")}'`)).join(",");
const first = (s: string) => s.split(" ")[0];

/** Everything needed to work out the direct action for a batch of tasks, in a few queries. */
function loadTargets(actions: ActionRow[]) {
  const oppIds = [...new Set(actions.map((a) => a.opportunity_id).filter((x): x is number => !!x))];
  const outIds = [...new Set(actions.map((a) => a.outreach_id).filter((x): x is number => !!x))];
  const threadIds = [...new Set(actions.map((a) => a.thread_id).filter((x): x is number => !!x))];
  const contactIds = new Set<number>();
  const eventIds = new Set<string>();
  for (const a of actions) {
    const p = a.rule_key?.split(":") ?? [];
    if (p[1] === "touch") contactIds.add(Number(p[2]));
    if (p[1] === "close" || p[1] === "reengage") contactIds.add(Number(p[3]));
    if (p[1] === "prep") eventIds.add(p.slice(2).join(":"));
  }
  const opps = new Map(oppIds.length ? all<Opp>(`SELECT id, apply_url, status FROM opportunities WHERE id IN (${inList(oppIds)})`).map((o) => [o.id, o]) : []);
  const outs = new Map(outIds.length ? all<Out>(
    `SELECT r.id outreach_id, r.connection_note, r.full_dm, r.status, c.id, c.name, c.linkedin_url, c.email
     FROM outreach r JOIN contacts c ON c.id = r.contact_id WHERE r.id IN (${inList(outIds)})`).map((o) => [o.outreach_id, o]) : []);
  const threads = new Map(threadIds.length ? all<Thread>(`SELECT id, channel, external_id, subject FROM threads WHERE id IN (${inList(threadIds)})`).map((t) => [t.id, t]) : []);
  const people = new Map(contactIds.size ? all<Person>(`SELECT id, name, linkedin_url, email FROM contacts WHERE id IN (${inList([...contactIds])})`).map((c) => [c.id, c]) : []);
  const meetings = new Map(eventIds.size ? all<Meeting>(`SELECT id, event_id, join_url, start_at FROM meetings WHERE event_id IN (${inList([...eventIds])})`).map((m) => [m.event_id, m]) : []);
  return { opps, outs, threads, people, meetings };
}

const threadLink = (t: Thread) =>
  t.channel === "linkedin" && t.external_id ? `https://www.linkedin.com/messaging/thread/${encodeURIComponent(t.external_id)}/`
  : t.external_id ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(t.external_id)}` : null;

const mailto = (to: string, body?: string, subject?: string) =>
  `mailto:${encodeURIComponent(to)}?${new URLSearchParams({ ...(subject ? { subject } : {}), ...(body ? { body } : {}) }).toString().replace(/\+/g, "%20")}`;

/** The note drafted inside a task's detail: the text after its first blank line. */
const draftIn = (detail: string | null) => {
  const i = detail?.indexOf("\n\n") ?? -1;
  return i >= 0 ? detail!.slice(i + 2).trim() : undefined;
};

function reachPerson(p: Person, verb: string, copy?: string, subject?: string): Direct | null {
  if (p.linkedin_url) return copy
    ? { label: "Copy note, open LinkedIn", href: p.linkedin_url, external: true, copy, countsOnOpen: true,
        note: "This copies your note and opens their profile. Paste it and send. It counts as sent, and you will see when they accept." }
    : { label: `${verb} on LinkedIn`, href: p.linkedin_url, external: true };
  if (p.email) return { label: copy ? "Write the email" : `Email ${first(p.name)}`, href: mailto(p.email, copy, subject), external: true, note: copy ? "Opens your mail app with the draft filled in." : undefined };
  return null;
}

/** The one button that does the task. */
export function directActions(actions: ActionRow[]): Map<number, Direct> {
  const t = loadTargets(actions);
  const out = new Map<number, Direct>();
  for (const a of actions) {
    const key = a.rule_key ?? "";
    const p = key.split(":");
    const opp = a.opportunity_id ? t.opps.get(a.opportunity_id) : undefined;
    const role = a.opportunity_id ? `/o/${a.opportunity_id}` : null;
    const pack: Direct | null = role ? { label: "Open the pack", href: role, external: false } : null;
    let d: Direct | null = null;

    if (a.kind === "apply" || a.kind === "deadline") {
      d = opp?.apply_url ? { label: "Apply", href: opp.apply_url, external: true, note: "Your resume and cover note are in the pack. This clears when the confirmation email arrives." } : pack;
    } else if (a.kind === "decide") {
      d = role ? { label: key.startsWith("loop:offer:") ? "Read the offer" : "Review the role", href: role, external: false } : null;
    } else if (a.kind === "interview") {
      const m = t.meetings.get(p.slice(2).join(":"));
      const soon = m?.join_url && Math.abs(new Date(m.start_at).getTime() - Date.now()) < 90 * 60_000;
      d = soon ? { label: "Join the call", href: m!.join_url!, external: true } : m ? { label: "Open interview prep", href: `/interviews/${m.id}`, external: false } : role ? { label: "Prepare", href: role, external: false } : null;
    } else if (a.thread_id && t.threads.get(a.thread_id)) {
      const th = t.threads.get(a.thread_id)!;
      const href = threadLink(th);
      if (href) d = { label: th.channel === "linkedin" ? "Open on LinkedIn" : "Open the email", href, external: true, note: "This clears when your reply is seen." };
    } else if (a.outreach_id && t.outs.get(a.outreach_id)) {
      const o = t.outs.get(a.outreach_id)!;
      if (a.kind === "send_note" || a.kind === "send_dm") d = reachPerson(o, "Write", o.connection_note ?? o.full_dm ?? undefined);
      else d = reachPerson(o, a.kind === "reply" ? "Reply" : "Message");
    } else if (p[1] === "touch" || p[1] === "close" || p[1] === "reengage") {
      const person = t.people.get(Number(p[1] === "touch" ? p[2] : p[3]));
      if (person) d = reachPerson(person, p[1] === "touch" ? "Say hello" : "Write", p[1] === "close" ? draftIn(a.detail) : undefined);
    } else if (key.startsWith("loop:firsttouch:") || key.startsWith("loop:ladder:") || key.startsWith("web:followup:")) {
      d = role ? { label: "See who to contact", href: `${role}#people`, external: false } : null;
    }
    out.set(a.id, d ?? pack ?? { label: "Open", href: "/tasks", external: false });
  }
  return out;
}

/** Tasks opened from the dashboard, with when. Recent ones wait on Home for their signal. */
export function openedTasks(): Map<number, string> {
  return new Map(all<{ ref: string; at: string }>(
    "SELECT ref, max(at) at FROM events WHERE kind = 'action.opened' GROUP BY ref",
  ).map((r) => [Number(r.ref), r.at]));
}
export const markOpened = (id: number) => logEvent("action.opened", id);
export const clearOpened = (id: number) => run("DELETE FROM events WHERE kind = 'action.opened' AND ref = $id", { id: String(id) });
export const isTask = (id: number) => !!get<{ id: number }>("SELECT id FROM actions WHERE id = $id", { id });

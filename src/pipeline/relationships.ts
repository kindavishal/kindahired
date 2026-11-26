import { all, get, nowIso, run } from "../db/index.ts";

/**
 * People outlast roles. A relationship is anyone I've had a real exchange with about work: they
 * replied to me, we talked over email or LinkedIn, or we met on a call. Its warmth comes from
 * that history, and it carries from one role to the next at the same company.
 *
 *   close  we met (an interview or call), or wrote back and forth several times
 *   warm   we've each written at least once
 *   cold   one-way: I reached out with no answer, or they wrote and I never replied
 *
 * Plain code over the data already stored: threads and messages on any channel, outreach,
 * calendar meetings, and touches I mark done.
 */

export type Warmth = "close" | "warm" | "cold";

export interface RoleLink { id: number; company: string; role: string; status: string; skip_reason: string | null }

export interface Relationship {
  contact_id: number;
  name: string;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  company: string | null;        // where they work, from the roles we share
  warmth: Warmth;
  exchanges: number;             // messages either way
  met: boolean;                  // shared a calendar meeting
  last_touch_at: string | null;  // last contact either way
  last_from: "me" | "them" | null;
  last_channel: string | null;
  roles: RoleLink[];
  stay_in_touch: number | null;  // my choice: 1 keep reminding, 0 never, null automatic
  automated: boolean;            // a no-reply or team inbox: never written to as a person
}

// A shared inbox with a person's name on it (hr@, careers@) is still that person; only machine
// addresses and generic names ("Onboarding", "Recruiting Ops Team") aren't written to as people.
const MACHINE_EMAIL = /(no-?reply|noreply|notifications?@|calendar|mailer-daemon|recruitingops)/i;
const GENERIC_NAME = /^(onboarding|support|team|hr|careers|recruiting|talent|hiring|people ops)\b|\bteam$/i;

interface Touch { contact_id: number; at: string; from_me: number; channel: string | null }

/** Every relationship, warmest and most recent first. */
export function loadRelationships(): Relationship[] {
  const contacts = all<{ id: number; name: string; title: string | null; email: string | null; linkedin_url: string | null; stay_in_touch: number | null }>(
    "SELECT id, name, title, email, linkedin_url, stay_in_touch FROM contacts",
  );
  const touches = all<Touch>(
    `SELECT t.contact_id, m.sent_at AS at, m.from_me, t.channel FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.contact_id IS NOT NULL
     UNION ALL SELECT t.contact_id, t.last_message_at, t.last_from = 'me', t.channel FROM threads t
       WHERE t.contact_id IS NOT NULL AND t.last_message_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)
     UNION ALL SELECT contact_id, sent_at, 1, 'linkedin' FROM outreach WHERE sent_at IS NOT NULL
     UNION ALL SELECT contact_id, replied_at, 0, 'linkedin' FROM outreach WHERE replied_at IS NOT NULL
     UNION ALL SELECT CAST(ref AS INTEGER), at, 1, coalesce(json_extract(detail, '$.channel'), 'note') FROM events WHERE kind = 'relationship.touch' AND ref IS NOT NULL`,
  );
  const meetings = all<{ attendees: string | null; start_at: string; status: string }>(
    "SELECT attendees, start_at, status FROM meetings WHERE status != 'cancelled' AND start_at <= $now", { now: nowIso() },
  );
  const roles = all<RoleLink & { contact_id: number }>(
    `SELECT DISTINCT x.contact_id, o.id, o.company, o.role, o.status, o.skip_reason FROM (
       SELECT contact_id, opportunity_id FROM threads WHERE contact_id IS NOT NULL AND opportunity_id IS NOT NULL
       UNION SELECT contact_id, opportunity_id FROM outreach WHERE opportunity_id IS NOT NULL) x
     JOIN opportunities o ON o.id = x.opportunity_id`,
  );

  const out: Relationship[] = [];
  for (const c of contacts) {
    const mine = touches.filter((t) => t.contact_id === c.id && t.at);
    const met = !!c.email && meetings.some((m) => (m.attendees ?? "").toLowerCase().includes(c.email!.toLowerCase()));
    const fromThem = mine.filter((t) => !t.from_me).length;
    const fromMe = mine.length - fromThem;
    const exchanges = mine.length;
    const warmth: Warmth = met || (fromThem >= 2 && fromMe >= 2) ? "close" : fromThem >= 1 && fromMe >= 1 ? "warm" : "cold";
    const last = [...mine].sort((a, b) => b.at.localeCompare(a.at))[0];
    const shared = roles.filter((r) => r.contact_id === c.id).map(({ contact_id: _, ...r }) => r);
    out.push({
      contact_id: c.id, name: c.name, title: c.title, email: c.email, linkedin_url: c.linkedin_url,
      company: shared[0]?.company.replace(/\s*\(.*$/, "") ?? null,
      warmth, exchanges, met,
      last_touch_at: last?.at ?? null, last_from: last ? (last.from_me ? "me" : "them") : null, last_channel: last?.channel ?? null,
      roles: shared, stay_in_touch: c.stay_in_touch, automated: MACHINE_EMAIL.test(c.email ?? "") || GENERIC_NAME.test(c.name.trim()),
    });
  }
  const rank = { close: 0, warm: 1, cold: 2 };
  return out.sort((a, b) => rank[a.warmth] - rank[b.warmth] || (b.last_touch_at ?? "").localeCompare(a.last_touch_at ?? ""));
}

/**
 * When a role ended: their last message on it (a no usually arrives as one), else the move to
 * rejected or dropped. Imports set statuses long after the fact, so a message is the better clock.
 */
export function endedAt(opportunityId: number): string | null {
  const theirs = get<{ at: string | null }>(
    `SELECT max(at) AS at FROM (
       SELECT m.sent_at AS at FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.opportunity_id = $id AND m.from_me = 0
       UNION ALL SELECT last_message_at FROM threads WHERE opportunity_id = $id AND last_from = 'them')`, { id: opportunityId },
  )?.at;
  if (theirs) return theirs;
  return get<{ at: string | null }>(
    "SELECT max(at) AS at FROM events WHERE kind = 'opportunity.status' AND ref = $ref AND json_extract(detail, '$.to') IN ('rejected', 'dropped')",
    { ref: String(opportunityId) },
  )?.at ?? null;
}

const first = (name: string) => name.trim().split(/\s+/)[0];

/**
 * A short closing note in my voice, for the way the role ended. It thanks them, keeps the door
 * open, and never asks for anything big.
 */
export function closureNote(kind: "rejected" | "withdrew" | "quiet", r: { name: string }, role: { role: string; company: string; skip_reason?: string | null }, opts: { met: boolean; me: string }): string {
  const company = role.company.replace(/\s*\(.*$/, "");
  const hi = `Hi ${first(r.name)},`;
  const body = kind === "rejected"
    ? [
      `Thanks for letting me know about the ${role.role} role${role.skip_reason && !/low match|first screen/i.test(role.skip_reason) ? `, and for being clear about why` : ""}. ${opts.met ? "I enjoyed our conversation and learned a lot about how the team works." : "I appreciate the time you spent on my application."}`,
      `I'd still love to work with ${company} at some point. If something opens up that fits, I'd be glad to hear about it, and I'll keep following what you're building.`,
    ]
    : kind === "withdrew"
      ? [
        `Thank you for your time on the ${role.role} role. I've decided to step back from this one, and I wanted to tell you directly rather than go quiet.`,
        `I've enjoyed learning about ${company}, and I'd be glad to stay in touch.`,
      ]
      : [
        `I wanted to close the loop on the ${role.role} role. I'm guessing you've gone ahead with someone else, and that's completely fine.`,
        `Thanks for the time you spent on my application. If something opens up later that fits, I'd be glad to talk again.`,
      ];
  return [hi, "", ...body.flatMap((p) => [p, ""]), opts.me].join("\n");
}

/** A light stay-in-touch idea, from what's known about them and their company. */
export function touchIdea(r: Relationship, openRoles: string[]): string {
  const company = r.company ?? "their company";
  return [
    openRoles.length ? `${company} has ${openRoles.length === 1 ? "a role" : `${openRoles.length} roles`} open that fit you (${openRoles.slice(0, 2).join(", ")}): a natural reason to write.` : null,
    `Ideas: react to or comment on a recent post of theirs, share something you built or wrote that touches ${company}'s work, or a two-line update on what you're doing now. Nothing that asks for anything.`,
  ].filter(Boolean).join("\n");
}

/** Whether the tool should keep reminding me to stay in touch with this person. */
export function keepsInTouch(r: Relationship): boolean {
  if (r.automated || r.stay_in_touch === 0) return false;
  return r.stay_in_touch === 1 || r.warmth !== "cold";
}

export function setStayInTouch(contactId: number, value: 0 | 1 | null) {
  run("UPDATE contacts SET stay_in_touch = $v WHERE id = $id", { v: value, id: contactId });
}

/** I was in touch with them some other way (a call, a coffee, a comment): the clock restarts. */
export function logTouch(contactId: number, channel = "note", at = nowIso()) {
  run("INSERT INTO events (at, kind, ref, detail) VALUES ($at, 'relationship.touch', $ref, $d)", { at, ref: String(contactId), d: JSON.stringify({ channel }) });
}

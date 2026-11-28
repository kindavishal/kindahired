import { all, get, logEvent, nowIso, run } from "../db/index.ts";
import { DEFAULT_TIMERS, getTimers, type Timers } from "./timers.ts";
import { bestContact, getBrief } from "../pipeline/hiring-brief.ts";
import { closureNote, endedAt, keepsInTouch, loadRelationships, touchIdea, type Relationship } from "../pipeline/relationships.ts";
import { sameCompany } from "../db/opportunities.ts";
import { loadProfile, TIMEZONE } from "../config.ts";

/**
 * The open-loop engine. Plain code, no AI: given the current state, every loose end becomes
 * exactly one action with a due time. It runs after every sync, so actions appear and resolve
 * on their own as things change.
 *
 * The lifecycle it enforces, so no role is ever left without a next step:
 *   found, screened in    → the pack is being built; nothing to do yet
 *   found, not screened   → decide: build the pack or drop it (skipped after `parkedDays`)
 *   decide                → decide
 *   ready                 → apply (flagged stale after `packStaleHours`)
 *   applied               → reach a person within `firstTouchHours`, then the follow-up ladder:
 *                           follow up after `followUp1Days` of quiet, again on another channel
 *                           `followUp2Days` later, then close warmly `closeAfterDays` after that
 *   interviewing          → the same ladder, starting after `interviewFollowUpDays`
 *   interview booked      → prepare the day before; the ladder waits until it's over
 *   interview over        → send a thank-you within a few hours; the ladder restarts from it
 *   interview cancelled   → rebook it
 *   offer                 → respond to the offer
 *   rejected, dropped, skipped → nothing
 * Anything from their side (an email, a reply to a DM, a status change) restarts the ladder.
 * Roles in play that still end up with no open action are listed by `stalledRoles`.
 */

export interface DesiredAction {
  rule_key: string;
  kind: string;
  title: string;
  detail: string | null;
  due_at: string;
  urgent: boolean;
  opportunity_id: number | null;
  thread_id: number | null;
  outreach_id: number | null;
}

interface OppRow {
  id: number; company: string; role: string; status: string; pack_status: string; pack_ready_at: string | null;
  pack_error?: string | null; posting_state?: string | null; posting_checked_at?: string | null; hiring_brief?: string | null;
  closes_on: string | null; date_applied: string | null; next_step: string | null; hard_gate: string | null;
  apply_url: string | null; created_at: string; updated_at: string;
}
interface OutreachRow {
  id: number; opportunity_id: number | null; status: string; sent_at: string | null; replied_at: string | null; accepted_at?: string | null;
  reply: string | null; created_at: string; why_them: string | null; send_time: string | null;
  name: string; company: string | null; opp_status: string | null;
}
interface ThreadRow {
  id: number; opportunity_id: number | null; subject: string | null; kind: string | null; last_message_at: string | null;
  last_from: string | null; last_snippet: string | null; needs_reply: number; who: string | null;
  channel?: string | null; opp_status?: string | null;
}

/** The newest message on any of a role's threads (conversations and ATS updates alike). */
interface LatestMail {
  opportunity_id: number; last_message_at: string; last_from: string | null; subject: string | null;
  last_snippet: string | null; who: string | null; kind: string | null; channel?: string | null;
}

/** One message on a role's threads, on any channel. */
interface Touch { opportunity_id: number; at: string; from_me: number; channel: string | null; thread_id?: number }
/** A timestamped event on a role: a follow-up I marked sent (`first` for a first touch), or a status change. */
interface OppEvent { opportunity_id: number; at: string; first?: number }

/** An interview or call on my calendar, matched to a role. */
interface Meeting { event_id: string; opportunity_id: number; title: string; start_at: string; end_at: string; status: string; join_url: string | null; link: string | null; attendees: string | null; updated_at: string }

/** Confirmations and calendar invites: they move the date, but nobody is waiting on my answer. */
const automated = (m: LatestMail) =>
  m.kind === "application_update" || /^(updated )?invitation\b|^invitation from|^accepted:|^declined:/i.test(m.subject ?? "");

export interface LoopState {
  opportunities: OppRow[];
  outreach: OutreachRow[];
  threads: ThreadRow[];
  latestMail?: LatestMail[];
  touches?: Touch[];
  followUps?: OppEvent[];
  statusChanges?: OppEvent[];
  meetings?: Meeting[];
  relationships?: Relationship[];
  /** When each ended role ended (rejected or dropped). */
  ended?: Record<number, string>;
  me?: string;
}

/** Applications in flight: the follow-up ladder owns them, instead of scattered thread nudges. */
const IN_FLIGHT = new Set(["applied", "interviewing"]);
/** Packs still being worked on: the role waits for the worker, not for me. */
const PROCESSING = new Set(["queued", "summarizing", "building", "approved", "held"]);
const fmtDay = (iso: string) => new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const oneLine = (t: string | null, max = 160) => {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
};

const CLOSED = new Set(["dropped", "skipped", "rejected", "offer"]);
const ENDED = new Set(["dropped", "skipped", "rejected"]);
const H = 3600_000;
const D = 24 * H;

const addHours = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * H).toISOString();
const daysBetween = (a: string, b: Date) => (b.getTime() - new Date(a).getTime()) / D;
const latest = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).reduce<string | null>((a, b) => (!a || new Date(b) > new Date(a) ? b : a), null);
const CHANNEL: Record<string, string> = { email: "email", linkedin: "LinkedIn", x: "X", whatsapp: "WhatsApp" };

function closesLabel(closes: string | null, now: Date, t: Timers): { urgent: boolean; text: string } {
  if (!closes) return { urgent: false, text: "" };
  const days = Math.ceil((new Date(closes + "T23:59:59+05:30").getTime() - now.getTime()) / D);
  if (days < 0) return { urgent: false, text: " (closing date passed)" };
  const d = new Date(closes).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return { urgent: days <= t.deadlineWarnDays, text: ` (closes ${d})` };
}

/** My follow-ups after `since`, with touches less than a day apart counted once (an email and a DM the same morning). */
function countTouches(times: string[], since: string): string[] {
  const after = times.filter((x) => new Date(x) > new Date(since)).sort();
  const out: string[] = [];
  for (const x of after) if (!out.length || new Date(x).getTime() - new Date(out[out.length - 1]).getTime() >= D) out.push(x);
  return out;
}

export function computeActions(state: LoopState, now = new Date(), t: Timers = DEFAULT_TIMERS): DesiredAction[] {
  const out: DesiredAction[] = [];
  const base = { thread_id: null, outreach_id: null } as const;

  for (const o of state.opportunities) {
    const label = `${o.role} at ${o.company}`;
    const closes = closesLabel(o.closes_on, now, t);
    if (o.status === "ready") {
      const since = o.pack_ready_at ?? o.updated_at;
      const stale = daysBetween(since, now) * 24 >= t.packStaleHours;
      out.push({
        ...base, rule_key: `loop:apply:${o.id}`, kind: "apply", opportunity_id: o.id,
        title: `Apply: ${label}${closes.text}`,
        detail: [o.next_step, stale ? "This has been ready for a while. Apply, or drop it." : null].filter(Boolean).join("\n") || null,
        due_at: since, urgent: closes.urgent,
      });
    } else if (o.status === "decide" || o.status === "found") {
      if (o.status === "found" && PROCESSING.has(o.pack_status)) continue;
      // A summary or a pack waiting for my go-ahead.
      if (o.status === "decide" || ["ready", "summary"].includes(o.pack_status)) {
        out.push({
          ...base, rule_key: `loop:decide:${o.id}`, kind: "decide", opportunity_id: o.id,
          title: `${o.pack_status === "summary" ? "Review" : "Decide"}: ${label}${closes.text}`,
          detail: [o.hard_gate && `Gate: ${o.hard_gate}`, o.next_step].filter(Boolean).join("\n") || null,
          due_at: o.updated_at, urgent: closes.urgent,
        });
        continue;
      }
      // Not screened in (no company name, an old alert) or a pack that failed: still my call,
      // with a date after which it's skipped on its own.
      const expires = addHours(o.created_at, t.parkedDays * 24);
      out.push({
        ...base, rule_key: `loop:park:${o.id}`, kind: "decide", opportunity_id: o.id,
        title: `${o.pack_status === "failed" ? "Pack failed" : "Not screened in"}: ${label}`,
        detail: [
          o.pack_status === "failed"
            ? `The pack didn't finish${o.pack_error ? ` (${oneLine(o.pack_error, 100)})` : ""}. Build it again or drop the role.`
            : "This wasn't picked up automatically (no company name, or an old alert). Prepare your application if it's worth a look, or drop it.",
          `If nothing is decided, it's skipped on ${fmtDay(expires)}.`,
        ].join("\n"),
        due_at: o.created_at, urgent: false,
      });
    } else if (o.status === "offer") {
      out.push({
        ...base, rule_key: `loop:offer:${o.id}`, kind: "decide", opportunity_id: o.id,
        title: `Respond to the offer: ${label}${closes.text}`,
        detail: o.next_step ?? "Read the offer, settle any open questions with them, and accept, negotiate or decline.",
        due_at: o.updated_at, urgent: closes.urgent,
      });
    }
    if (o.status === "offer" || ENDED.has(o.status)) continue;
    const meetings = (state.meetings ?? []).filter((m) => m.opportunity_id === o.id);
    out.push(...interviewActions(o, meetings, now));
    // A booked interview is the next step; follow-ups wait until it's over.
    const booked = meetings.some((m) => m.status !== "cancelled" && new Date(m.end_at) > now);
    if (IN_FLIGHT.has(o.status) && !booked) out.push(...ladder(o, state, now, t));
  }

  for (const r of state.outreach) {
    if (r.opp_status && CLOSED.has(r.opp_status)) continue;
    const who = `${r.name}${r.company ? ` (${r.company})` : ""}`;
    const common = { thread_id: null, opportunity_id: r.opportunity_id, outreach_id: r.id };
    if (r.status === "drafted") {
      out.push({
        ...common, rule_key: `loop:send:${r.id}`, kind: "send_note",
        title: `Send note to ${who}`,
        detail: [r.send_time && `Best time: ${r.send_time}`, r.why_them].filter(Boolean).join("\n") || null,
        due_at: r.created_at, urgent: false,
      });
    } else if (r.status === "replied") {
      out.push({
        ...common, rule_key: `loop:answer:${r.id}:${r.replied_at ?? ""}`, kind: "reply",
        title: `Reply to ${who}`, detail: r.reply, due_at: r.replied_at ? addHours(r.replied_at, t.replyOwedHours) : r.created_at,
        urgent: r.replied_at ? daysBetween(r.replied_at, now) >= 1 : true,
      });
    } else if (r.status === "note_sent" || r.status === "dm_sent" || r.status === "conversation") {
      // On a role I've applied to, the ladder follows up; it names this person.
      if (r.opp_status && IN_FLIGHT.has(r.opp_status)) continue;
      const since = r.sent_at ?? r.created_at;
      out.push({
        ...common, rule_key: `loop:followup:${r.id}:${since}`, kind: "follow_up",
        title: `Follow up with ${who}`,
        detail: r.status === "note_sent" ? "Connection note sent. They have not accepted yet."
          : r.accepted_at ? `They accepted your connection${r.status === "conversation" ? "" : " but have not replied"}. A short message keeps it moving.` : "Message sent, no reply yet.",
        due_at: addHours(since, t.outreachFollowUpDays * 24), urgent: false,
      });
    }
  }

  for (const th of state.threads) {
    if (!th.last_message_at) continue;
    // A rejected, dropped or skipped role needs no more replies or nudges on its threads.
    if (th.opp_status && CLOSED.has(th.opp_status)) continue;
    // Threads on an application in flight are covered by its ladder, except a fresh message I
    // still owe an answer to.
    const fresh = daysBetween(th.last_message_at, now) < t.followUp1Days;
    if (th.opp_status && IN_FLIGHT.has(th.opp_status) && !(fresh && th.last_from === "them" && th.needs_reply)) continue;
    const who = th.who ?? th.subject ?? "this thread";
    const on = th.channel && th.channel !== "email" ? ` on ${CHANNEL[th.channel] ?? th.channel}` : "";
    if (th.last_from === "them" && th.needs_reply) {
      out.push({
        rule_key: `loop:reply:${th.id}:${th.last_message_at}`, kind: "reply", thread_id: th.id, outreach_id: null,
        opportunity_id: th.opportunity_id, title: `Reply to ${who}${on}`,
        detail: [th.subject, th.last_snippet].filter(Boolean).join("\n"),
        due_at: addHours(th.last_message_at, t.replyOwedHours),
        urgent: daysBetween(th.last_message_at, now) >= 1,
      });
    } else if (th.last_from === "me" && th.kind === "conversation") {
      out.push({
        rule_key: `loop:nudge:${th.id}:${th.last_message_at}`, kind: "follow_up", thread_id: th.id, outreach_id: null,
        opportunity_id: th.opportunity_id, title: `Follow up: ${who}${on}`,
        detail: `You wrote last. ${th.subject ?? ""}`.trim(),
        due_at: addHours(th.last_message_at, t.outreachFollowUpDays * 24), urgent: false,
      });
    }
  }

  out.push(...relationshipActions(state, now, t));
  return out;
}

const LIVE = new Set(["found", "decide", "ready", "applied", "interviewing", "offer"]);
const CLOSE_WINDOW_DAYS = 30;
const where = (r: Relationship) =>
  r.last_channel === "linkedin" ? "on LinkedIn" : r.last_channel === "email" && r.email ? `by email (${r.email})` : r.linkedin_url ? `on LinkedIn: ${r.linkedin_url}` : r.email ? `by email (${r.email})` : "where you last spoke";

/**
 * After a role: close warmly with each person I talked to, then stay in touch on a schedule, and
 * when their company posts a new role, tell them before applying.
 */
function relationshipActions(state: LoopState, now: Date, t: Timers): DesiredAction[] {
  const out: DesiredAction[] = [];
  const rels = (state.relationships ?? []).filter((r) => !r.automated);
  const me = state.me ?? "";
  const closing = new Set<number>();

  // 1. Close warmly, once per person, for roles that ended in the last month.
  for (const r of rels.filter((x) => x.warmth !== "cold")) {
    for (const role of r.roles.filter((x) => x.status === "rejected" || x.status === "dropped")) {
      if (/closing note sent|low match|first screen/i.test(role.skip_reason ?? "")) continue;
      const ended = state.ended?.[role.id];
      if (!ended || daysBetween(ended, now) > CLOSE_WINDOW_DAYS) continue;
      // Already written to them since it ended: that was the close.
      if (r.last_from === "me" && r.last_touch_at && r.last_touch_at >= ended) continue;
      closing.add(r.contact_id);
      const kind = role.status === "rejected" ? "rejected" : "withdrew";
      out.push({
        rule_key: `loop:close:${role.id}:${r.contact_id}`, kind: "send_note", opportunity_id: role.id, thread_id: null, outreach_id: null,
        title: `Close warmly: ${r.name} (${role.role} at ${role.company.replace(/\s*\(.*$/, "")})`,
        detail: [
          kind === "rejected" ? "They said no. A short thank-you keeps the door open for the next role there." : "You stepped back from this role. Tell them yourself rather than go quiet.",
          `Send it ${where(r)}:`, "", closureNote(kind, r, role, { met: r.met, me }),
        ].join("\n"),
        due_at: addHours(ended, t.warmCloseHours), urgent: false,
      });
    }
  }

  // 2. Stay in touch with people who aren't part of a role in progress.
  for (const r of rels) {
    if (!keepsInTouch(r) || !r.last_touch_at || closing.has(r.contact_id)) continue;
    if (r.roles.some((x) => LIVE.has(x.status))) continue; // the role's own steps cover them
    const every = r.warmth === "close" ? t.keepInTouchCloseDays : t.keepInTouchWarmDays;
    const open = state.opportunities.filter((o) => ["found", "decide", "ready"].includes(o.status) && r.company && sameCompany(o.company, r.company));
    const history = r.roles.map((x) => `${x.role} (${x.status})`).join(", ");
    out.push({
      rule_key: `loop:touch:${r.contact_id}:${r.last_touch_at}`, kind: "follow_up", opportunity_id: null, thread_id: null, outreach_id: null,
      title: `Stay in touch: ${r.name}${r.company ? ` (${r.company})` : ""}`,
      detail: [
        `${r.warmth === "close" ? "You've met or talked a lot" : "You've written to each other"}. Last in touch ${fmtDay(r.last_touch_at)}${history ? `, about ${history}` : ""}.`,
        touchIdea(r, open.map((o) => o.role)),
      ].join("\n"),
      due_at: addHours(r.last_touch_at, every * 24), urgent: false,
    });
  }

  // 3. A new role where I already know someone: tell them before applying.
  for (const o of state.opportunities) {
    if (!["decide", "ready"].includes(o.status) && !(o.status === "found" && ["summary", "ready"].includes(o.pack_status))) continue;
    for (const r of rels.filter((x) => x.warmth !== "cold" && x.stay_in_touch !== 0 && x.company && sameCompany(o.company, x.company))) {
      if (r.roles.some((x) => x.id === o.id)) continue;
      const before = r.roles.map((x) => x.role).slice(0, 2).join(", ");
      out.push({
        rule_key: `loop:reengage:${o.id}:${r.contact_id}`, kind: "send_note", opportunity_id: o.id, thread_id: null, outreach_id: null,
        title: `Tell ${r.name} about ${o.role}`,
        detail: `You know ${r.name}${r.title ? ` (${r.title})` : ""} from ${before || "an earlier conversation"}: ${r.warmth === "close" ? "you've talked a lot" : "you've written to each other"}, last in touch ${r.last_touch_at ? fmtDay(r.last_touch_at) : "a while ago"}. Before you apply, write ${where(r)}: say you saw the ${o.role} opening and ask whether they know the team or could point you to the right person.`,
        due_at: o.updated_at, urgent: false,
      });
    }
  }
  return out;
}

const PART: Record<string, string> = {
  hiring_manager: "the hiring manager", recruiter: "the recruiter", team_lead: "who leads the team", team_member: "on the team",
  job_poster: "who posted the role", founder: "a founder", referrer: "who could refer you",
};
const localTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: TIMEZONE });
const people = (m: Meeting) => {
  try { return (JSON.parse(m.attendees ?? "[]") as { email: string | null; name: string | null }[]).map((a) => a.name ?? a.email).filter(Boolean).slice(0, 4).join(", "); } catch { return ""; }
};

/** Prepare before each interview, thank them after, rebook a cancelled one. */
function interviewActions(o: OppRow, meetings: Meeting[], now: Date): DesiredAction[] {
  const base = { thread_id: null, outreach_id: null, opportunity_id: o.id } as const;
  const label = `${o.role} at ${o.company}`;
  const out: DesiredAction[] = [];
  const upcoming = meetings.filter((m) => m.status !== "cancelled" && new Date(m.end_at) > now);
  for (const m of meetings) {
    const with_ = people(m);
    if (m.status === "cancelled") {
      // Only a cancellation with nothing booked in its place, from the last two weeks.
      if (upcoming.length || daysBetween(m.start_at, now) > 14) continue;
      out.push({
        ...base, rule_key: `loop:rebook:${m.event_id}`, kind: "follow_up",
        title: `Rebook: ${label}`,
        detail: `"${m.title}" on ${localTime(m.start_at)} was cancelled and nothing new is booked. Ask${with_ ? ` ${with_}` : " them"} for a new time.`,
        due_at: new Date(Math.min(new Date(m.updated_at).getTime(), now.getTime())).toISOString(), urgent: true,
      });
    } else if (new Date(m.end_at) > now) {
      const hoursAway = (new Date(m.start_at).getTime() - now.getTime()) / H;
      out.push({
        ...base, rule_key: `loop:prep:${m.event_id}`, kind: "interview",
        title: `Interview ${localTime(m.start_at)}: ${label}`,
        detail: [
          `"${m.title}"${with_ ? ` with ${with_}` : ""}.`,
          "Prepare: re-read the job description and your notes on the role, look up the people you're meeting, and have two questions ready for them.",
          m.join_url ? `Join: ${m.join_url}` : null,
        ].filter(Boolean).join("\n"),
        due_at: addHours(m.start_at, -24), urgent: hoursAway <= 24,
      });
    } else if (daysBetween(m.end_at, now) <= 7) {
      // Only the latest interview needs a thank-you.
      const later = meetings.some((x) => x !== m && x.status !== "cancelled" && x.start_at > m.start_at);
      if (later) continue;
      out.push({
        ...base, rule_key: `loop:thanks:${m.event_id}`, kind: "follow_up",
        title: `Send a thank-you: ${label}`,
        detail: `After "${m.title}" on ${localTime(m.start_at)}${with_ ? ` with ${with_}` : ""}. Thank them within a day, mention one specific thing you talked about, and ask about next steps.`,
        due_at: addHours(m.end_at, 2), urgent: false,
      });
    }
  }
  return out;
}

/**
 * The next step for an application in flight. Their side (an email, a DM reply, a status
 * change, applying) sets the clock; my follow-ups since then decide which rung is next.
 */
function ladder(o: OppRow, state: LoopState, now: Date, t: Timers): DesiredAction[] {
  const base = { thread_id: null, outreach_id: null } as const;
  const label = `${o.role} at ${o.company}`;
  const out: DesiredAction[] = [];
  const mail = state.latestMail?.find((m) => m.opportunity_id === o.id);
  const touches = (state.touches ?? []).filter((x) => x.opportunity_id === o.id);
  const people = state.outreach.filter((r) => r.opportunity_id === o.id);
  const threads = state.threads.filter((x) => x.opportunity_id === o.id);

  // With no applied date, count from when the tracker first saw it, never from updated_at:
  // that moves on every sync and would keep the clock from ever running out.
  const applied = o.date_applied ? o.date_applied + "T09:00:00+05:30" : o.created_at;
  const past = (x: string | null | undefined) => (x && new Date(x) <= now ? x : null);
  const theirs = latest([
    applied,
    ...touches.filter((x) => !x.from_me).map((x) => x.at),
    mail && mail.last_from !== "me" ? mail.last_message_at : null,
    ...threads.filter((x) => x.last_from === "them").map((x) => x.last_message_at),
    ...people.map((r) => r.replied_at),
    ...(state.statusChanges ?? []).filter((e) => e.opportunity_id === o.id).map((e) => e.at),
    ...(state.meetings ?? []).filter((m) => m.opportunity_id === o.id && m.status !== "cancelled").map((m) => m.end_at),
  ].map(past)) ?? applied;
  // The first note to a person starts the wait; later messages of mine are follow-ups.
  const marked = (state.followUps ?? []).filter((e) => e.opportunity_id === o.id);
  // A conversation I started: its opening message is a first note too, not a follow-up.
  const openers = [...new Set(touches.map((x) => x.thread_id))].map((id) => touches.filter((x) => x.thread_id === id).sort((a, b) => a.at.localeCompare(b.at))[0])
    .filter((x) => x && x.thread_id != null && x.from_me).map((x) => x.at);
  const firstNotes = [...people.map((r) => r.sent_at), ...marked.filter((e) => e.first).map((e) => e.at), ...openers].filter((x): x is string => !!x);
  const reachedOut = firstNotes.length > 0 || touches.some((x) => x.from_me) || threads.some((x) => x.last_from === "me");
  const mine = countTouches([
    ...touches.filter((x) => x.from_me).map((x) => x.at),
    ...threads.filter((x) => x.last_from === "me").map((x) => x.last_message_at!).filter(Boolean),
    ...marked.filter((e) => !e.first).map((e) => e.at),
  ], theirs).filter((x) => !firstNotes.some((f) => Math.abs(new Date(f).getTime() - new Date(x).getTime()) < H));
  const n = mine.length;

  // Who to write to: whoever spoke last on their side, else whoever I reached out to.
  const replied = people.filter((r) => r.replied_at).sort((a, b) => b.replied_at!.localeCompare(a.replied_at!))[0];
  const sent = people.filter((r) => r.sent_at).sort((a, b) => b.sent_at!.localeCompare(a.sent_at!))[0];
  const who = mail?.who ?? replied?.name ?? sent?.name ?? null;
  const to = who ? ` to ${who}` : "";
  const channels = [...new Set([
    ...touches.map((x) => x.channel ?? "email"), ...threads.map((x) => x.channel ?? "email"),
    ...(firstNotes.length ? ["linkedin"] : []),
  ])].map((c) => CHANNEL[c] ?? c);

  // First touch: an application nobody has heard about from me yet. A drafted note already
  // has its own "send" reminder.
  // Only while the application is fresh; past the first follow-up date the ladder takes over.
  const fresh = now.getTime() < new Date(applied).getTime() + t.followUp1Days * D;
  if (o.status === "applied" && fresh && !reachedOut && !people.some((r) => r.status === "drafted")) {
    out.push({
      ...base, rule_key: `loop:firsttouch:${o.id}`, kind: "send_note", opportunity_id: o.id,
      title: `Reach a person: ${label}`,
      detail: (() => {
        const p = bestContact(getBrief(o));
        const who = p ? `${p.name}${p.title ? ` (${p.title})` : ""}, ${PART[p.part] ?? p.part}${p.confidence === "high" ? "" : ", likely"}${p.linkedin_url ? `: ${p.linkedin_url}` : ""}. ${p.evidence}` : null;
        return who
          ? `You applied, but nobody there has heard from you. Write to ${who}\nSay you applied, why you fit, and one specific reason you want this team.`
          : "You applied, but nobody there has heard from you. Find the recruiter or hiring manager and send a short note: you applied, why you fit, one specific reason you want this team.";
      })(),
      due_at: addHours(applied, t.firstTouchHours), urgent: false,
    });
  }

  const startAfter = Math.max(...[theirs, ...firstNotes].map((x) => new Date(x).getTime()));
  const anchor = n ? mine[n - 1] : new Date(startAfter).toISOString();
  // Silence longer than the whole ladder before my first follow-up: that follow-up is the
  // last check-in, and the next step is the warm close.
  const ladderDays = t.followUp1Days + t.followUp2Days + t.closeAfterDays;
  const longQuiet = (new Date(mine[0] ?? now).getTime() - new Date(theirs).getTime()) / D >= ladderDays;
  const step = n + (longQuiet ? 1 : 0);
  const gapDays = n === 0 ? (o.status === "interviewing" ? t.interviewFollowUpDays : t.followUp1Days) : step === 1 ? t.followUp2Days : t.closeAfterDays;
  let due = addHours(anchor, gapDays * 24);
  const closedPosting = o.posting_state === "closed";
  if (closedPosting && o.posting_checked_at && step < 2 && new Date(o.posting_checked_at) < new Date(due)) due = new Date(o.posting_checked_at).toISOString();

  const quietDays = Math.floor(daysBetween(theirs, now));
  const fromMail = mail && mail.last_message_at === theirs;
  const auto = fromMail && automated(mail!);
  const theyLast = fromMail && !auto && mail!.last_from === "them" && mail!.last_snippet ? `They said: "${oneLine(mail!.last_snippet)}"` : null;
  const lastLine = fromMail
    ? `Last contact: ${fmtDay(theirs)}, ${auto ? (/invitation/i.test(mail!.subject ?? "") ? "a calendar invite" : "an automated update") : `${who ?? "they"} wrote`}${mail!.subject ? ` ("${oneLine(mail!.subject, 70)}")` : ""}.`
    : `Last contact: ${fmtDay(theirs)}${o.date_applied && theirs.startsWith(o.date_applied) ? " (when you applied)" : ""}.`;
  const sentLine = n ? `Your follow-ups since: ${mine.map(fmtDay).join(", ")}.` : null;

  let title: string;
  let move: string;
  if (step >= 2) {
    title = `Close warmly: ${label}`;
    move = `No answer after two follow-ups. Send a short closing note${to}: thank them, say you'd be glad to hear about future roles, and close the role. A warm close keeps the door open.`;
  } else if (closedPosting) {
    title = `Posting taken down: ${label}`;
    move = `The posting is gone, so the role is likely filled. Ask${to} whether it's still open${n ? "" : " and where things stand"}; if it's filled, close warmly.`;
  } else if (n === 0 && longQuiet) {
    title = `Likely closed: ${label} (${quietDays} days)`;
    move = `After ${quietDays} days of silence the role has most likely closed or gone to someone else. Send one short check-in${to} asking whether it's still open. If there's no answer, close it warmly.`;
  } else if (step === 1) {
    title = `Follow up again: ${label}`;
    move = `One follow-up with no answer. Try ${channels.length ? `a different channel than ${channels.join(" and ")}` : "a different channel"} or a different person on the team${to ? `, or write${to} once more` : ""}.`;
  } else if (fromMail && !auto && mail!.last_from === "them") {
    title = `Follow up: ${label}`;
    move = `They wrote last. Reply${to}, or close it if you're no longer interested.`;
  } else {
    title = quietDays >= gapDays ? `Gone quiet: ${label} (${quietDays} days)` : `Follow up: ${label}`;
    move = `Send a short follow-up${to} asking about next steps${o.status === "interviewing" ? " after your interview" : ""}.`;
  }

  out.push({
    ...base, rule_key: `loop:ladder:${o.id}:${theirs}:${n}`, kind: "follow_up", opportunity_id: o.id,
    title,
    detail: [
      `Stage: ${o.status}${o.date_applied ? `, applied ${fmtDay(o.date_applied)}` : ""}. Step ${Math.min(step + 1, 3)} of 3 (follow up, follow up again, close warmly).`,
      lastLine, sentLine, theyLast, channels.length ? `Channels used: ${channels.join(", ")}.` : null, `Next: ${move}`,
    ].filter(Boolean).join("\n"),
    due_at: due, urgent: step >= 2 && new Date(due) <= now,
  });
  return out;
}

export function loadLoopState(): LoopState {
  return {
    opportunities: all<OppRow>("SELECT * FROM opportunities"),
    outreach: all<OutreachRow>(
      `SELECT r.*, c.name, o.company, o.status AS opp_status FROM outreach r
       JOIN contacts c ON c.id = r.contact_id LEFT JOIN opportunities o ON o.id = r.opportunity_id`,
    ),
    threads: all<ThreadRow>(
      `SELECT t.*, c.name AS who, o.status AS opp_status FROM threads t
       LEFT JOIN contacts c ON c.id = t.contact_id LEFT JOIN opportunities o ON o.id = t.opportunity_id
       WHERE t.status = 'open' AND t.kind = 'conversation'`,
    ),
    latestMail: all<LatestMail>(
      `SELECT t.opportunity_id, t.last_message_at, t.last_from, t.subject, t.last_snippet, t.kind, t.channel,
         coalesce(c.name, (SELECT c2.name FROM threads t3 JOIN contacts c2 ON c2.id = t3.contact_id
           WHERE t3.opportunity_id = t.opportunity_id ORDER BY t3.last_message_at DESC LIMIT 1)) AS who
       FROM threads t LEFT JOIN contacts c ON c.id = t.contact_id
       WHERE t.opportunity_id IS NOT NULL AND t.last_message_at IS NOT NULL
         AND t.last_message_at = (SELECT max(last_message_at) FROM threads t2 WHERE t2.opportunity_id = t.opportunity_id)`,
    ),
    touches: all<Touch>(
      `SELECT t.opportunity_id, m.sent_at AS at, m.from_me, t.channel, t.id AS thread_id FROM messages m JOIN threads t ON t.id = m.thread_id
       JOIN opportunities o ON o.id = t.opportunity_id WHERE o.status IN ('applied', 'interviewing')`,
    ),
    followUps: all<OppEvent>(
      "SELECT CAST(ref AS INTEGER) AS opportunity_id, at, (detail = 'first touch') AS first FROM events WHERE kind = 'followup.sent' AND ref IS NOT NULL",
    ),
    statusChanges: all<OppEvent>(
      `SELECT CAST(ref AS INTEGER) AS opportunity_id, at FROM events
       WHERE kind = 'opportunity.status' AND json_extract(detail, '$.to') = 'interviewing'`,
    ),
    meetings: all<Meeting>("SELECT * FROM meetings WHERE opportunity_id IS NOT NULL"),
    relationships: loadRelationships(),
    ended: Object.fromEntries(all<{ id: number }>("SELECT id FROM opportunities WHERE status IN ('rejected', 'dropped')")
      .map((o) => [o.id, endedAt(o.id)]).filter(([, at]) => at)),
    me: loadProfile().name,
  };
}

/** Roles not decided within `parkedDays` are skipped, so the list never fills with roles no one will look at. */
function expireParked(now: Date, t: Timers): number {
  return Number(run(
    `UPDATE opportunities SET status = 'skipped', updated_at = $now,
       skip_reason = 'Not decided within ' || $days || ' days'
     WHERE status = 'found' AND pack_status IN ('none', 'failed') AND created_at < $cutoff
       AND user_locked NOT LIKE '%"status"%'`,
    { now: now.toISOString(), days: String(t.parkedDays), cutoff: new Date(now.getTime() - t.parkedDays * D).toISOString() },
  ).changes);
}

/**
 * Writes the engine's view into the actions table. New loops are added, open ones are refreshed,
 * loops that no longer apply are closed as resolved. Actions I marked done or dropped stay that way.
 */
export function reconcileActions(now = new Date()) {
  const t = getTimers();
  const parked = expireParked(now, t);
  if (parked) logEvent("loops.parked_skipped", null, { count: parked });
  const desired = computeActions(loadLoopState(), now, t);
  const keys = new Set(desired.map((d) => d.rule_key));
  let added = 0, resolved = 0;

  for (const d of desired) {
    const existing = get<{ id: number; status: string }>("SELECT id, status FROM actions WHERE rule_key = $k", { k: d.rule_key });
    const params = {
      k: d.rule_key, kind: d.kind, title: d.title, detail: d.detail, due: d.due_at, urgent: d.urgent ? 1 : 0,
      opp: d.opportunity_id, thread: d.thread_id, outreach: d.outreach_id,
    };
    if (!existing) {
      run(
        `INSERT INTO actions (rule_key, kind, title, detail, due_at, urgent, opportunity_id, thread_id, outreach_id)
         VALUES ($k, $kind, $title, $detail, $due, $urgent, $opp, $thread, $outreach)`,
        params,
      );
      added++;
    } else if (existing.status === "open") {
      run(
        `UPDATE actions SET kind = $kind, title = $title, detail = $detail, due_at = $due, urgent = $urgent,
         opportunity_id = $opp, thread_id = $thread, outreach_id = $outreach WHERE rule_key = $k`,
        params,
      );
    }
  }

  // A role that's over (rejected, closed, dropped) leaves nothing to do: reminders imported from
  // my sheet ("Prepare for the call") close with it.
  resolved += Number(run(
    `UPDATE actions SET status = 'done', done_at = $now, detail = coalesce(detail, '') || '\n(Role closed)'
     WHERE status = 'open' AND rule_key NOT LIKE 'loop:%'
       AND opportunity_id IN (SELECT id FROM opportunities WHERE status IN ('rejected', 'dropped', 'skipped'))`,
    { now: nowIso() },
  ).changes);

  for (const a of all<{ id: number; rule_key: string }>("SELECT id, rule_key FROM actions WHERE status = 'open' AND rule_key LIKE 'loop:%'")) {
    if (!keys.has(a.rule_key)) {
      run("UPDATE actions SET status = 'done', done_at = $now, detail = coalesce(detail, '') || '\n(Resolved automatically)' WHERE id = $id", { id: a.id, now: nowIso() });
      resolved++;
    }
  }
  if (added || resolved) logEvent("loops.reconciled", null, { added, resolved });
  return { added, resolved, open: desired.length, parked };
}

export interface StalledRole { id: number; company: string; role: string; status: string; updated_at: string }

/**
 * Roles still in play with no open action: the rule the whole lifecycle exists to keep. It
 * happens when I drop a reminder without changing the role. Packs being built don't count.
 */
export function stalledRoles(): StalledRole[] {
  return all<StalledRole>(
    `SELECT o.id, o.company, o.role, o.status, o.updated_at FROM opportunities o
     WHERE o.status IN ('found', 'decide', 'ready', 'applied', 'interviewing', 'offer')
       AND NOT (o.status = 'found' AND o.pack_status IN ('queued', 'summarizing', 'building', 'approved', 'held'))
       AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.opportunity_id = o.id AND a.status = 'open')
     ORDER BY o.updated_at DESC`,
  );
}

/** Brings back the current reminder for a role whose reminder I dropped. */
export function remindAgain(opportunityId: number, now = new Date()) {
  const desired = computeActions(loadLoopState(), now, getTimers()).filter((d) => d.opportunity_id === opportunityId);
  for (const d of desired) run("DELETE FROM actions WHERE rule_key = $k AND status != 'open'", { k: d.rule_key });
  reconcileActions(now);
}

export interface ActionRow {
  id: number; rule_key: string; kind: string; title: string; detail: string | null; due_at: string; urgent: number;
  opportunity_id: number | null; thread_id: number | null; outreach_id: number | null; status: string;
  snoozed_until: string | null; notified_at: string | null;
}

/** Open actions that are due now (or within `aheadHours`), most urgent first. */
export function dueActions(now = new Date(), aheadHours = 0): ActionRow[] {
  return all<ActionRow>(
    `SELECT * FROM actions WHERE status = 'open'
       AND due_at <= $limit AND (snoozed_until IS NULL OR snoozed_until <= $now)
     ORDER BY urgent DESC, due_at ASC`,
    { limit: new Date(now.getTime() + aheadHours * H).toISOString(), now: now.toISOString() },
  );
}

/**
 * Closes an action. When it was a reply I owed, the reply counts as sent even if the tool
 * couldn't see it (sent from Outlook, LinkedIn or WhatsApp): the ball is with them again and
 * the follow-up timer starts now. A follow-up marked done moves its role one rung down the
 * ladder; a first touch marked done counts as reaching out.
 */
export function completeAction(id: number, status: "done" | "dropped" = "done", now = new Date()) {
  const at = now.toISOString();
  const a = get<{ kind: string; rule_key: string | null; thread_id: number | null; outreach_id: number | null; opportunity_id: number | null }>(
    "SELECT kind, rule_key, thread_id, outreach_id, opportunity_id FROM actions WHERE id = $id", { id },
  );
  run("UPDATE actions SET status = $s, done_at = $now WHERE id = $id", { s: status, now: at, id });
  if (status === "done" && a?.kind === "reply") {
    if (a.thread_id) {
      run("UPDATE threads SET last_from = 'me', last_message_at = $now, needs_reply = 0 WHERE id = $id", { now: at, id: a.thread_id });
    }
    if (a.outreach_id) {
      run("UPDATE outreach SET status = 'conversation', sent_at = $now WHERE id = $id", { now: at, id: a.outreach_id });
    }
  }
  // A closing note, a stay-in-touch or a re-engage note sent: the person's clock restarts.
  const person = a?.rule_key?.match(/^loop:(close|touch|reengage):(?:\d+:)?(\d+)(?::|$)/);
  if (status === "done" && person) {
    const contactId = a!.rule_key!.startsWith("loop:touch:") ? Number(a!.rule_key!.split(":")[2]) : Number(a!.rule_key!.split(":")[3]);
    run("INSERT INTO events (at, kind, ref, detail) VALUES ($at, 'relationship.touch', $ref, $d)", { at, ref: String(contactId), d: JSON.stringify({ channel: person[1] === "close" ? "closing note" : "note" }) });
  }
  if (status === "done" && a?.opportunity_id && (a.rule_key?.startsWith("loop:ladder:") || a.rule_key?.startsWith("loop:firsttouch:"))) {
    run("INSERT INTO events (at, kind, ref, detail) VALUES ($at, 'followup.sent', $ref, $d)", {
      at, ref: String(a.opportunity_id), d: a.rule_key.startsWith("loop:firsttouch:") ? "first touch" : null,
    });
  }
  logEvent("action." + status, id);
}

export function snoozeAction(id: number, hours: number) {
  run("UPDATE actions SET snoozed_until = $u WHERE id = $id", { u: new Date(Date.now() + hours * H).toISOString(), id });
}

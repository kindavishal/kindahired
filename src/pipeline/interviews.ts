import { all, get, logEvent, nowIso, run } from "../db/index.ts";
import { getOpportunity, normalise, rejectedAt, updateOpportunity } from "../db/opportunities.ts";
import { reconcileActions } from "../loops/engine.ts";
import { CALENDAR_SCOPE, googleClient, googleConnected, hasScope } from "../sources/google-auth.ts";

/**
 * Interviews from Google Calendar (read-only). An event is kept when it matches a role I'm
 * tracking (an attendee I've been talking to about it, an attendee from the company's own
 * domain, or the company named in an event that reads like an interview), or when its title
 * plainly says it is an interview, even with no role to match (it still shows on Home and the
 * Interviews page). Everything else on my calendar is skipped and never stored.
 */

export interface CalEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean }[];
  organizer?: { email?: string; self?: boolean };
  conferenceData?: { entryPoints?: { uri?: string; entryPointType?: string }[] };
}

export interface RoleKey { id: number; company: string; status: string; updated_at: string; emails: string[] }

/** A title that plainly names an interview: kept even when no tracked role matches. */
export const CLEARLY_INTERVIEW = /\b(interview|recruiter (call|screen|chat)|hiring manager|phone screen|technical (round|screen)|panel|onsite|assessment|case study|take[- ]home|final round|culture fit)\b/i;
const INTERVIEWISH = /\b(interview|screen(?:ing)?|round|call|chat|conversation|intro|introduction|meet(?:ing)?|discussion|hiring|technical|assessment|panel|onsite|presentation|demo|catch[- ]?up|sync|connect)\b/i;
const GENERIC_DOMAINS = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton(?:mail)?|calendar\.google|resource\.calendar\.google|group\.calendar\.google)\./i;
/** Scheduling tools that send invites on a company's behalf: their domain says nothing about the company. */
const SCHEDULERS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|goodtime\.io|calendly\.com|workable\.com|smartrecruiters\.com|zoom\.us|cal\.com|hubspot\.com)$/i;
const RANK: Record<string, number> = { offer: 5, interviewing: 4, applied: 3, ready: 2, decide: 1, found: 0 };

/** The word that names a company in a domain or a sentence: "Helius (via Bhavana)" → "helius". */
export function companyKey(company: string): string {
  return normalise(company).split(" ").find((w) => w.length >= 3) ?? "";
}

/**
 * The role an event is about, with how sure the match is: 3 an attendee I've talked to about
 * it, 2 an attendee from the company's domain, 1 only the company's name in an interview-like
 * event (kept only for roles I've applied to). Roles I'm further along with win a tie.
 */
export function matchEvent(e: CalEvent, roles: RoleKey[]): { id: number; score: number } | null {
  const others = [...(e.attendees ?? []), ...(e.organizer ? [e.organizer] : [])]
    .filter((a) => !a.self && !("resource" in a && a.resource) && a.email).map((a) => a.email!.toLowerCase());
  const domains = others.map((x) => x.split("@")[1] ?? "").filter((d) => d && !GENERIC_DOMAINS.test(d) && !SCHEDULERS.test(d));
  const text = `${e.summary ?? ""}\n${(e.description ?? "").slice(0, 3000)}`.toLowerCase();
  const scored = roles.map((r) => {
    const key = companyKey(r.company);
    let score = 0;
    if (r.emails.some((x) => others.includes(x.toLowerCase()))) score = 3;
    else if (key && domains.some((d) => d.split(".").includes(key) || d.startsWith(key))) score = 2;
    else if (key && ["applied", "interviewing", "offer"].includes(r.status) && new RegExp(`\\b${key}\\b`).test(text) && INTERVIEWISH.test(text)) score = 1;
    // A rejected role named in an event titled as an interview: they came back (for example
    // after I asked them to reconsider), often through a scheduler like Greenhouse.
    else if (key && r.status === "rejected" && new RegExp(`\\b${key}\\b`).test((e.summary ?? "").toLowerCase()) && CLEARLY_INTERVIEW.test(e.summary ?? "")) score = 1;
    return { r, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || (RANK[b.r.status] ?? 0) - (RANK[a.r.status] ?? 0) || b.r.updated_at.localeCompare(a.r.updated_at));
  return scored[0] ? { id: scored[0].r.id, score: scored[0].score } : null;
}

function rolesToMatch(): RoleKey[] {
  const roles = all<{ id: number; company: string; status: string; updated_at: string }>(
    // Rejected roles too: a company sometimes comes back with another round after a no.
    "SELECT id, company, status, updated_at FROM opportunities WHERE status IN ('found', 'decide', 'ready', 'applied', 'interviewing', 'offer', 'rejected')",
  );
  const emails = all<{ opportunity_id: number; email: string }>(
    `SELECT t.opportunity_id, c.email FROM threads t JOIN contacts c ON c.id = t.contact_id WHERE t.opportunity_id IS NOT NULL AND c.email IS NOT NULL
     UNION SELECT r.opportunity_id, c.email FROM outreach r JOIN contacts c ON c.id = r.contact_id WHERE r.opportunity_id IS NOT NULL AND c.email IS NOT NULL`,
  );
  return roles.map((r) => ({ ...r, emails: emails.filter((x) => x.opportunity_id === r.id).map((x) => x.email) }));
}

const when = (t?: { dateTime?: string; date?: string }) => (t?.dateTime ? new Date(t.dateTime).toISOString() : t?.date ? `${t.date}T00:00:00.000Z` : null);

/** Stores the events that match a role, and moves an applied role to interviewing. */
export function fileEvents(events: CalEvent[], now = new Date()): { matched: number; cancelled: number; moved: number[] } {
  const roles = rolesToMatch();
  const out = { matched: 0, cancelled: 0, moved: [] as number[] };
  for (const e of events) {
    const known = get<{ opportunity_id: number | null }>("SELECT opportunity_id FROM meetings WHERE event_id = $id", { id: e.id });
    // Cancelled events come back without their details; they only matter if already filed.
    if (e.status === "cancelled") {
      if (known) { run("UPDATE meetings SET status = 'cancelled', updated_at = $now WHERE event_id = $id", { id: e.id, now: nowIso() }); out.cancelled++; }
      continue;
    }
    const match = known?.opportunity_id ? { id: known.opportunity_id, score: 3 } : matchEvent(e, roles);
    const opp = match?.id ?? null;
    const start = when(e.start);
    const end = when(e.end) ?? start;
    // No role matched: keep it only if the title plainly says interview (and it is recent or ahead).
    const unmatchedInterview = !opp && CLEARLY_INTERVIEW.test(e.summary ?? "") && !!end && new Date(end).getTime() > now.getTime() - 30 * 86400_000;
    if ((!opp && !unmatchedInterview && !known) || !start || !end) continue;
    const join = e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri
      ?? (e.description ?? "").match(/https:\/\/[^\s"<>]*(zoom\.us|teams\.microsoft\.com|meet\.google\.com|whereby\.com)[^\s"<>]*/i)?.[0] ?? null;
    const attendees = (e.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => ({ email: a.email ?? null, name: a.displayName ?? null }));
    run(
      `INSERT INTO meetings (event_id, opportunity_id, title, start_at, end_at, status, link, join_url, attendees, updated_at)
       VALUES ($id, $opp, $title, $start, $end, $status, $link, $join, $att, $now)
       ON CONFLICT(event_id) DO UPDATE SET opportunity_id = coalesce(meetings.opportunity_id, excluded.opportunity_id), title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
         status = excluded.status, link = excluded.link, join_url = excluded.join_url, attendees = excluded.attendees, updated_at = excluded.updated_at`,
      { id: e.id, opp, title: e.summary ?? "Meeting", start, end, status: e.status ?? "confirmed", link: e.htmlLink ?? null, join, att: JSON.stringify(attendees), now: nowIso() },
    );
    out.matched++;
    if (!opp) continue;
    // A call on the calendar means the application has moved past "applied".
    const o = getOpportunity(opp);
    // An interview booked after a rejection means they came back: the role is open again.
    const noAt = o?.status === "rejected" ? rejectedAt(opp) : null;
    if (o && noAt && new Date(end) > now && start > noAt) {
      updateOpportunity(opp, { status: "interviewing", skip_reason: null, next_step: `New interview booked after the earlier no: ${e.summary ?? "interview"}.` }, { reopen: true });
      if (getOpportunity(opp)!.status === "interviewing") { out.moved.push(opp); logEvent("opportunity.reopened", opp, { via: "calendar", event: e.id }); }
    }
    if (o && ["found", "decide", "ready", "applied"].includes(o.status) && new Date(start) <= new Date(now.getTime() + 60 * 86400_000)) {
      updateOpportunity(opp, { status: "interviewing" });
      if (getOpportunity(opp)!.status === "interviewing") out.moved.push(opp);
    }
  }
  return out;
}

export function calendarReady(): boolean {
  return googleConnected() && hasScope(CALENDAR_SCOPE);
}

/** Reads the primary calendar from three weeks back to six weeks ahead and files interviews. */
export async function syncCalendar(now = new Date()) {
  if (!calendarReady()) return { skipped: "Calendar isn't connected yet. Run: npm run jh -- auth:google" };
  const client = googleClient();
  const events: CalEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: new Date(now.getTime() - 21 * 86400_000).toISOString(),
      timeMax: new Date(now.getTime() + 45 * 86400_000).toISOString(),
      singleEvents: "true", showDeleted: "true", maxResults: "250", orderBy: "startTime",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await client.request<{ items?: CalEvent[]; nextPageToken?: string }>({
      url: `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    });
    events.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken && events.length < 1000);
  const r = fileEvents(events, now);
  reconcileActions(now);
  logEvent("calendar.sync", null, { events: events.length, ...r });
  return { events: events.length, ...r };
}

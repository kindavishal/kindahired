/**
 * The numbers behind the dashboard's "What is working" and "Progress" pages, and the hints on
 * Home. Everything is computed from the database on each request; nothing is cached or guessed.
 */

import { loadProfile, targetTerms } from "../config.ts";
import { all, get } from "../db/index.ts";
import { roleTokens } from "../db/opportunities.ts";
import { daysFrom, sourceLabel } from "./ui.ts";

const DAY = 86_400_000;
export const APPLIED = ["applied", "interviewing", "offer", "rejected"] as const;
const IN_LIST = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(",");

/** Lead, senior and manager titles; everything else counts as an individual (IC) role. */
export const LEAD = /\b(senior|sr\.?|lead|head|manager|director|principal|staff|vp|chief)\b/i;
/** Your target role families (profile.targets): a role belongs to the first whose words it contains. */
function familyOf(role: string, targets: string[]): string {
  const words = roleTokens(role);
  const hit = targets.find((t) => targetTerms(t).some((term) => [...roleTokens(term)].every((w) => words.has(w))));
  return hit ?? "Other";
}
export const isLead = (role: string) => LEAD.test(role);

export type Split = { label: string; a: number; b: number };
type AppliedRow = { id: number; role: string; company: string; source: string | null; status: string };

function splitBy(rows: AppliedRow[], key: (r: AppliedRow) => string | null): Split[] {
  const m = new Map<string, Split>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const s = m.get(k) ?? { label: k, a: 0, b: 0 };
    s.b++;
    if (r.status === "interviewing" || r.status === "offer") s.a++;
    m.set(k, s);
  }
  return [...m.values()].sort((x, y) => y.b - x.b);
}
const rate = (s: Split) => (s.b ? s.a / s.b : 0);
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export function interviewStats() {
  const rows = all<AppliedRow>(`SELECT id, role, company, source, status FROM opportunities WHERE status IN (${IN_LIST(APPLIED)})`);
  const level = splitBy(rows, (r) => (isLead(r.role) ? "Lead, senior or manager" : "Individual roles"))
    .sort((x) => (x.label === "Individual roles" ? -1 : 1));
  let targets: string[] = [];
  try { targets = loadProfile().targets; } catch { /* no profile yet */ }
  const family = splitBy(rows, (r) => familyOf(r.role, targets));
  const source = splitBy(rows, (r) => sourceLabel(r.source));
  const interviews = rows.filter((r) => r.status === "interviewing" || r.status === "offer").length;
  return { total: rows.length, interviews, level, family, source };
}

/** The one-line takeaways for each split, written from the numbers. */
export function splitStories(s: ReturnType<typeof interviewStats>) {
  const ic = s.level.find((x) => x.label === "Individual roles");
  const lead = s.level.find((x) => x.label !== "Individual roles");
  let levelHead = "Not enough applications to compare levels yet";
  let levelSay = "This fills in as you apply to both individual and lead roles.";
  if (ic && lead && ic.b && lead.b) {
    const [hi, lo] = rate(ic) >= rate(lead) ? [ic, lead] : [lead, ic];
    const x = rate(lo) ? rate(hi) / rate(lo) : 0;
    const times = x >= 1.5 ? `${Number(x.toFixed(1))} times more` : "about as many";
    levelHead = hi === ic ? `Individual roles get ${times} interviews` : `Lead roles get ${times} interviews`;
    levelSay = (hi === ic ? lead.b > ic.b : ic.b > lead.b)
      ? `You applied to more ${hi === ic ? "lead" : "individual"} roles, but ${hi === ic ? "individual" : "lead"} roles worked better.`
      : `Most of your applications are already ${hi === ic ? "individual" : "lead"} roles.`;
  }
  const fam = [...s.family].filter((f) => f.b > 0).sort((x, y) => rate(y) - rate(x));
  const best = fam[0];
  const biggest = [...s.family].sort((x, y) => y.b - x.b)[0];
  const familyHead = best ? `${best.label.split(",")[0]} roles work best for you` : "No role types to compare yet";
  const familySay = biggest && best && biggest !== best
    ? `${biggest.label.split(",")[0]} roles are your biggest group. ${biggest.a} of ${biggest.b} got an interview.`
    : "Keep applying across role types to see a clearer pattern.";
  const src = [...s.source].filter((x) => x.b > 0).sort((x, y) => y.a - x.a);
  const top = src[0];
  const sourceHead = top && top.a ? (top.a === s.interviews ? `${top.label} brought all your interviews` : `${top.label} brought the most interviews`) : "No interviews yet to trace back";
  const quiet = src.find((x) => x.b >= 3 && x.a === 0);
  const sourceSay = quiet ? `${quiet.label} has no interviews yet from ${quiet.b} applications. It may be too early to judge.` : "Where roles came from, for every application you made.";
  return { levelHead, levelSay, familyHead, familySay, sourceHead, sourceSay };
}

export function readyIcRoles() {
  const ready = all<{ id: number; role: string; company: string }>("SELECT id, role, company FROM opportunities WHERE status = 'ready' ORDER BY updated_at DESC");
  const ic = ready.filter((r) => !isLead(r.role));
  const companies = [...new Set(ic.map((r) => r.company.replace(/\s*\(.*\)\s*$/, "")))];
  return { ready: ready.length, ic, companies };
}

export function outreachStats() {
  const by = Object.fromEntries(all<{ status: string; n: number }>("SELECT status, count(*) n FROM outreach GROUP BY status").map((r) => [r.status, r.n]));
  const sent = (by.note_sent ?? 0) + (by.dm_sent ?? 0) + (by.replied ?? 0) + (by.conversation ?? 0);
  const replied = (by.replied ?? 0) + (by.conversation ?? 0);
  const accepted = get<{ n: number }>("SELECT count(*) n FROM outreach WHERE accepted_at IS NOT NULL")!.n;
  const notAccepted = by.note_sent ?? 0;
  const fast = get<{ n: number }>("SELECT count(*) n FROM outreach WHERE replied_at IS NOT NULL AND sent_at IS NOT NULL AND julianday(replied_at) - julianday(sent_at) <= 1")!.n;
  const draftsFor = (statuses: string) => get<{ n: number }>(
    `SELECT count(*) n FROM outreach r JOIN opportunities o ON o.id = r.opportunity_id WHERE r.status = 'drafted' AND o.status IN (${statuses})`,
  )!.n;
  return { sent, replied, waiting: sent - replied, fast, accepted, notAccepted, drafted: by.drafted ?? 0, draftsReady: draftsFor("'ready'"), draftsClosed: draftsFor("'rejected','dropped','skipped'") };
}

/** Marks unsent drafts for closed roles as skipped. Returns how many. */
export function clearStaleDrafts() {
  return all<{ id: number }>(
    `UPDATE outreach SET status = 'skipped' WHERE status = 'drafted'
       AND opportunity_id IN (SELECT id FROM opportunities WHERE status IN ('rejected','dropped','skipped')) RETURNING id`,
  ).length;
}

export function alertFunnel() {
  const g = get<{ total: number; passed: number; applied: number; intv: number; low: number }>(
    `SELECT count(*) total, sum(status != 'skipped') passed, sum(status IN (${IN_LIST(APPLIED)})) applied,
       sum(status IN ('interviewing','offer')) intv, sum(status = 'skipped' AND skip_reason LIKE 'Low match%') low
     FROM opportunities WHERE source = 'gmail'`,
  )!;
  return { total: g.total ?? 0, passed: g.passed ?? 0, applied: g.applied ?? 0, interviews: g.intv ?? 0, lowMatch: g.low ?? 0 };
}

/** Typical days from applying to hearing back, from rejections with a known apply date. */
export function replyWindow() {
  const days = all<{ d: number }>(
    "SELECT julianday(updated_at) - julianday(date_applied) d FROM opportunities WHERE status = 'rejected' AND date_applied IS NOT NULL",
  ).map((r) => Math.round(r.d)).filter((d) => d >= 0).sort((a, b) => a - b);
  if (days.length < 2) return { lo: 7, hi: 14, n: days.length, known: false };
  const median = days[Math.floor(days.length / 2)];
  const usual = days.filter((d) => d <= median * 2);
  return { lo: usual[0], hi: usual[usual.length - 1], n: days.length, known: true };
}

export type Waiting = { id: number; company: string; role: string; days: number; late: boolean; reminded: boolean };
export function waitingForReply(): Waiting[] {
  const w = replyWindow();
  return all<{ id: number; company: string; role: string; date_applied: string; reminded: number }>(
    `SELECT o.id, o.company, o.role, o.date_applied,
       EXISTS (SELECT 1 FROM actions a WHERE a.opportunity_id = o.id AND a.status = 'open' AND a.kind IN ('follow_up','custom')) reminded
     FROM opportunities o WHERE o.status = 'applied' AND o.date_applied IS NOT NULL ORDER BY o.date_applied`,
  ).map((r) => {
    const days = -daysFrom(r.date_applied);
    return { id: r.id, company: r.company.replace(/\s*\(.*\)\s*$/, ""), role: r.role, days, late: days > w.hi, reminded: !!r.reminded };
  }).filter((r) => r.days > 0);
}

const mondayOf = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const short = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Applications per week for the last 7 weeks, then 2 weeks where replies are likely. */
export function weeklyPace(now = new Date()) {
  const thisWeek = mondayOf(now);
  const applied = all<{ date_applied: string }>("SELECT date_applied FROM opportunities WHERE date_applied IS NOT NULL").map((r) => new Date(r.date_applied + "T12:00:00"));
  const weeks = Array.from({ length: 7 }, (_, i) => {
    const start = new Date(thisWeek.getTime() - (6 - i) * 7 * DAY);
    const end = new Date(start.getTime() + 7 * DAY);
    return { label: short(start), n: applied.filter((d) => d >= start && d < end).length, current: i === 6 };
  });
  const forecast = [1, 2].map((i) => ({ label: short(new Date(thisWeek.getTime() + i * 7 * DAY)) }));
  const w = replyWindow();
  const recent = applied.filter((d) => d >= thisWeek).sort((a, b) => a.getTime() - b.getTime());
  const todayCount = applied.filter((d) => daysFrom(d.toISOString().slice(0, 10)) === 0).length;
  const range = recent.length
    ? `${short(new Date(recent[0].getTime() + w.lo * DAY))} and ${short(new Date(recent[recent.length - 1].getTime() + w.hi * DAY))}`
    : null;
  const before = weeks.slice(0, 6).reduce((s, x) => s + x.n, 0);
  return { weeks, forecast, thisWeek: weeks[6].n, today: todayCount, range, beforeSum: before };
}

export function stageCounts() {
  return Object.fromEntries(all<{ status: string; n: number }>("SELECT status, count(*) n FROM opportunities GROUP BY status").map((r) => [r.status, r.n])) as Record<string, number>;
}

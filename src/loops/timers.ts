import { kvGet, kvSet } from "../db/index.ts";

/**
 * Every timer in the lifecycle, with a default and a plain description. Changed from the
 * dashboard's Timers page; saved in the database, so a change applies on the next check.
 */
export const TIMER_SPECS = {
  replyOwedHours: { label: "Reply to a message within", unit: "hours", default: 12, min: 1, max: 168, group: "Replies" },
  packStaleHours: { label: "A prepared application goes stale after", unit: "hours", default: 48, min: 6, max: 720, group: "Before applying" },
  deadlineWarnDays: { label: "Warn before a closing date", unit: "days", default: 5, min: 1, max: 30, group: "Before applying" },
  parkedDays: { label: "Skip a role no one decided on after", unit: "days", default: 14, min: 3, max: 90, group: "Before applying" },
  firstTouchHours: { label: "After applying, reach a person within", unit: "hours", default: 24, min: 1, max: 168, group: "After applying" },
  followUp1Days: { label: "First follow-up when an application is quiet for", unit: "days", default: 7, min: 1, max: 60, group: "After applying" },
  interviewFollowUpDays: { label: "First follow-up after an interview goes quiet for", unit: "days", default: 5, min: 1, max: 60, group: "After applying" },
  followUp2Days: { label: "Second follow-up, on another channel, after", unit: "days", default: 7, min: 1, max: 60, group: "After applying" },
  closeAfterDays: { label: "Close warmly after the second follow-up by", unit: "days", default: 7, min: 1, max: 60, group: "After applying" },
  outreachFollowUpDays: { label: "Follow up on a note or DM with no reply after", unit: "days", default: 6, min: 1, max: 60, group: "Outreach" },
  warmCloseHours: { label: "When a role ends, close warmly with each person within", unit: "hours", default: 24, min: 1, max: 336, group: "After a role ends" },
  keepInTouchCloseDays: { label: "Stay in touch with people you've met every", unit: "days", default: 60, min: 7, max: 365, group: "After a role ends" },
  keepInTouchWarmDays: { label: "Stay in touch with people who've replied every", unit: "days", default: 120, min: 7, max: 365, group: "After a role ends" },
  postingRecheckHours: { label: "Re-check that postings are still open every", unit: "hours", default: 24, min: 6, max: 168, group: "Postings" },
} as const;

export type TimerKey = keyof typeof TIMER_SPECS;
export type Timers = Record<TimerKey, number>;

export const DEFAULT_TIMERS = Object.fromEntries(
  Object.entries(TIMER_SPECS).map(([k, s]) => [k, s.default]),
) as Timers;

const KEY = "timers";

export function getTimers(): Timers {
  let saved: Partial<Timers> = {};
  try { saved = JSON.parse(kvGet(KEY) ?? "{}"); } catch { /* bad value: defaults */ }
  const out = { ...DEFAULT_TIMERS };
  for (const k of Object.keys(TIMER_SPECS) as TimerKey[]) {
    const v = Number(saved[k]);
    if (Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/** Saves the timers that differ from the defaults. Values outside a timer's range are clamped. */
export function setTimers(values: Partial<Record<TimerKey, number>>): Timers {
  const current = getTimers();
  for (const [k, raw] of Object.entries(values) as [TimerKey, number][]) {
    const spec = TIMER_SPECS[k];
    if (!spec || !Number.isFinite(raw)) continue;
    current[k] = Math.min(spec.max, Math.max(spec.min, Math.round(raw)));
  }
  const diff = Object.fromEntries(Object.entries(current).filter(([k, v]) => v !== DEFAULT_TIMERS[k as TimerKey]));
  kvSet(KEY, JSON.stringify(diff));
  return current;
}

export function resetTimers(): Timers {
  kvSet(KEY, "{}");
  return { ...DEFAULT_TIMERS };
}

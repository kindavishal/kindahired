/**
 * Interviews come first. One page per interview gathers everything needed to prepare: when and
 * how to join, who you are meeting, every earlier email and LinkedIn message about the role, the
 * role and your fit, the hiring notes, your resume and cover note, and a short checklist. Home
 * shows the next interview above everything else and links here.
 */

import { TIMEZONE, env } from "../config.ts";
import { all, get } from "../db/index.ts";
import { getOpportunity, type Opportunity } from "../db/opportunities.ts";
import { getBrief, type HiringBrief } from "../pipeline/hiring-brief.ts";
import { STATUS, copyBlock, day, esc, icon, page, plural } from "./ui.ts";

export type Meeting = {
  id: number; event_id: string; opportunity_id: number | null; title: string; start_at: string; end_at: string;
  status: string; link: string | null; join_url: string | null; attendees: string | null;
};
type Person = { name: string; email: string | null; title: string | null; linkedin_url: string | null };
type Msg = { thread_id: number; channel: string; external_id: string | null; subject: string | null; from_me: number; sender: string | null; sent_at: string; body: string };

const localTime = (iso: string, o: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) =>
  new Date(iso).toLocaleString("en-GB", { ...o, ...(o.hour ? { hour12: true } : {}), timeZone: TIMEZONE }).replace(/\b(am|pm)\b/i, (m) => m.toLowerCase());
const clean = (c: string | null | undefined) => (c ?? "").replace(/\s*\(.*\)\s*$/, "");

/** "Today, 2:00 pm", "Tomorrow, 12:00 pm", "Sat 5 Dec, 12:00 pm" (your time zone). */
export function whenLabel(iso: string, now = new Date()) {
  const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const time = localTime(iso, { hour: "numeric", minute: "2-digit" });
  const d = new Date(iso);
  if (dayKey(d) === dayKey(now)) return `Today, ${time}`;
  if (dayKey(d) === dayKey(new Date(now.getTime() + 86_400_000))) return `Tomorrow, ${time}`;
  return localTime(iso);
}

/** "in 3 hours", "in 2 days", "now", "ended". */
export function countdown(m: Pick<Meeting, "start_at" | "end_at">, now = new Date()) {
  const start = new Date(m.start_at).getTime(), end = new Date(m.end_at).getTime(), t = now.getTime();
  if (t >= end) return "ended";
  if (t >= start) return "happening now";
  const mins = Math.round((start - t) / 60_000);
  if (mins < 60) return `in ${plural(mins, "minute")}`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `in ${plural(hours, "hour")}`;
  return `in ${plural(Math.round(hours / 24), "day")}`;
}

export const upcomingInterviews = (now = new Date()) =>
  all<Meeting>("SELECT * FROM meetings WHERE status != 'cancelled' AND end_at > $now ORDER BY start_at", { now: now.toISOString() });
export const pastInterviews = (now = new Date()) =>
  all<Meeting>("SELECT * FROM meetings WHERE status != 'cancelled' AND end_at <= $now ORDER BY start_at DESC LIMIT 20", { now: now.toISOString() });
export const getMeeting = (id: number) => get<Meeting>("SELECT * FROM meetings WHERE id = $id", { id });

/** Who is on the invite, matched to People where the email is known. */
export function attendeesOf(m: Meeting): Person[] {
  let list: { email: string | null; name: string | null }[] = [];
  try { list = JSON.parse(m.attendees ?? "[]"); } catch { /* no attendees */ }
  // Scheduling tools and no-reply senders are not people you are meeting.
  const robot = /^(schedule|scheduling|no-?reply|notifications?|calendar|invites?)@|(^|[@.])(greenhouse\.io|lever\.co|ashbyhq\.com|goodtime\.io|calendly\.com)$/i;
  // Your own addresses (MY_EMAILS) are not someone you are meeting; the calendar already drops the one it marks as you.
  const mine = new Set(env.myEmails);
  return list.filter((a) => a.email && !mine.has(a.email.toLowerCase()) && !robot.test(a.email)).map((a) => {
    const c = get<{ name: string; title: string | null; linkedin_url: string | null }>(
      "SELECT name, title, linkedin_url FROM contacts WHERE lower(email) = lower($e)", { e: a.email });
    const fromEmail = a.email!.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());
    return { name: c?.name ?? a.name ?? fromEmail, email: a.email, title: c?.title ?? null, linkedin_url: c?.linkedin_url ?? null };
  });
}

/** Every email and LinkedIn message about the role, newest first. */
export function conversationFor(opportunityId: number, limit = 30): Msg[] {
  return all<Msg>(
    `SELECT m.thread_id, t.channel, t.external_id, t.subject, m.from_me, m.sender, m.sent_at, m.body
     FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.opportunity_id = $o ORDER BY m.sent_at DESC LIMIT ${limit}`,
    { o: opportunityId });
}
const threadHref = (m: Pick<Msg, "channel" | "external_id">) =>
  !m.external_id ? null : m.channel === "linkedin" ? `https://www.linkedin.com/messaging/thread/${encodeURIComponent(m.external_id)}/` : `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.external_id)}`;

/** The checklist: the standard prep plus what the hiring notes and the invite add. */
function checklist(m: Meeting, o: Opportunity | undefined, people: Person[], brief: HiringBrief | null, msgs: Msg[]): string[] {
  const items: string[] = [];
  if (o?.jd_text) items.push("Re-read the job description and match two of your stories to it.");
  if (people.length) items.push(`Look up ${people.map((p) => p.name).join(" and ")}: role, recent posts, anything you share.`);
  const theirLast = msgs.find((x) => !x.from_me);
  if (theirLast) items.push(`Re-read their last message (${day(theirLast.sent_at)}) so you pick up where you left off.`);
  for (const a of brief?.angles?.slice(0, 2) ?? []) items.push(`Bring up: ${a}`);
  const q = brief?.open_questions?.slice(0, 2) ?? [];
  items.push(q.length ? `Ask them: ${q.join(" Also: ")}` : "Have two questions ready about the team and what success looks like in 90 days.");
  if (m.join_url) items.push("Test the call link, your mic and camera 10 minutes before.");
  return items;
}

/** The card Home shows above everything else when an interview is coming up. */
export function interviewCard(m: Meeting, now = new Date()) {
  const o = m.opportunity_id ? getOpportunity(m.opportunity_id) : undefined;
  const people = attendeesOf(m);
  const last = o ? conversationFor(o.id, 1)[0] : undefined;
  const soon = new Date(m.start_at).getTime() - now.getTime() < 90 * 60_000;
  const close = new Date(m.start_at).getTime() - now.getTime() < 3 * 86_400_000;
  return `<section class="interview-card${close ? " close" : ""}" aria-labelledby="iv-${m.id}">
<h2 id="iv-${m.id}" class="interview-title">${esc(o ? `${o.role} at ${clean(o.company)}` : m.title)}</h2>
<p class="interview-when">${icon("calendar")}Interview ${esc(countdown(m, now))} · ${esc(whenLabel(m.start_at, now))}</p>
<p class="interview-sub">${esc(m.title)}${people.length ? ` · with ${esc(people.map((p) => p.name).join(", "))}` : ""}</p>
${last ? `<p class="interview-last"><span class="interview-last-label">Last message, ${esc(day(last.sent_at))}, ${last.from_me ? "you wrote" : `${esc(last.sender?.replace(/<.*>/, "").trim() || "they")} wrote`}:</span> ${esc(last.body.replace(/\s+/g, " ").slice(0, 180))}${last.body.length > 180 ? "…" : ""}</p>` : ""}
<div class="btn-row"><a class="btn primary" href="/interviews/${m.id}">Open interview prep</a>${m.join_url ? `<a class="btn${soon ? " primary" : ""}" href="${esc(m.join_url)}" target="_blank" rel="noopener">Join the call${icon("external")}</a>` : ""}${m.link ? `<a class="btn quiet" href="${esc(m.link)}" target="_blank" rel="noopener">Calendar${icon("external")}</a>` : ""}</div>
</section>`;
}

export function interviewPage(id: number, now = new Date()) {
  const m = getMeeting(id);
  if (!m) return null;
  const o = m.opportunity_id ? getOpportunity(m.opportunity_id) : undefined;
  const people = attendeesOf(m);
  const brief = o ? getBrief(o) : null;
  const msgs = o ? conversationFor(o.id) : [];
  const rounds = o ? all<Meeting>("SELECT * FROM meetings WHERE opportunity_id = $o AND id != $id AND status != 'cancelled' ORDER BY start_at", { o: o.id, id }) : [];
  const past = countdown(m, now) === "ended";
  const steps = checklist(m, o, people, brief, msgs);

  const who = people.length || brief?.people?.length ? `<section class="card" aria-labelledby="h-who"><h2 id="h-who" class="card-title">Who you are meeting</h2>
<ul class="mini-list">${people.map((p) => `<li class="mini-row"><span><span class="mini-title">${esc(p.name)}</span><span class="mini-sub">${esc([p.title, p.email].filter(Boolean).join(" · "))}</span></span>${p.linkedin_url ? `<a class="btn sm" href="${esc(p.linkedin_url)}" target="_blank" rel="noopener">LinkedIn${icon("external")}</a>` : ""}</li>`).join("")}
${(brief?.people ?? []).filter((b) => !people.some((p) => p.name.toLowerCase() === b.name.toLowerCase())).slice(0, 3).map((b) => `<li class="mini-row"><span><span class="mini-title">${esc(b.name)}</span><span class="mini-sub">${esc([b.title, "from the hiring notes"].filter(Boolean).join(" · "))}</span></span>${b.linkedin_url ? `<a class="btn quiet sm" href="${esc(b.linkedin_url)}" target="_blank" rel="noopener">LinkedIn${icon("external")}</a>` : ""}</li>`).join("")}</ul></section>` : "";

  const convo = `<section class="card" aria-labelledby="h-convo"><div class="card-head"><h2 id="h-convo" class="card-title">Your conversation so far</h2><p class="card-sub">${msgs.length ? `${plural(msgs.length, "message")} about this role, newest first.` : "No emails or LinkedIn messages are linked to this role yet."}</p></div>
${msgs.length ? `<ol class="convo">${msgs.map((x) => { const href = threadHref(x); return `<li class="convo-item${x.from_me ? " mine" : ""}"><p class="convo-meta"><span class="mini-title">${x.from_me ? "You" : esc(x.sender?.replace(/<.*>/, "").trim() || "They")}</span><span>${esc(localTime(x.sent_at))} · ${x.channel === "linkedin" ? "LinkedIn" : "Email"}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">Open${icon("external")}</a>` : ""}</p>${x.subject && x.channel !== "linkedin" ? `<p class="convo-subject">${esc(x.subject)}</p>` : ""}<p class="convo-body">${esc(x.body.trim().slice(0, 1200))}${x.body.length > 1200 ? "…" : ""}</p></li>`; }).join("")}</ol>` : ""}</section>`;

  const role = o ? `<section class="card" aria-labelledby="h-role"><div class="card-head"><h2 id="h-role" class="card-title">The role and your fit</h2><p class="card-sub">${esc(STATUS[o.status]?.label ?? o.status)}${o.date_applied ? ` · applied ${esc(day(o.date_applied))}` : ""}${o.pay ? ` · ${esc(o.pay)}` : ""}</p></div>
${o.fit_read ? `<p class="prose">${esc(o.fit_read)}</p>` : ""}
${brief?.team ? `<p class="prose"><strong>Team:</strong> ${esc(brief.team)}</p>` : ""}
${brief?.signals?.length ? `<div><p class="mini-title">Recent signals</p><ul class="plain-list">${brief.signals.slice(0, 4).map((x) => `<li>${esc(x.what)}${x.date ? ` <span class="muted">· ${esc(x.date)}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
${o.company_brief ? `<details class="fold"><summary>About ${esc(clean(o.company))}</summary><p class="prose">${esc(o.company_brief)}</p></details>` : ""}
${o.jd_text ? `<details class="fold"><summary>Job description</summary><p class="prose">${esc(o.jd_text)}</p></details>` : ""}
<div class="btn-row"><a class="btn" href="/o/${o.id}">Open the role</a>${o.resume_path ? `<a class="btn" href="/resume/${o.id}" target="_blank" rel="noopener">Your resume (PDF)${icon("external")}</a>` : ""}${o.apply_url ? `<a class="btn quiet" href="${esc(o.apply_url)}" target="_blank" rel="noopener">The posting${icon("external")}</a>` : ""}</div></section>` : "";

  return page(`Interview · ${o ? clean(o.company) : m.title} · kindahired`, `
<div class="vstack page-stack-sm interview-page">
<a class="back" href="/interviews">${icon("back")}Interviews</a>
<div class="interview-head">
<h1>${esc(o ? `${o.role} at ${clean(o.company)}` : m.title)}</h1>
<p class="interview-when">${icon("calendar")}${past ? "This interview has ended" : `Interview ${esc(countdown(m, now))}`} · ${esc(localTime(m.start_at, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }))}</p>
<p class="lede">${esc(m.title)}${people.length ? ` with ${esc(people.map((p) => p.name).join(", "))}` : ""}.${rounds.length ? ` Round ${rounds.filter((r) => r.start_at < m.start_at).length + 1} of the ${rounds.length + 1} on your calendar.` : ""}</p>
${past ? "" : `<div class="btn-row">${m.join_url ? `<a class="btn primary" href="${esc(m.join_url)}" target="_blank" rel="noopener">Join the call${icon("external")}</a>` : ""}${m.link ? `<a class="btn" href="${esc(m.link)}" target="_blank" rel="noopener">Open in Calendar${icon("external")}</a>` : ""}</div>`}
</div>
<div class="interview-grid">
<div class="vstack">
${past ? "" : `<section class="card" aria-labelledby="h-prep"><h2 id="h-prep" class="card-title">Prepare</h2><ol class="prep-list">${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>`}
${convo}
${role}
</div>
<aside class="vstack">
${who}
${o?.cover_note ? copyBlock("Your cover note", o.cover_note, "h3") : ""}
${rounds.length ? `<section class="card"><h2 class="card-title">Other rounds</h2><ul class="mini-list">${rounds.map((r) => `<li class="mini-row"><span><a class="mini-title" href="/interviews/${r.id}">${esc(r.title)}</a><span class="mini-sub">${esc(localTime(r.start_at))}</span></span></li>`).join("")}</ul></section>` : ""}
</aside>
</div></div>`, { tab: "interviews" });
}

export function interviewsPage(now = new Date()) {
  const up = upcomingInterviews(now);
  const past = pastInterviews(now);
  const row = (m: Meeting) => {
    const o = m.opportunity_id ? getOpportunity(m.opportunity_id) : undefined;
    return `<li class="mini-row interview-row"><span><a class="mini-title" href="/interviews/${m.id}">${esc(o ? `${o.role} at ${clean(o.company)}` : m.title)}</a><span class="mini-sub">${esc(m.title)} · ${esc(localTime(m.start_at))} IST</span></span><span class="chip${countdown(m, now).startsWith("in") && new Date(m.start_at).getTime() - now.getTime() < 2 * 86_400_000 ? " warn" : ""}">${esc(countdown(m, now))}</span></li>`;
  };
  return page("Interviews · kindahired", `
<div class="vstack page-stack-sm interview-page">
<h1>Interviews</h1>
<section class="card"><h2 class="card-title">Coming up</h2>${up.length ? `<ul class="mini-list">${up.map(row).join("")}</ul>` : `<p class="card-sub">Nothing on your Google Calendar.</p>`}</section>
${past.length ? `<section class="card"><h2 class="card-title">Earlier</h2><ul class="mini-list">${past.map(row).join("")}</ul></section>` : ""}
</div>`, { tab: "interviews" });
}

export const upcomingCount = (now = new Date()) => upcomingInterviews(now).length;

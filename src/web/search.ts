/**
 * One search for everything the dashboard can reach: roles, target companies, people, open tasks,
 * watched pages and the dashboard's own pages. A pasted link turns into the right next step:
 * make a pack from a posting, watch a job board or careers page, or open what is already tracked.
 * Used by the ⌘K dialog (JSON) and by the /search page (works without JavaScript).
 */

import { all } from "../db/index.ts";
import { BOARD_LABEL, parseBoard } from "../pipeline/companies.ts";
import { STATUS, esc } from "./ui.ts";

export type Hit = {
  group: "Link" | "Do" | "Roles" | "Companies" | "People" | "Tasks" | "Job pages to check" | "Go to";
  label: string;
  sub?: string;
  icon: string;
  /** Opens a page. */
  href?: string;
  /** Or posts a form (adding a link, watching a page, adding a company). */
  post?: { action: string; fields: Record<string, string> };
};

const PAGES: { label: string; href: string; icon: string; words: string }[] = [
  { label: "Home", href: "/", icon: "home", words: "home today next focus" },
  { label: "All tasks", href: "/tasks", icon: "list", words: "tasks todo to do list everything" },
  { label: "Pending tasks", href: "/tasks?filter=pending", icon: "list", words: "pending overdue late" },
  { label: "Applications due", href: "/tasks?filter=applications", icon: "list", words: "applications apply due" },
  { label: "Roles ready to apply", href: "/list?status=ready", icon: "briefcase", words: "ready apply roles jobs" },
  { label: "Roles you applied to", href: "/list?status=applied", icon: "briefcase", words: "applied waiting roles jobs" },
  { label: "Roles in interviews", href: "/list?status=interviewing", icon: "briefcase", words: "interview interviewing roles" },
  { label: "All roles", href: "/list?status=all", icon: "briefcase", words: "roles jobs listings postings all" },
  { label: "Interviews", href: "/interviews", icon: "calendar", words: "interviews calls meetings prep prepare" },
  { label: "What is working", href: "/insights", icon: "chart", words: "insights working stats analytics data" },
  { label: "Progress", href: "/progress", icon: "activity", words: "progress pipeline stages weekly" },
  { label: "People", href: "/people", icon: "users", words: "people contacts network" },
  { label: "Companies", href: "/companies", icon: "building", words: "companies targets boards" },
  { label: "Job pages to check", href: "/sources", icon: "eye", words: "job pages to check watched pages sources boards careers" },
  { label: "Reminder timings", href: "/timers", icon: "timer", words: "timers reminders settings timings" },
];

const like = (q: string) => `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
const clean = (c: string | null) => (c ?? "").replace(/\s*\(.*\)\s*$/, "");

export function isLink(q: string) {
  return /^(https?:\/\/|www\.)\S+$/i.test(q.trim()) || /^[\w-]+(\.[\w-]+)+\/\S*$/i.test(q.trim());
}
const asUrl = (q: string) => (/^https?:\/\//i.test(q) ? q : `https://${q}`);

/** What kind of page a link probably is. */
export function linkKind(url: string): "posting" | "board" | "profile" | "post" | "page" {
  const u = url.toLowerCase();
  if (/linkedin\.com\/in\//.test(u)) return "profile";
  if (/(x|twitter)\.com\/[^/]+\/status\/|linkedin\.com\/(posts|feed\/update)\//.test(u)) return "post";
  if (/linkedin\.com\/jobs\/view\/|\/jobs?\/[\w-]*\d|\/job\/|\/positions?\/|\/openings?\/|[?&](gh_jid|jobid|job_id|jid)=|lever\.co\/[^/]+\/[0-9a-f-]{8,}|ashbyhq\.com\/[^/]+\/[0-9a-f-]{8,}|workable\.com\/[^/]+\/j\//.test(u)) return "posting";
  if (parseBoard(url) || /\/(careers|jobs|join|work-with-us|openings)\/?(\?.*)?$/.test(u)) return "board";
  return "page";
}

function linkHits(q: string): Hit[] {
  const url = asUrl(q.trim());
  const hits: Hit[] = [];
  const bare = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  const known = all<{ id: number; role: string; company: string; status: string }>(
    "SELECT id, role, company, status FROM opportunities WHERE apply_url LIKE $u ESCAPE '\\' OR source_url LIKE $u ESCAPE '\\' LIMIT 3", { u: like(bare) });
  for (const o of known) hits.push({ group: "Link", label: `Already tracked: ${o.role}`, sub: `${clean(o.company)} · ${STATUS[o.status]?.label ?? o.status}`, icon: "briefcase", href: `/o/${o.id}` });
  const person = all<{ id: number; name: string }>("SELECT id, name FROM contacts WHERE linkedin_url LIKE $u ESCAPE '\\' LIMIT 1", { u: like(bare) })[0];
  if (person) hits.push({ group: "Link", label: `Already in People: ${person.name}`, icon: "users", href: `/people?q=${encodeURIComponent(person.name)}` });
  const watched = all<{ id: number; label: string }>("SELECT id, label FROM sources WHERE url LIKE $u ESCAPE '\\' LIMIT 1", { u: like(bare) })[0];
  if (watched) hits.push({ group: "Link", label: `Already watched: ${watched.label}`, icon: "eye", href: "/sources" });

  const kind = linkKind(url);
  const board = parseBoard(url);
  const pack: Hit = { group: "Link", label: "Prepare an application for this posting", sub: "Fit read, resume, cover note and people to contact, sent to Telegram", icon: "plus-circle", post: { action: "/add", fields: { url } } };
  const watch: Hit = { group: "Link", label: "Watch this page for new roles", sub: "Checked every 6 hours; roles that fit reach Telegram", icon: "eye", post: { action: "/sources", fields: { url, interval: "6" } } };
  const company: Hit | null = board
    ? { group: "Link", label: `Add ${board.slug} as a target company`, sub: `Watch their ${BOARD_LABEL[board.type]} board`, icon: "building", post: { action: "/companies", fields: { names: board.slug, link: url } } }
    : null;
  if (!known.length) {
    if (kind === "board") hits.push(...[company, watch, pack].filter((h): h is Hit => !!h));
    else if (kind === "profile") hits.push({ group: "Link", label: "Open their LinkedIn profile", icon: "external", href: url });
    else if (kind === "post") hits.push({ ...pack, label: "Add the roles in this post", sub: "Reads the post and its replies, files each role and watches the thread" });
    else hits.push(pack, ...(kind === "page" ? [watch] : []), ...(company ? [company] : []));
  }
  return hits;
}

export function searchAll(raw: string): Hit[] {
  const q = raw.trim();
  if (!q) return PAGES.slice(0, 8).map((p) => ({ group: "Go to", label: p.label, icon: p.icon, href: p.href }));
  if (isLink(q)) return linkHits(q);
  const l = like(q);
  const hits: Hit[] = [];

  for (const o of all<{ id: number; role: string; company: string; status: string; closes_on: string | null }>(
    `SELECT id, role, company, status, closes_on FROM opportunities
     WHERE (role LIKE $l ESCAPE '\\' OR company LIKE $l ESCAPE '\\')
     ORDER BY CASE status WHEN 'interviewing' THEN 0 WHEN 'offer' THEN 0 WHEN 'ready' THEN 1 WHEN 'applied' THEN 2 WHEN 'decide' THEN 3 WHEN 'found' THEN 4 ELSE 9 END, updated_at DESC LIMIT 5`, { l })) {
    hits.push({ group: "Roles", label: o.role, sub: `${clean(o.company)} · ${STATUS[o.status]?.label ?? o.status}`, icon: "briefcase", href: `/o/${o.id}` });
  }
  const companies = all<{ id: number; name: string; status: string; needs_check: number }>(
    "SELECT id, name, status, needs_check FROM companies WHERE name LIKE $l ESCAPE '\\' ORDER BY lower(name) LIMIT 4", { l });
  for (const c of companies) {
    hits.push({ group: "Companies", label: c.name, sub: c.needs_check ? "Needs your check" : c.status === "paused" ? "Paused" : "Watched", icon: "building", href: `/companies?q=${encodeURIComponent(c.name)}` });
  }
  for (const p of all<{ id: number; name: string; title: string | null; company: string | null }>(
    `SELECT c.id, c.name, c.title, (SELECT o.company FROM outreach r JOIN opportunities o ON o.id = r.opportunity_id WHERE r.contact_id = c.id ORDER BY r.id DESC LIMIT 1) company
     FROM contacts c WHERE c.name LIKE $l ESCAPE '\\' OR c.title LIKE $l ESCAPE '\\' OR c.email LIKE $l ESCAPE '\\' ORDER BY lower(c.name) LIMIT 4`, { l })) {
    hits.push({ group: "People", label: p.name, sub: [p.title, clean(p.company)].filter(Boolean).join(" · ") || undefined, icon: "users", href: `/people?show=all&q=${encodeURIComponent(p.name)}` });
  }
  for (const a of all<{ id: number; title: string; opportunity_id: number | null }>(
    "SELECT id, title, opportunity_id FROM actions WHERE status = 'open' AND title LIKE $l ESCAPE '\\' ORDER BY due_at LIMIT 3", { l })) {
    hits.push({ group: "Tasks", label: a.title, icon: "list", href: a.opportunity_id ? `/o/${a.opportunity_id}` : "/tasks" });
  }
  for (const s of all<{ id: number; label: string; url: string }>(
    "SELECT id, label, url FROM sources WHERE label LIKE $l ESCAPE '\\' OR url LIKE $l ESCAPE '\\' LIMIT 3", { l })) {
    hits.push({ group: "Job pages to check", label: s.label, sub: s.url, icon: "eye", href: "/sources" });
  }
  const words = q.toLowerCase().split(/\s+/);
  for (const p of PAGES.filter((x) => words.every((w) => `${x.label} ${x.words}`.toLowerCase().includes(w))).slice(0, 4)) {
    hits.push({ group: "Go to", label: p.label, icon: p.icon, href: p.href });
  }
  // Actions on the words typed.
  const roles = hits.filter((h) => h.group === "Roles").length;
  if (roles) hits.push({ group: "Do", label: `See all roles matching “${q}”`, icon: "search", href: `/list?status=all&q=${encodeURIComponent(q)}` });
  if (!companies.some((c) => c.name.toLowerCase() === q.toLowerCase()) && q.length >= 2 && q.length <= 60) {
    hits.push({ group: "Do", label: `Watch “${q}” as a target company`, sub: "Finds their job board and checks it every few hours", icon: "building", post: { action: "/companies", fields: { names: q } } });
  }
  return hits;
}

/** The same results as a plain page, for when JavaScript is off. */
export function searchPageBody(q: string, hits: Hit[], icon: (n: string) => string) {
  const groups = [...new Set(hits.map((h) => h.group))];
  const item = (h: Hit) => {
    const inner = `${icon(h.icon)}<span class="cmd-item-body"><span class="cmd-item-text">${esc(h.label)}</span>${h.sub ? `<span class="cmd-item-sub">${esc(h.sub)}</span>` : ""}</span>`;
    return h.post
      ? `<li><form method="post" action="${esc(h.post.action)}">${Object.entries(h.post.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button class="cmd-item">${inner}</button></form></li>`
      : `<li><a class="cmd-item" href="${esc(h.href ?? "/")}">${inner}</a></li>`;
  };
  return `<div class="vstack page-stack-sm search-page">
<div><h1>Search</h1><p class="lede">Find roles, companies, people and tasks, or paste a link to a posting, a job board or a careers page.</p></div>
<form method="get" action="/search" class="search-page-form"><label class="sr" for="sp-q">Search or paste a link</label><input id="sp-q" type="search" name="q" value="${esc(q)}" placeholder="Search or paste a link" autofocus class="full"><button class="btn primary">Search</button></form>
${hits.length ? groups.map((g) => `<section class="panel"><p class="cmd-group">${esc(g)}</p><ul class="cmd-results">${hits.filter((h) => h.group === g).map(item).join("")}</ul></section>`).join("")
    : `<div class="panel"><div class="empty"><p class="empty-title">Nothing matches “${esc(q)}”.</p><p>Try part of a name or company, or paste a link.</p></div></div>`}
</div>`;
}

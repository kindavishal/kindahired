/**
 * Shared look for the local dashboard: design tokens (shadcn/ui neutral), the sidebar shell,
 * components, icons and the small progressive-enhancement script. Every page works without
 * JavaScript; the script adds in-place actions, undo, selection, shortcuts and the ⌘K dialog.
 * See DESIGN.md.
 */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const asDate = (iso: string) => new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
export const day = (iso: string | null) => (iso ? asDate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** Whole calendar days from today to `iso` (negative = in the past). */
export const daysFrom = (iso: string, now = new Date()) => Math.round((startOfDay(asDate(iso)) - startOfDay(now)) / DAY);

/** "Pending for 3 days", "Pending since 4 Sept", "Due today", "Due tomorrow", "Due 4 Dec". */
export function dueLabel(iso: string, now = new Date()): { text: string; tone: "danger" | "warn" | "" } {
  const d = daysFrom(iso, now);
  if (d < -30) return { text: `Pending since ${day(iso)}`, tone: "danger" };
  if (d < -1) return { text: `Pending for ${-d} days`, tone: "danger" };
  if (d === -1) return { text: "Pending since yesterday", tone: "danger" };
  if (d === 0) return { text: "Due today", tone: "warn" };
  if (d === 1) return { text: "Due tomorrow", tone: "" };
  return { text: `Due ${day(iso)}`, tone: "" };
}

/** "Closes in 3 days" with a tone once the deadline is close. */
export function closesLabel(iso: string | null, now = new Date()): { text: string; tone: "danger" | "warn" | "" } | null {
  if (!iso) return null;
  const d = daysFrom(iso, now);
  if (d < 0) return { text: `Closed ${day(iso)}`, tone: "" };
  if (d === 0) return { text: "Closes today", tone: "danger" };
  if (d <= 5) return { text: `Closes in ${d} day${d === 1 ? "" : "s"}`, tone: "warn" };
  return { text: `Closes ${day(iso)}`, tone: "" };
}

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---------- vocabulary ----------

export const STATUS: Record<string, { label: string; tone: string }> = {
  found: { label: "Found", tone: "neutral" },
  decide: { label: "To decide", tone: "warn" },
  ready: { label: "Ready to apply", tone: "accent" },
  applied: { label: "Applied", tone: "accent-outline" },
  interviewing: { label: "Interviewing", tone: "ok" },
  offer: { label: "Offer", tone: "ok-strong" },
  rejected: { label: "Rejected", tone: "muted" },
  dropped: { label: "Dropped", tone: "muted" },
  skipped: { label: "Skipped", tone: "muted" },
};
export const FIT: Record<string, { label: string; tone: string }> = {
  apply: { label: "Strong fit", tone: "ok" },
  stretch: { label: "Stretch", tone: "warn" },
  skip: { label: "Not a fit", tone: "muted" },
};
const SOURCE: Record<string, string> = {
  gmail: "Email alerts",
  linkedin_saved: "LinkedIn saved",
  sheet_import: "Tracker sheet",
  manual: "Added by you",
  telegram: "Telegram",
  cli: "Terminal",
  web: "Dashboard",
  "x:search": "X search",
  "x:bookmarks": "X bookmarks",
  "x:thread": "X thread",
  "x:account": "X accounts",
};
export const sourceLabel = (s: string | null) =>
  !s ? "Unknown" : s.startsWith("watch:") ? s.slice(6) : s.startsWith("company:") ? `${s.slice(8)} job board` : SOURCE[s] ?? s.replace(/[_:]/g, " ");

export const badge = (label: string, tone = "neutral") => `<span class="badge t-${tone}">${esc(label)}</span>`;
export const statusBadge = (s: string) => badge(STATUS[s]?.label ?? s, STATUS[s]?.tone);
export const fitBadge = (f: string | null) => (f && FIT[f] ? badge(FIT[f].label, FIT[f].tone) : "");

// ---------- icons (24px grid, 1.75 stroke) ----------

const PATHS: Record<string, string> = {
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  download: '<path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 20h14"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.5"/>',
  bookmark: '<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v2M12 10v7M17 6v11"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M10 6h4M10 10h4M10 14h4M10 18h4"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  timer: '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
  "plus-circle": '<circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.8 7L3 20l1.1-5A8 8 0 1 1 21 12z"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
};
export const icon = (name: keyof typeof PATHS | string) =>
  `<svg class="i" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;

// ---------- components ----------

export type BtnOpts = { variant?: "primary" | "default" | "quiet" | "danger"; inline?: boolean; confirm?: string; hidden?: Record<string, string>; title?: string };
/** A one-button POST form. `inline` lets the script submit it in place, without a reload. */
export function postButton(action: string, label: string, o: BtnOpts = {}) {
  const hidden = Object.entries(o.hidden ?? {}).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<form method="post" action="${esc(action)}"${o.inline ? " data-inline" : ""}${o.confirm ? ` data-confirm="${esc(o.confirm)}"` : ""}>${hidden}<button class="btn ${o.variant ?? "default"}"${o.title ? ` title="${esc(o.title)}"` : ""}>${label}</button></form>`;
}

export const linkButton = (href: string, label: string, variant = "default", external = false) =>
  `<a class="btn ${variant}" href="${esc(href)}"${external ? ` target="_blank" rel="noopener"` : ""}>${label}</a>`;

let copySeq = 0;
/** A copy-ready draft: label, monospace text, Copy button. */
export function copyBlock(title: string, text: string | null, level: "h2" | "h3" = "h2") {
  if (!text) return "";
  const id = `copy-${++copySeq}`;
  return `<section class="copy-block"><div class="copy-head"><${level}>${esc(title)}</${level}>
<button type="button" class="btn quiet sm" data-copy="${id}">${icon("copy")}<span>Copy</span></button></div>
<pre id="${id}">${esc(text)}</pre></section>`;
}

export const emptyState = (title: string, body = "") =>
  `<div class="empty"><p class="empty-title">${esc(title)}</p>${body ? `<p>${body}</p>` : ""}</div>`;

// ---------- shell ----------

export type Tab = "home" | "tasks" | "interviews" | "insights" | "progress" | "roles" | "people" | "companies" | "sources" | "timers" | "setup" | "";

/** Counts shown in the sidebar. The server registers a provider so every page shows live numbers. */
export type NavCounts = { pending: number; roles: number; interviews?: number };
let navCounts: () => NavCounts = () => ({ pending: 0, roles: 0 });
export const setNavCounts = (fn: () => NavCounts) => { navCounts = fn; };
let shellPort = 4321;
export const setShellPort = (p: number) => { shellPort = p; };

const TAB_TITLE: Record<Tab, string> = {
  home: "Home", tasks: "All tasks", interviews: "Interviews", insights: "What is working", progress: "Progress", roles: "Roles", people: "People",
  companies: "Companies", sources: "Watched pages", timers: "Reminder timings", setup: "Setup", "": "",
};

type PageOpts = { tab?: Tab; port?: number; flash?: string | null; wide?: boolean; meta?: string };
export function page(title: string, body: string, o: PageOpts = {}) {
  const n = navCounts();
  const link = (key: Tab, href: string, ico: string, label: string, tail = "") =>
    `<a href="${href}"${o.tab === key ? ` aria-current="page"` : ""}>${icon(ico)}<span class="nav-text">${label}</span>${tail}</a>`;
  const nav = `<nav class="nav" aria-label="Sections">
${link("home", "/", "home", "Home")}
${link("tasks", "/tasks", "list", "All tasks", n.pending ? `<span class="nav-badge num" title="${n.pending} pending from earlier days">${n.pending}</span>` : "")}
${link("interviews", "/interviews", "calendar", "Interviews", n.interviews ? `<span class="nav-count num">${n.interviews} upcoming</span>` : "")}
${link("insights", "/insights", "chart", "What is working")}
${link("progress", "/progress", "activity", "Progress")}
${link("roles", "/list", "briefcase", "Roles", `<span class="nav-count num">${n.roles}</span>`)}
${link("people", "/people", "users", "People")}
${link("companies", "/companies", "building", "Companies")}
</nav>
<p class="nav-label">Settings</p>
<nav class="nav" aria-label="Settings">
${link("sources", "/sources", "eye", "Watched pages")}
${link("timers", "/timers", "timer", "Reminder timings")}
${process.env.JH_HUB === "1" ? link("setup", "/setup", "check", "Setup") : ""}
</nav>`;
  const heading = o.tab ? TAB_TITLE[o.tab] : title.replace(/ · kindahired$/, "");
  return `<!doctype html><html lang="en" class="no-js"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#171717"/><path d="M9 17l4.5 4.5L23 11" stroke="#fafafa" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>')}">
<style>${CSS}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
<aside class="sidebar" aria-label="kindahired">
<a class="brand" href="/">${icon("briefcase")}kindahired</a>
<a class="btn primary block" href="/search" data-cmd>${icon("plus-circle")}<span class="nav-text">Add a job link</span><kbd class="kbd on-dark">⌘K</kbd></a>
${nav}
<p class="sidebar-foot">Drag <a class="bookmarklet" href="javascript:void(window.open('http://127.0.0.1:${o.port ?? shellPort}/add?url='+encodeURIComponent(location.href)))">${icon("bookmark")}Save job</a> to your bookmarks bar to save roles from any page.</p>
</aside>
<div class="inset">
<header class="topbar">
<details class="mnav"><summary class="btn quiet sm" aria-label="Menu">${icon("menu")}</summary><div class="mnav-panel">${nav}</div></details>
<span class="topbar-title">${esc(heading)}</span>${o.meta ? `<span class="topbar-meta">· ${esc(o.meta)}</span>` : ""}
<a class="btn topbar-search" href="/search" data-cmd><span class="topbar-search-text">${icon("search")}<span>Search or paste a link</span></span><kbd class="kbd">⌘K</kbd></a>
</header>
<main id="main" class="wrap">${body}</main>
</div>
</div>
<dialog class="cmd" id="cmd" aria-label="Search or paste a link">
<form method="get" action="/search" class="cmd-form">
<div class="cmd-input">${icon("search")}<label class="sr" for="cmd-q">Search or paste a link</label>
<input id="cmd-q" type="search" name="q" placeholder="Search roles, companies, people and tasks, or paste a link" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="cmd-results" aria-autocomplete="list"><kbd class="kbd">Esc</kbd></div>
<div class="cmd-list" id="cmd-results" role="listbox" aria-label="Results"></div>
<p class="cmd-foot"><span><kbd class="kbd">↑</kbd> <kbd class="kbd">↓</kbd> move</span><span><kbd class="kbd">↵</kbd> open</span><span>Paste a posting, job board, careers page or post to add it</span></p>
</form></dialog>
<div class="toast-region" aria-live="polite" aria-atomic="true"><div class="toast" hidden><span class="toast-text"></span><button type="button" class="btn primary sm toast-undo" hidden>Undo</button></div></div>
${o.flash ? `<script>window.__flash=${JSON.stringify(o.flash).replace(/</g, "\\u003c")}</script>` : ""}
<script>${JS}</script></body></html>`;
}

// ---------- styles ----------
// Tokens follow the shadcn/ui neutral theme. The dashboard is local-only, so the platform sans
// stands in for Geist (no web fonts). Components below are the only place values live.

const CSS = `
:root{
--bg:#fafafa;--surface:#fff;--surface-2:#f5f5f5;--hover:#f0f0f0;--selected:#ececec;
--ink:#0a0a0a;--ink-2:#525252;--ink-3:#6b6b6b;--line:#e5e5e5;--line-strong:#d4d4d4;
--accent:#171717;--accent-hover:#2a2a2a;--accent-ink:#fafafa;--accent-soft:#f5f5f5;
--info:#1d4ed8;--info-dot:#2563eb;--info-soft:#eff6ff;
--danger:#c10007;--danger-solid:#e7000b;--danger-soft:#fef2f2;
--warn:#92400e;--warn-dot:#f59e0b;--warn-soft:#fef3c7;
--ok:#15803d;--ok-dot:#16a34a;--ok-soft:#f0fdf4;
--chart-strong:#171717;--chart-mid:#a3a3a3;--chart-soft:#d4d4d4;--chart-track:#f5f5f5;--chart-band:#fde68a;
--overlay:rgb(0 0 0 / .5);
--r-xs:4px;--r-sm:6px;--r-md:8px;--r-lg:10px;--r-xl:12px;--r-full:999px;
--shadow-xs:0 1px 2px 0 rgb(0 0 0 / .05);--shadow-sm:0 1px 3px 0 rgb(0 0 0 / .1),0 1px 2px -1px rgb(0 0 0 / .1);
--shadow-md:0 4px 6px -1px rgb(0 0 0 / .1),0 2px 4px -2px rgb(0 0 0 / .1);--shadow-lg:0 10px 15px -3px rgb(0 0 0 / .1),0 4px 6px -4px rgb(0 0 0 / .1);
--ring:0 0 0 3px rgb(161 161 161 / .5);
--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:20px;--s6:24px;--s8:32px;--s10:40px;--s12:48px;
--t-xs:12px;--t-sm:13px;--t-base:14px;--t-md:15px;--t-lg:17px;--t-xl:24px;--t-stat:28px;
--sidebar-w:240px;--aside-w:340px;--content-max:1440px;--control:32px;--control-sm:28px;
--ease:cubic-bezier(.2,.8,.2,1);
--sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
color-scheme:light}
@media (prefers-color-scheme:dark){:root{
--bg:#0a0a0a;--surface:#171717;--surface-2:#262626;--hover:#262626;--selected:#2e2e2e;
--ink:#fafafa;--ink-2:#d4d4d4;--ink-3:#a3a3a3;--line:#2e2e2e;--line-strong:#404040;
--accent:#fafafa;--accent-hover:#e5e5e5;--accent-ink:#171717;--accent-soft:#262626;
--info:#93c5fd;--info-dot:#60a5fa;--info-soft:#172554;
--danger:#fca5a5;--danger-solid:#dc2626;--danger-soft:#2a1215;
--warn:#fcd34d;--warn-dot:#f59e0b;--warn-soft:#2a2108;
--ok:#86efac;--ok-dot:#4ade80;--ok-soft:#0f2a17;
--chart-strong:#fafafa;--chart-mid:#737373;--chart-soft:#404040;--chart-track:#262626;--chart-band:#854d0e;
--shadow-sm:0 1px 3px 0 rgb(0 0 0 / .5);--ring:0 0 0 3px rgb(115 115 115 / .6);color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;scrollbar-color:var(--line-strong) transparent}
body{margin:0;background:var(--bg);color:var(--ink);font:400 var(--t-base)/20px var(--sans);-webkit-font-smoothing:antialiased;caret-color:var(--ink)}
::selection{background:var(--selected);color:var(--ink)}
a{color:var(--ink);text-decoration:none;text-underline-offset:4px}a:hover{text-decoration:underline}
:focus-visible{outline:none;box-shadow:var(--ring);border-radius:var(--r-sm)}
h1,h2,h3,h4{margin:0;text-wrap:balance;overflow-wrap:anywhere}
h1{font-size:var(--t-xl);line-height:30px;font-weight:600;letter-spacing:-.015em}
h2{font-size:var(--t-lg);line-height:24px;font-weight:600}
h3{font-size:var(--t-md);line-height:22px;font-weight:600}
p{margin:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-999px;top:8px;z-index:40;background:var(--surface);padding:8px 12px;border-radius:var(--r-md)}.skip:focus{left:8px}
.i{flex:none;display:block}
.num{font-variant-numeric:tabular-nums}
.muted{color:var(--ink-3)}
.small{font-size:var(--t-sm);line-height:20px}
.kbd{display:inline-flex;align-items:center;justify-content:center;height:20px;min-width:20px;padding:0 var(--s1);border-radius:var(--r-xs);background:var(--hover);color:var(--ink-3);font:500 var(--t-xs)/1 var(--sans)}
.kbd.on-dark{background:rgb(255 255 255 / .14);color:var(--accent-ink)}
@media (prefers-color-scheme:dark){.kbd.on-dark{background:rgb(0 0 0 / .12)}}

/* shell */
.app{display:flex;align-items:flex-start;min-height:100vh}
.sidebar{flex:0 0 var(--sidebar-w);position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:var(--s2);padding:var(--s2)}
.brand{display:flex;align-items:center;gap:var(--s2);height:var(--s10);padding:0 var(--s2);font-size:16px;font-weight:600;color:var(--ink)}
.brand:hover{text-decoration:none}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:var(--s2);height:var(--control);padding:0 var(--s2);border-radius:var(--r-sm);color:var(--ink)}
.nav a:hover{background:var(--hover);text-decoration:none}
.nav a[aria-current]{background:var(--selected);font-weight:500}
.nav-text{flex:1 1 auto;text-align:left}
.nav-count{font-size:var(--t-xs);color:var(--ink-3)}
.nav-badge{min-width:20px;height:20px;padding:0 6px;border-radius:var(--r-full);background:var(--danger-solid);color:#fff;font-size:var(--t-xs);line-height:20px;text-align:center}
.nav-label{padding:var(--s2) var(--s2) 0;font-size:var(--t-xs);font-weight:500;color:var(--ink-3)}
.sidebar-foot{margin-top:auto;padding:var(--s2);font-size:var(--t-xs);line-height:18px;color:var(--ink-3)}
.inset{flex:1 1 auto;min-width:0;min-height:calc(100vh - var(--s4));margin:var(--s2) var(--s2) var(--s2) 0;background:var(--surface);border-radius:var(--r-xl);box-shadow:var(--shadow-sm)}
.topbar{display:flex;align-items:center;gap:var(--s2);height:var(--s12);padding:0 var(--s6);border-bottom:1px solid var(--line)}
.topbar-title{font-size:16px;font-weight:500}
.topbar-meta{color:var(--ink-3)}
.topbar-search{margin-left:auto;width:300px;justify-content:space-between;color:var(--ink-3);font-weight:400}
.topbar-search-text{display:inline-flex;align-items:center;gap:var(--s2)}
.mnav{display:none;position:relative}
.mnav>summary{list-style:none}.mnav>summary::-webkit-details-marker{display:none}
.mnav-panel{position:absolute;z-index:20;top:40px;left:0;width:240px;padding:var(--s2);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--shadow-md)}
.wrap{max-width:var(--content-max);margin:0 auto;padding:var(--s8) var(--s6) var(--s12)}

/* controls */
input[type=url],input[type=text],input[type=email],input[type=password],input[type=search],input[type=number],select{font:inherit;height:var(--control);padding:0 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-xs);transition:border-color .16s var(--ease)}
input::placeholder{color:var(--ink-3)}
input:hover,select:hover{border-color:var(--line-strong)}
input:focus-visible,select:focus-visible{border-color:var(--chart-mid);box-shadow:var(--ring)}
form{margin:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:var(--control);padding:0 var(--s3);font:500 var(--t-base)/1 var(--sans);border-radius:var(--r-sm);border:1px solid var(--line);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-xs);cursor:pointer;white-space:nowrap;text-decoration:none;transition:background-color .15s var(--ease),border-color .15s var(--ease)}
.btn:hover{background:var(--surface-2);text-decoration:none}
.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);box-shadow:none}
.btn.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.quiet{border-color:transparent;background:transparent;box-shadow:none;color:var(--ink)}
.btn.quiet:hover{background:var(--surface-2)}
.btn.danger{border-color:transparent;background:transparent;box-shadow:none;color:var(--danger)}
.btn.danger:hover{background:var(--danger-soft)}
.btn.danger-solid{background:var(--danger-solid);border-color:var(--danger-solid);color:#fff;box-shadow:none}
.btn.danger-solid:hover{background:var(--danger)}
.btn.sm{height:var(--control-sm);padding:0 var(--s2);font-size:var(--t-sm)}
.btn.icon-only{width:var(--control);padding:0}.btn.sm.icon-only{width:var(--control-sm)}
.btn.block{width:100%;justify-content:flex-start}
.btn[aria-busy=true]{opacity:.6;pointer-events:none}
.steps{padding-left:var(--s5)}.steps>li+li{margin-top:var(--s4)}.steps>li>*+*{margin-top:var(--s2)}
.icon-link{display:inline-flex;align-items:center;gap:6px}
.btn-row{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}
.splitbtn{display:inline-flex}
.splitbtn>form>.btn{border-radius:var(--r-sm) 0 0 var(--r-sm)}
.splitbtn>details>summary.btn{border-radius:0 var(--r-sm) var(--r-sm) 0;margin-left:-1px;width:26px;padding:0}

/* badges */
.badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 var(--s2);border-radius:var(--r-sm);font-size:var(--t-xs);line-height:1;font-weight:500;white-space:nowrap;background:var(--surface-2);color:var(--ink-2)}
.t-neutral{background:var(--surface-2);color:var(--ink)}
.t-accent{background:var(--info-soft);color:var(--info)}
.t-accent-outline{background:transparent;color:var(--info);box-shadow:inset 0 0 0 1px currentColor}
.t-ok{background:var(--ok-soft);color:var(--ok)}
.t-ok-strong{background:var(--ok-dot);color:#fff}
.t-warn{background:var(--warn-soft);color:var(--warn)}
.t-danger{background:var(--danger-soft);color:var(--danger)}
.t-muted{background:transparent;color:var(--ink-3);box-shadow:inset 0 0 0 1px var(--line-strong)}
.tone-danger{color:var(--danger)}.tone-warn{color:var(--warn)}
.chip{display:inline-flex;align-items:center;height:22px;padding:0 var(--s2);border-radius:var(--r-sm);background:var(--surface-2);color:var(--ink-2);font-size:var(--t-xs);font-weight:500;white-space:nowrap}
.chip.warn{background:var(--warn-soft);color:var(--warn)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--chart-mid);flex:none}
.dot.info{background:var(--info-dot)}.dot.ok{background:var(--ok-dot)}.dot.warn{background:var(--warn-dot)}

/* page heads */
.page-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:var(--s3) var(--s6);margin-bottom:var(--s6)}
.page-head p{color:var(--ink-2);margin-top:var(--s1)}
.lede{color:var(--ink-2);font-size:var(--t-md);line-height:22px;max-width:68ch;margin-top:6px}
.back{display:inline-flex;align-items:center;gap:var(--s1);color:var(--ink-3);font-size:var(--t-sm);margin-bottom:var(--s3)}
.back:hover{color:var(--ink)}
.role-nav{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);margin-bottom:var(--s3)}
.role-nav .back{margin-bottom:0}
.pager{display:flex;align-items:center;gap:var(--s1)}
.pager-at{font-size:var(--t-sm);color:var(--ink-3);padding:0 var(--s1);white-space:nowrap}
.pager [aria-disabled]{opacity:.4;pointer-events:none}

/* layout */
.split{display:grid;gap:var(--s8);grid-template-columns:minmax(0,1fr)}
@media (min-width:1080px){.split{grid-template-columns:minmax(0,1fr) var(--aside-w)}.split.flip{grid-template-columns:minmax(0,1fr) 300px}}
.stack>*+*{margin-top:var(--s8)}
.aside>*+*{margin-top:var(--s6)}
.vstack{display:flex;flex-direction:column;gap:var(--s5)}
.home-head{margin-bottom:var(--s8)}
.page-stack{gap:var(--s10)}
.page-stack-sm{gap:var(--s8)}
.section-stack{gap:var(--s4)}
.full{width:100%}
.card-title.lg{font-size:var(--t-lg);line-height:24px}
.legend.flush{margin:0}
.two-up{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s4);align-items:stretch}

/* panels and lists */
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-xl);overflow:hidden}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-xl);padding:var(--s5);display:flex;flex-direction:column;gap:var(--s4)}
.card-head{display:flex;flex-direction:column;gap:2px}
.card-title{font-size:var(--t-md);line-height:22px;font-weight:600}
.card-desc{color:var(--ink-2)}
.card-sub{color:var(--ink-3);font-size:var(--t-sm)}
.card-actions{display:flex;flex-wrap:wrap;gap:var(--s2);margin-top:auto}
.card-note{font-size:var(--t-xs);line-height:16px;color:var(--ink-3)}
.section-head{display:flex;align-items:baseline;gap:var(--s2);margin-bottom:10px}
.section-head .count{color:var(--ink-3);font-weight:500}
.section-head .tail{margin-left:auto;font-size:var(--t-sm)}
.section-desc{color:var(--ink-2);margin-top:var(--s1)}
.list{list-style:none;margin:0;padding:0}
.list>li+li{border-top:1px solid var(--line)}
.item{display:flex;gap:var(--s4);align-items:flex-start;padding:14px var(--s4);transition:opacity .22s var(--ease)}
.item-main{flex:1;min-width:0}
.item-title{font-weight:500;color:var(--ink);overflow-wrap:anywhere}
.item-detail{color:var(--ink-2);font-size:var(--t-sm);line-height:20px;margin-top:var(--s1);white-space:pre-line;overflow-wrap:anywhere}
.clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.clamp.open{display:block}
.more{border:0;background:none;padding:var(--s2) 0;margin:-4px 0;font:500 var(--t-sm) var(--sans);color:var(--ink);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.item-meta{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s3);align-items:center;margin-top:6px;font-size:var(--t-sm);line-height:20px;color:var(--ink-3)}
.item-meta .due{display:inline-flex;align-items:center;gap:var(--s1);font-weight:500}
.item-actions{display:flex;gap:var(--s1);flex:none;align-items:center}
.item.leaving,.row.leaving{opacity:0}
.collapse{display:grid;grid-template-rows:1fr;transition:grid-template-rows .22s var(--ease)}
.collapse.gone{grid-template-rows:0fr}.collapse>*{overflow:hidden;min-height:0}
details.overflow>summary{list-style:none;cursor:pointer;padding:6px var(--s2) 6px 64px;border-top:1px solid var(--line);font-weight:500;font-size:var(--t-sm);color:var(--ink-2)}
details.overflow>summary:hover{color:var(--ink)}
details.overflow>summary::-webkit-details-marker{display:none}
details.overflow[open]>summary{display:none}
.mini-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s4)}
.mini-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s3);align-items:start}
.mini-title{display:block;font-weight:500}
.mini-sub{display:block;font-size:var(--t-sm);color:var(--ink-3)}
.link-subtle{color:var(--ink-2);font-size:var(--t-sm);text-decoration:underline;text-underline-offset:3px}

/* home: filter tiles */
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--s3)}
.tile{display:flex;flex-direction:column;gap:var(--s1);padding:var(--s5);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-xl);box-shadow:var(--shadow-xs);color:var(--ink)}
.tile:hover{background:var(--bg);text-decoration:none}
.tile[aria-current]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.tile-label{color:var(--ink-2)}
.tile-value{font-size:var(--t-stat);line-height:34px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tile-value.danger{color:var(--danger)}
.tile-help{font-size:var(--t-sm);color:var(--ink-3)}

/* home: tabs (wrap, never scroll) */
.ktabs{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;background:var(--surface-2);border-radius:var(--r-md);align-self:flex-start;max-width:100%}
.ktab{display:inline-flex;align-items:center;gap:6px;height:29px;padding:0 var(--s2);border:1px solid transparent;border-radius:var(--r-sm);font-weight:500;white-space:nowrap;color:var(--ink)}
.ktab:hover{text-decoration:none;background:var(--hover)}
.ktab[aria-current]{background:var(--surface);border-color:var(--line);box-shadow:var(--shadow-xs)}
.ktab-count{min-width:20px;height:20px;padding:0 5px;border-radius:var(--r-full);background:var(--line);font-size:var(--t-xs);line-height:20px;text-align:center;font-variant-numeric:tabular-nums}

/* home: task table */
/* Order: card stacks, time-sensitive cards, full list. From 1440px the time-sensitive cards move to a right column. */
.home-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s10) var(--s6);align-items:start}
.home-decks,.home-list{min-width:0}
.home-aside{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s4);align-items:stretch}
.tasks{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface)}
.tasks-head,.row-grid{display:grid;grid-template-columns:40px 32px minmax(0,1fr) auto;align-items:center}
.tasks-head{height:40px;padding-right:var(--s3);background:var(--surface-2);border-radius:var(--r-lg) var(--r-lg) 0 0;font-weight:500}
.group-head{display:flex;align-items:center;height:40px;padding:0 var(--s3) 0 72px;border-top:1px solid var(--line);background:var(--bg);font-size:var(--t-base);font-weight:500}
.row{border-top:1px solid var(--line);transition:opacity .22s var(--ease)}
.row.is-selected{background:var(--surface-2)}
.row.is-focus{box-shadow:inset 2px 0 0 var(--accent)}
.row-grid{align-items:start;padding:14px var(--s3) 14px 0}
.row-grid:hover{background:var(--bg)}
.row.is-selected .row-grid:hover{background:transparent}
.row-toggle{margin:-4px 0 0 6px}
.row-toggle .i{transition:transform .16s var(--ease)}
.row-toggle[aria-expanded=true] .i{transform:rotate(90deg)}
.row-chk{appearance:none;-webkit-appearance:none;width:16px;height:16px;margin:2px 0 0;border:1px solid var(--line-strong);border-radius:var(--r-xs);background:var(--surface);cursor:pointer;display:grid;place-content:center}
.row-chk:checked{background:var(--accent);border-color:var(--accent)}
.row-chk:checked::after{content:"";width:8px;height:4px;border-left:2px solid var(--accent-ink);border-bottom:2px solid var(--accent-ink);transform:translateY(-1px) rotate(-45deg)}
.row-main{min-width:0;padding-right:var(--s4);display:flex;flex-direction:column;gap:var(--s1)}
.row-title{font-weight:500;text-wrap:pretty;overflow-wrap:anywhere}
.row-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s3);font-size:var(--t-sm)}
.due{display:inline-flex;align-items:center;gap:6px}
.due.danger{color:var(--danger);font-weight:500}
.due .i{width:13px;height:13px}
.stage{display:inline-flex;align-items:center;gap:6px;color:var(--ink-2)}
.row-hint{display:flex;align-items:flex-start;gap:6px;font-size:var(--t-xs);line-height:18px;color:var(--ink-3)}
.row-hint .i{width:12px;height:12px;margin-top:3px}
.row-actions{position:relative;display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:-5px}
.row-detail{padding:0 var(--s6) var(--s5) 72px;display:none;flex-direction:column;gap:var(--s3)}
.row-detail.open,.no-js .row-detail{display:flex}
.row-detail p{color:var(--ink-2);max-width:68ch;white-space:pre-line}
.row-links{display:flex;flex-wrap:wrap;gap:var(--s4)}
.row-links a{text-decoration:underline;text-underline-offset:3px}
.no-js .row-toggle,.no-js .row-chk,.no-js .tasks-head .row-chk{visibility:hidden}
.tasks-foot{color:var(--ink-3);font-size:var(--t-sm)}
.no-js .tasks-foot{display:none}

/* interviews: P0 card on Home, prep page */
.interview-card{display:flex;flex-direction:column;gap:var(--s2);padding:var(--s6);border-radius:var(--r-xl);background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-sm)}
.interview-card .btn-row{margin-top:var(--s2)}
.interview-card .interview-when,.interview-card .interview-sub,.interview-card .interview-last{color:var(--ink-2)}
.interview-card.close{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);box-shadow:var(--shadow-md)}
.interview-card.close .interview-when,.interview-card.close .interview-sub,.interview-card.close .interview-last{color:inherit;opacity:.85}
/* On the inverted card, mix from --accent/--accent-ink rather than fixed white or black, so hover keeps contrast in both themes. */
.interview-card.close .btn{background:transparent;border-color:color-mix(in srgb,var(--accent-ink) 28%,transparent);color:var(--accent-ink);box-shadow:none}
.interview-card.close .btn:hover{background:color-mix(in srgb,var(--accent-ink) 10%,transparent)}
.interview-card.close .btn.primary{background:var(--accent-ink);border-color:var(--accent-ink);color:var(--accent)}
.interview-card.close .btn.primary:hover{background:color-mix(in srgb,var(--accent-ink) 86%,var(--accent));border-color:color-mix(in srgb,var(--accent-ink) 86%,var(--accent))}
.interview-title{font-size:var(--t-xl);line-height:30px;letter-spacing:-.015em}
.interview-when{display:flex;align-items:center;gap:var(--s2);font-size:var(--t-sm);font-weight:500}
.interview-last{font-size:var(--t-sm);max-width:72ch}
.interview-last-label{font-weight:500}
.interview-page{max-width:1200px;margin:0 auto}
.interview-head{display:flex;flex-direction:column;gap:var(--s2)}
.interview-head .interview-when{color:var(--ink-2)}
.interview-head .btn-row{margin-top:var(--s2)}
.interview-grid{display:grid;grid-template-columns:minmax(0,1fr) var(--aside-w);gap:var(--s6);align-items:start}
.prep-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:var(--s2);max-width:72ch}
.plain-list{margin:var(--s1) 0 0;padding-left:18px;display:flex;flex-direction:column;gap:var(--s1);font-size:var(--t-sm)}
.convo{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s3)}
.convo-item{padding:var(--s3) var(--s4);border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface)}
.convo-item.mine{background:var(--bg)}
.convo-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s3);font-size:var(--t-xs);color:var(--ink-3)}
.convo-meta a{margin-left:auto;display:inline-flex;align-items:center;gap:var(--s1);color:var(--ink-2)}
.convo-meta .i{width:12px;height:12px}
.convo-subject{margin-top:var(--s1);font-weight:500;font-size:var(--t-sm)}
.convo-body{margin-top:var(--s1);white-space:pre-line;color:var(--ink-2);font-size:var(--t-sm);overflow-wrap:anywhere;max-width:80ch}
@media (max-width:1099px){.interview-grid{grid-template-columns:minmax(0,1fr)}}

/* home: one ordered queue (the first task large, the next four compact) */
.focus{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:var(--s8)}
.focus-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s2)}
.focus-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s3) var(--s5);align-items:center;padding:var(--s3) var(--s4);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);transition:opacity .22s var(--ease)}
.focus-item:nth-child(n+6){display:none}
.focus-main{min-width:0;display:flex;flex-direction:column;gap:6px}
.focus-title{font-weight:500;text-wrap:pretty;overflow-wrap:anywhere}
.focus-why,.focus-detail{display:none}
.focus-actions{display:flex;align-items:center;gap:var(--s2)}
.focus-item:not(:first-child) .btn{height:var(--control-sm);padding:0 var(--s2);font-size:var(--t-sm)}
.focus-item:not(:first-child) .btn.primary{background:var(--surface);border-color:var(--line);color:var(--ink);box-shadow:var(--shadow-xs)}
.focus-item:not(:first-child) .btn.primary:hover{background:var(--surface-2)}
.focus-item:first-child{grid-template-columns:minmax(0,1fr);align-items:start;gap:var(--s5);padding:var(--s6);border-radius:var(--r-xl);box-shadow:var(--shadow-md);margin-bottom:var(--s4)}
.focus-item:first-child .focus-main{gap:var(--s2)}
.focus-item:first-child .focus-why{display:block;font-size:var(--t-sm);font-weight:500;color:var(--ink-2)}
.focus-item:first-child .focus-title{font-size:var(--t-lg);line-height:24px;font-weight:600}
.focus-item:first-child .focus-detail{display:block;color:var(--ink-2);max-width:68ch}
.focus-done{display:flex;flex-direction:column;gap:var(--s2);padding:var(--s6);border:1px dashed var(--line-strong);border-radius:var(--r-xl)}
.focus-done .btn-row{margin-top:var(--s2)}
.later-title{font-size:var(--t-md);line-height:22px}
.later{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;background:var(--surface)}
.later-item{display:flex;align-items:center;gap:var(--s3);padding:var(--s3) var(--s4);color:var(--ink)}
.later-item+.later-item{border-top:1px solid var(--line)}
.later-item:hover{background:var(--bg);text-decoration:none}
.later-item>.i{margin-left:auto;color:var(--ink-3)}
.later-num{min-width:28px;font-weight:600}
@media (max-width:599px){.focus-item{grid-template-columns:minmax(0,1fr)}}

.focus-note{grid-column:1 / -1;font-size:var(--t-xs);line-height:16px;color:var(--ink-3)}
.focus-item:not(:first-child) .focus-note{display:none}
.focus-actions .btn .i,.deck-actions .btn .i,.row-actions .btn .i{width:14px;height:14px}
.waiting-list{list-style:none;margin:0;padding:0}
.waiting-item{gap:var(--s2)}
.wait-main{display:flex;flex-direction:column;flex:1 1 auto;min-width:0}
.chip.opened{background:var(--info-soft);color:var(--info)}

/* home: card stacks, one per type of work */
.section-title-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s1) var(--s3)}
.decks{display:flex;flex-wrap:wrap;gap:var(--s5) var(--s4)}
.deck{flex:1 1 300px;display:flex;flex-direction:column;gap:var(--s3);min-width:0}
.deck-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s2);font-size:var(--t-sm)}
.deck-kind{display:inline-flex;align-items:center;gap:6px;font-weight:500}
.deck-kind .i{color:var(--ink-3)}
.deck-left{color:var(--ink-3)}
.deck-stack{flex:1;list-style:none;margin:0;padding:0 0 14px;display:grid;grid-template-rows:1fr}
.deck-card{grid-area:1 / 1;display:flex;flex-direction:column;gap:var(--s2);min-width:0;padding:var(--s5);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-xl);box-shadow:var(--shadow-sm);transform-origin:50% 100%;transition:transform .28s var(--ease),opacity .28s var(--ease);z-index:3}
.deck-card:nth-child(2){transform:translateY(7px) scale(.96);z-index:2;box-shadow:none}
.deck-card:nth-child(3){transform:translateY(14px) scale(.92);z-index:1;box-shadow:none}
.deck-card:nth-child(n+4){visibility:hidden;z-index:0}
.deck-card:not(:first-child){pointer-events:none}
.deck-card:not(:first-child)>*{visibility:hidden}
.deck-card.out-right{transform:translateX(40%) rotate(3deg)!important;opacity:0}
.deck-card.out-left{transform:translateX(-40%) rotate(-3deg)!important;opacity:0}
.deck-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s3);font-size:var(--t-sm)}
.deck-title{font-size:var(--t-md);line-height:22px;font-weight:600;text-wrap:pretty;overflow-wrap:anywhere}
.deck-detail{color:var(--ink-2);font-size:var(--t-sm);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.deck-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2);margin-top:auto;padding-top:var(--s2)}
.deck-skip{margin-left:auto;color:var(--ink-2)}
.deck-skip .i{width:14px;height:14px}
.deck-empty{display:flex;align-items:center;justify-content:center;min-height:120px;border:1px dashed var(--line-strong);border-radius:var(--r-xl);color:var(--ink-3);font-size:var(--t-sm)}
.no-js .deck-skip{display:none}

/* directory rows (People, Companies) */
.chip.ok{background:var(--ok-soft);color:var(--ok)}.chip.info{background:var(--info-soft);color:var(--info)}.chip.danger{background:var(--danger-soft);color:var(--danger)}
.avatar{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:var(--surface-2);color:var(--ink-2);font-size:var(--t-sm);font-weight:600;flex:none}
.dir{list-style:none;margin:0;padding:0}
.dir>li+li{border-top:1px solid var(--line)}
.dir-row,.co-row,.attn-row{display:grid;gap:var(--s2) var(--s4);align-items:start;padding:14px var(--s4)}
.dir-row{grid-template-columns:36px minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) auto}
.co-row{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) auto}
.attn-row{grid-template-columns:minmax(0,1fr) minmax(260px,1.1fr) auto;align-items:center}
.attn-row .inline-form{margin:0;flex-wrap:nowrap}
.due-row{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:var(--s2) var(--s4);align-items:start;padding:14px var(--s4)}
.due-row .due{margin-top:var(--s1);font-size:var(--t-sm)}
details.overflow.plain>summary{padding-left:var(--s4)}
.dir-row:hover,.co-row:hover{background:var(--bg)}
.dir-main{min-width:0;display:flex;flex-direction:column;gap:2px}
.dir-name{font-weight:500;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.dir-sub{display:block;font-size:var(--t-sm);color:var(--ink-3);overflow-wrap:anywhere}
.dir-sub a{color:var(--ink-2);text-decoration:underline;text-underline-offset:3px}
.dir-col{display:flex;flex-direction:column;gap:2px;font-size:var(--t-sm);min-width:0}
.dir-label{font-size:var(--t-xs);color:var(--ink-3)}
.dir-actions{display:flex;align-items:center;justify-content:flex-end;gap:var(--s2)}
.person-cards{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--s4)}
.person-card{gap:var(--s3)}
.person-card-head{display:flex;align-items:center;gap:var(--s3)}
textarea.field{font:inherit;line-height:20px;min-height:132px;padding:10px var(--s3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-xs);resize:vertical;width:100%}
textarea.field:focus-visible{border-color:var(--chart-mid);box-shadow:var(--ring)}
code{font:var(--t-xs)/1 var(--mono);padding:2px 4px;border-radius:var(--r-xs);background:var(--surface-2)}
@media (max-width:1439px){
.attn-row{grid-template-columns:minmax(0,1fr) auto}
.attn-row .inline-form{grid-column:1;grid-row:2}
.attn-row .dir-actions{grid-column:2;grid-row:1}
.co-row{grid-template-columns:minmax(0,1fr) auto}
.co-row .dir-col{grid-column:1;flex-direction:row;flex-wrap:wrap;gap:6px}
.co-row .dir-actions{grid-column:2;grid-row:1}
}
@media (max-width:1179px){
.dir-row{grid-template-columns:36px minmax(0,1fr) auto}
.dir-row .dir-col{grid-column:2;flex-direction:row;flex-wrap:wrap;gap:6px}
.dir-row .dir-actions{grid-column:3;grid-row:1}
}

/* menus and popovers (details-based, work without JS) */
.pop{position:relative}
.pop>summary{list-style:none}.pop>summary::-webkit-details-marker{display:none}
.menu{position:absolute;z-index:6;top:34px;right:0;min-width:232px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:var(--s1);box-shadow:var(--shadow-md)}
/* With JS the open menu is pinned to the viewport, so a list container's overflow:hidden (kept for rounded corners) cannot clip it. Hidden until placed so the clipped position never flashes. */
.menu.float{position:fixed;right:auto;z-index:25;overflow-y:auto}
:root:not(.no-js) .pop[open]>.menu:not(.float){visibility:hidden}
.menu-label{padding:6px var(--s2);font-size:var(--t-xs);color:var(--ink-3)}
.menu-item{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);width:100%;height:var(--control);padding:0 var(--s2);border:0;border-radius:var(--r-xs);background:transparent;font:inherit;color:var(--ink);text-align:left;cursor:pointer}
.menu-item:hover{background:var(--surface-2);text-decoration:none}
.menu-meta{color:var(--ink-3)}
.menu-sep{height:1px;background:var(--line);margin:var(--s1) calc(var(--s1) * -1)}
.confirm{width:272px;padding:var(--s3);display:flex;flex-direction:column;gap:var(--s1)}
.confirm-title{font-weight:500}
.confirm-text{color:var(--ink-2)}
.confirm-actions{display:flex;justify-content:flex-end;gap:var(--s2);margin-top:var(--s2)}

/* timeline */
.timeline{list-style:none;margin:0;padding:0}
.tl-item{position:relative;padding:0 0 var(--s4) var(--s6)}
.tl-item:last-child{padding-bottom:0}
.tl-item::before{content:"";position:absolute;left:4px;top:12px;bottom:-2px;width:2px;background:var(--hover)}
.tl-item:last-child::before{display:none}
.tl-dot{position:absolute;left:0;top:5px;width:10px;height:10px;border-radius:50%;background:var(--surface);border:2px solid var(--chart-strong)}
.tl-dot.later{border-color:var(--chart-mid)}
.tl-date{display:block;font-size:var(--t-xs);color:var(--ink-3)}

/* charts */
.meter{display:block;height:8px;border-radius:var(--r-full);background:var(--chart-track)}
.meter.thin{height:6px}
.meter-fill{display:block;height:100%;border-radius:inherit;background:var(--chart-strong)}
.meter-fill.mid{background:var(--chart-mid)}
.meter-fill.ok{background:var(--ok-dot)}
.stacked{display:flex;height:10px;border-radius:var(--r-full);overflow:hidden;background:var(--line)}
.stacked>span{display:block;height:100%}
.seg-strong{background:var(--chart-strong)}
.seg-mid{background:var(--chart-mid);box-shadow:inset 2px 0 0 var(--surface)}
.legend{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);margin-top:var(--s2);font-size:var(--t-sm);color:var(--ink-2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.swatch{width:8px;height:8px;border-radius:2px;background:var(--chart-strong)}
.swatch.mid{background:var(--chart-mid)}.swatch.soft{background:var(--line)}.swatch.band{background:var(--chart-band)}
.swatch.dashed{background:transparent;border:1px dashed var(--chart-mid)}
.bars{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s3)}
.bar-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px var(--s3);align-items:baseline;font-size:var(--t-sm)}
.bar-row .meter{grid-column:1 / -1}
.bar-val{color:var(--ink-3);font-variant-numeric:tabular-nums}
.bar-val strong{color:var(--ink);font-weight:600}
.funnel{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s2)}
.funnel-row{display:grid;grid-template-columns:136px minmax(0,1fr) 40px;gap:var(--s3);align-items:center}
.funnel-label{font-size:var(--t-sm);color:var(--ink-2)}
.funnel-bar{display:block;height:16px;border-radius:var(--r-xs);background:var(--chart-mid)}
.funnel-bar.first{background:var(--chart-soft)}.funnel-bar.last{background:var(--chart-strong)}
.funnel-val{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.columns{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:var(--s2);align-items:end;height:180px}
.col{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:var(--s1);height:100%}
.col-val{font-size:var(--t-xs);font-weight:500;color:var(--ink-3);font-variant-numeric:tabular-nums}
.col-bar{display:block;width:100%;max-width:44px;border-radius:var(--r-xs) var(--r-xs) 0 0;background:var(--chart-soft)}
.col.current .col-bar{background:var(--chart-strong)}.col.current .col-val{color:var(--ink)}
.col.forecast .col-bar{background:transparent;border:1px dashed var(--chart-mid)}
.col-label{font-size:var(--t-xs);color:var(--ink-3);white-space:nowrap}
.timing{display:flex;flex-direction:column;gap:var(--s3)}
.timing-row,.timing-axis{display:grid;grid-template-columns:120px minmax(0,1fr) 120px;gap:var(--s3);align-items:center}
.timing-axis{font-size:var(--t-xs);color:var(--ink-3)}
.timing-axis>span:nth-child(2){display:flex;justify-content:space-between;align-items:center}
.track{position:relative;display:block;height:18px}
.track::before{content:"";position:absolute;left:0;right:0;top:8px;height:2px;background:var(--hover)}
.track-band{position:absolute;top:2px;height:14px;border-radius:2px;background:var(--chart-band)}
.track-dot{position:absolute;top:4px;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:var(--chart-mid);border:2px solid var(--surface);box-shadow:0 0 0 1px var(--chart-mid)}
.track-dot.late{background:var(--chart-strong);box-shadow:0 0 0 1px var(--chart-strong)}
.timing-end{text-align:right;font-size:var(--t-xs);color:var(--ink-3)}
.hairline{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r-xl);overflow:hidden}
.hairline>*{background:var(--surface)}
.hairline.cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.hairline.cols-6{grid-template-columns:repeat(6,minmax(0,1fr));border-radius:var(--r-lg)}
.cell{padding:var(--s5);display:flex;flex-direction:column;gap:var(--s4)}
.stage-cell{padding:var(--s4);display:flex;flex-direction:column;gap:6px;color:var(--ink)}
.stage-cell:hover{background:var(--bg);text-decoration:none}
.stage-label{font-size:var(--t-sm);color:var(--ink-2)}
.stage-value{font-size:26px;line-height:32px;font-weight:600;font-variant-numeric:tabular-nums}
.stage-note{font-size:var(--t-xs);color:var(--ink-3)}

/* legacy page parts (roles, role, people, companies, sources, timers) on the same tokens */
.summary{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s5);color:var(--ink-2)}
.summary b{color:var(--ink);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:var(--t-base)}
th{font-size:var(--t-sm);font-weight:500;color:var(--ink-2);text-align:left;padding:10px var(--s4);border-bottom:1px solid var(--line);background:var(--surface-2);white-space:nowrap}
td{padding:var(--s3) var(--s4);border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background-color .12s var(--ease)}
tbody tr:hover{background:var(--bg)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.cell-title{font-weight:500;color:var(--ink);overflow-wrap:anywhere}
.cell-sub{display:block;overflow-wrap:anywhere;color:var(--ink-3);font-size:var(--t-sm);margin-top:2px}
.compact td,.compact th{padding:var(--s2) 14px}
.filters{display:flex;flex-wrap:wrap;gap:var(--s3);align-items:center;justify-content:space-between;margin-bottom:var(--s4)}
.seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;background:var(--surface-2);border-radius:var(--r-md)}
.seg a{display:inline-flex;align-items:center;gap:6px;height:29px;padding:0 var(--s2);border:1px solid transparent;border-radius:var(--r-sm);color:var(--ink);font-weight:500;white-space:nowrap}
.seg a:hover{background:var(--hover);text-decoration:none}
.seg a[aria-current]{background:var(--surface);border-color:var(--line);box-shadow:var(--shadow-xs)}
.seg a .c{font-variant-numeric:tabular-nums;color:var(--ink-3)}
.search{position:relative;flex:0 1 280px}
.search .i{position:absolute;left:10px;top:8px;color:var(--ink-3)}
.search input{width:100%;padding-left:32px}
.role-head{margin-bottom:var(--s5)}
.role-head .company{overflow-wrap:anywhere;font-size:var(--t-lg);line-height:24px;color:var(--ink);margin-top:var(--s1)}
.role-head .badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:var(--s3)}
.toolbar{display:flex;flex-wrap:wrap;gap:var(--s2);padding-bottom:var(--s5);margin-bottom:28px;border-bottom:1px solid var(--line)}
.toolbar .spacer{flex:1}
.prose{max-width:68ch;white-space:pre-line;overflow-wrap:anywhere}
.block>h2,.block>.section-head{margin-bottom:var(--s2)}
.callout{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s3) var(--s4);padding:14px var(--s4);border-radius:var(--r-lg);background:var(--surface-2)}
.callout>p{flex:1 1 320px}
.callout.danger{background:var(--danger-soft);color:var(--danger)}
.callout.accent{background:var(--info-soft);color:var(--ink)}
.facts{margin:0;padding:var(--s1) var(--s4)}
.facts>div{padding:10px 0;border-top:1px solid var(--line)}
.facts>div:first-child{border-top:0}
.facts dt{font-size:var(--t-xs);color:var(--ink-3);font-weight:500}
.facts dd{margin:2px 0 0;line-height:20px;overflow-wrap:anywhere;white-space:pre-line}
.copy-block{max-width:80ch}
.copy-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);margin-bottom:var(--s2)}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-md);padding:var(--s3) 14px;font:var(--t-sm)/20px var(--mono);max-width:80ch}
.person{padding:var(--s4)}
.person-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.person-head .who{font-weight:600}
.person dl{display:grid;grid-template-columns:max-content 1fr;gap:var(--s1) var(--s3);margin:10px 0 0;font-size:var(--t-sm);line-height:20px}
.person dt{color:var(--ink-3)}.person dd{margin:0;overflow-wrap:anywhere}
.person .copy-block{margin-top:14px}
.person .btn-row{margin-top:14px}
details.fold{border-top:1px solid var(--line);padding-top:var(--s4)}
details.fold>summary{cursor:pointer;font-weight:600;font-size:var(--t-lg);line-height:24px;list-style:none;display:flex;align-items:center;gap:var(--s2)}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::after{content:"";width:8px;height:8px;border-right:1.75px solid var(--ink-3);border-bottom:1.75px solid var(--ink-3);transform:rotate(-45deg);transition:transform .16s var(--ease);margin-left:2px}
details.fold[open]>summary::after{transform:rotate(45deg)}
details.fold>.prose{margin-top:10px}
.add-source{display:grid;grid-template-columns:minmax(0,1fr) 200px auto auto;gap:var(--s2);padding:var(--s4)}
.note{margin-bottom:var(--s5)}
.bookmarklet{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 var(--s2);border:1px dashed var(--line-strong);border-radius:var(--r-sm);color:var(--ink);font-size:var(--t-xs);font-weight:500;cursor:grab;background:var(--surface)}
.bookmarklet:hover{border-color:var(--ink-3);text-decoration:none}
.bookmarklet .i{width:12px;height:12px}
.hint{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2);font-size:var(--t-sm);color:var(--ink-3)}
.add-companies{display:grid;gap:10px;padding:var(--s4)}
.add-companies textarea{font:inherit;line-height:20px;min-height:112px;padding:10px var(--s3);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);color:var(--ink);resize:vertical}
.add-companies textarea:focus-visible{border-color:var(--chart-mid);box-shadow:var(--ring)}
.item-meta a{white-space:nowrap}
.inline-form{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap;margin-top:var(--s2)}
.inline-form input[type=url]{flex:1 1 240px;min-width:0}
.item-actions select{height:var(--control-sm);font-size:var(--t-sm);padding:0 var(--s2)}
.timer-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:var(--s2) var(--s4);padding:var(--s3) var(--s4);border-top:1px solid var(--line)}
.timer-row:first-child{border-top:0}
.timer-row label{font-weight:500}
.timer-row .hint{margin-top:2px}
.timer-in{display:flex;align-items:center;gap:var(--s2);color:var(--ink-2)}
.timer-in span{min-width:40px}
.timer-in input{width:84px;text-align:right;font-variant-numeric:tabular-nums}
/* setup pages (hub mode) */
.setup{max-width:720px}
.setup-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s4);padding:var(--s3) var(--s4);border-top:1px solid var(--line)}
.setup-row:first-child{border-top:0}
.setup-row>div{flex:1 1 280px;min-width:0}
.setup-row .card-sub{margin-top:2px}
.form-row{display:grid;gap:6px;padding:var(--s3) var(--s4);border-top:1px solid var(--line)}
.form-row:first-child{border-top:0}
.form-row>label,.form-row>legend{font-weight:500}
.form-row input[type=text],.form-row input[type=email],.form-row input[type=url],.form-row input[type=password],.form-row input[type=number]{width:100%;min-width:0}
.form-row textarea.field{min-height:96px}
.form-row textarea.field.tall{min-height:420px}
fieldset.form-row{border:0;border-top:1px solid var(--line);margin:0}
.choice{display:flex;align-items:center;gap:var(--s2);font-weight:400}
.ladder{margin:0;padding:var(--s3) var(--s4) var(--s3) 36px;line-height:22px}
.ladder li+li{margin-top:6px}
.empty{padding:28px var(--s4);text-align:center;color:var(--ink-3)}
.empty-title{color:var(--ink);font-weight:500;margin-bottom:var(--s1)}

/* overlays */
.action-bar{position:fixed;left:50%;bottom:var(--s6);transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:var(--s1);padding:6px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-lg)}
.action-bar-count{display:inline-flex;align-items:center;gap:6px;height:var(--control);padding:0 var(--s1) 0 10px;border:1px dashed var(--line-strong);border-radius:var(--r-sm);white-space:nowrap}
.action-bar-sep{width:1px;height:20px;background:var(--line);margin:0 var(--s1)}
.toast-region{position:fixed;right:var(--s6);bottom:var(--s6);z-index:35;pointer-events:none}
.toast{pointer-events:auto;display:flex;align-items:center;gap:var(--s3);width:356px;max-width:calc(100vw - 32px);padding:14px var(--s4);border-radius:var(--r-md);background:var(--surface);color:var(--ink);border:1px solid var(--line);box-shadow:var(--shadow-md);opacity:0;transform:translateY(8px);transition:opacity .2s var(--ease),transform .2s var(--ease)}
.toast-text{flex:1 1 auto;min-width:0}
.toast.show{opacity:1;transform:none}
.toast.error{border-color:var(--danger);color:var(--danger)}
.cmd{width:560px;max-width:calc(100vw - 32px);margin:18vh auto auto;padding:0;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-lg)}
.cmd::backdrop{background:var(--overlay)}
.cmd-input{display:flex;align-items:center;gap:var(--s2);height:var(--s12);padding:0 var(--s3);border-bottom:1px solid var(--line);color:var(--ink-3)}
.cmd-input input{flex:1 1 auto;min-width:0;height:46px;border:0;box-shadow:none;padding:0;background:transparent}
.cmd-input input:focus-visible{box-shadow:none}
.cmd-list{padding:var(--s1)}
.cmd-item{min-height:36px}
.cmd-group{padding:6px var(--s2);font-size:var(--t-xs);font-weight:500;color:var(--ink-3)}
.cmd-item{display:flex;align-items:center;gap:var(--s2);width:100%;padding:6px var(--s2);border:0;border-radius:var(--r-xs);background:transparent;font:inherit;color:var(--ink);text-align:left;cursor:pointer}
.cmd-item:hover,.cmd-item.is-active{background:var(--surface-2);text-decoration:none}
.cmd-item .i{color:var(--ink-3)}
.cmd-item-text{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-item-body{display:flex;flex-direction:column;flex:1 1 auto;min-width:0}
.cmd-item-sub{display:block;font-size:var(--t-xs);line-height:16px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-list{max-height:min(440px,60vh);overflow-y:auto;scrollbar-width:none}
.cmd-list::-webkit-scrollbar{display:none}
.cmd-empty{padding:var(--s6) var(--s4);text-align:center;color:var(--ink-3)}
.cmd-foot{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);margin:0;padding:var(--s2) var(--s3);border-top:1px solid var(--line);font-size:var(--t-xs);color:var(--ink-3)}
.cmd-results{list-style:none;margin:0;padding:var(--s1)}
.search-page{max-width:720px;margin:0 auto}
.search-page-form{display:flex;gap:var(--s2)}

/* responsive: built for laptops and desktops (1024px and up) */
@media (min-width:1440px){
.home-grid{grid-template-columns:minmax(0,1fr) var(--aside-w)}
.home-decks,.home-list{grid-column:1}
.home-aside{grid-column:2;grid-row:1 / span 2;grid-template-columns:minmax(0,1fr);align-items:start;position:sticky;top:var(--s6)}
}
@media (max-width:1179px){.hairline.cols-6{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1099px){
.home-aside{grid-template-columns:repeat(2,minmax(0,1fr))}
.home-aside>:last-child{grid-column:1 / -1}
.two-up{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:899px){
.sidebar{display:none}
.mnav{display:block}
.inset{margin:0;border-radius:0;box-shadow:none}
.topbar,.wrap{padding-left:var(--s4);padding-right:var(--s4)}
.topbar-meta{display:none}
.topbar-search{width:auto;flex:0 1 300px}
.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
.home-aside,.hairline.cols-3{grid-template-columns:minmax(0,1fr)}
.home-aside>:last-child{grid-column:auto}
.add-source{grid-template-columns:1fr}
}
@media (max-width:599px){
.tile{padding:14px}
.row-grid{grid-template-columns:40px 32px minmax(0,1fr);row-gap:var(--s3)}
.row-actions{grid-column:3;justify-content:flex-start;margin-top:0}
.menu{left:0;right:auto}
.hairline.cols-6{grid-template-columns:repeat(2,minmax(0,1fr))}
.item{flex-direction:column;gap:10px}
.item-actions{flex-wrap:wrap}
.timer-row{grid-template-columns:1fr}
.stack-table thead{display:none}
.stack-table tr{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:var(--s3) var(--s4);border-bottom:1px solid var(--line)}
.stack-table tbody tr:last-child{border-bottom:0}
.stack-table td{padding:0;border:0}
.stack-table td.c-role{flex:1 1 100%;margin-bottom:2px}
.stack-table td[data-label]:empty{display:none}
.stack-table td.c-meta{color:var(--ink-3);font-size:var(--t-sm)}
.toolbar .spacer{display:none}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;

// ---------- script ----------
// Progressive enhancement only: every link and form works without it.

const JS = `(()=>{
const root=document.documentElement;root.classList.remove('no-js');
const box=document.querySelector('.toast'),text=box&&box.querySelector('.toast-text'),undoBtn=box&&box.querySelector('.toast-undo');let t,undoUrl=null;
function toast(msg,err,undo){if(!box||!msg)return;text.textContent=msg;box.classList.toggle('error',!!err);undoUrl=undo||null;undoBtn.hidden=!undoUrl;box.hidden=false;requestAnimationFrame(()=>box.classList.add('show'));clearTimeout(t);t=setTimeout(()=>{box.classList.remove('show');setTimeout(()=>box.hidden=true,220)},5000)}
undoBtn&&undoBtn.addEventListener('click',async()=>{if(!undoUrl)return;try{await fetch(undoUrl,{method:'POST',headers:{'x-inline':'1'}});location.reload()}catch{toast('That didn\\u2019t undo. Reload and try again.',true)}});
if(window.__flash){toast(window.__flash);const u=new URL(location.href);u.searchParams.delete('flash');history.replaceState(null,'',u)}

function removeRow(li){
  const wrap=document.createElement('div');wrap.className='collapse';li.parentNode.insertBefore(wrap,li);const inner=document.createElement('div');wrap.appendChild(inner);inner.appendChild(li);
  li.classList.add('leaving');requestAnimationFrame(()=>requestAnimationFrame(()=>wrap.classList.add('gone')));
  setTimeout(()=>{const grp=wrap.closest('[data-group]');wrap.remove();
    if(grp){const n=grp.querySelectorAll('[data-row]').length;grp.querySelectorAll('[data-count]').forEach(c=>{c.textContent=n});
      grp.querySelectorAll('[data-one]').forEach(h=>{h.textContent=n+' '+(n===1?h.dataset.one:h.dataset.many)});if(!n)grp.hidden=true}
    const dec=sel=>document.querySelectorAll(sel).forEach(c=>{c.textContent=Math.max(0,(+c.textContent||0)-1)});
    dec('[data-total]');dec('[data-tab-count="all"]');if(li.dataset.kind)dec('[data-tab-count="'+li.dataset.kind+'"]');
    if('pending' in li.dataset){dec('[data-pending-total]');dec('.nav-badge')}
    const fl=document.querySelector('.focus-list');if(fl){fl.dataset.due=Math.max(0,(+fl.dataset.due||0)-1);document.querySelectorAll('[data-later-rest]').forEach(c=>{c.textContent=Math.max(0,fl.dataset.due-5)});
      if(!fl.querySelector('.focus-item')){fl.hidden=true;const d=document.querySelector('.focus-done');if(d)d.hidden=false}}
    syncBar()},240);
}
function deckOut(card,dir){const deck=card.closest('.deck');card.classList.add('out-'+dir);
  setTimeout(()=>{card.remove();if(!deck)return;const left=deck.querySelector('[data-deck-left]');left.textContent=Math.max(0,(+left.textContent||0)-1);
    if(!deck.querySelector('.deck-card'))deck.querySelector('.deck-empty').hidden=false},280)}
document.addEventListener('submit',async e=>{
  const f=e.target; if(!(f instanceof HTMLFormElement))return;
  if(f.dataset.confirm&&!confirm(f.dataset.confirm)){e.preventDefault();return}
  if(!('inline' in f.dataset))return;
  e.preventDefault(); const b=f.querySelector('button'); b&&b.setAttribute('aria-busy','true');
  try{
    const r=await fetch(f.action,{method:'POST',body:new URLSearchParams(new FormData(f)),headers:{'x-inline':'1'}});
    const j=await r.json().catch(()=>({})); if(!r.ok||!j.ok)throw new Error(j.error||'That didn\\u2019t save. Try again.');
    const act=f.action.match(/\\/a\\/(\\d+)\\/(\\w+)/);
    if(act&&j.remove!==false){
      const card=document.querySelector('.deck-card[data-aid="'+act[1]+'"]');if(card)deckOut(card,act[2]==='done'?'right':'left');
      const row=document.querySelector('[data-row][data-aid="'+act[1]+'"]');if(row)removeRow(row);
      const w=document.querySelector('.waiting-item[data-aid="'+act[1]+'"]');if(w){w.remove();hideEmptyWaiting()}
    } else { const li=f.closest('[data-row]');
      if(li&&j.remove!==false)removeRow(li); else if(j.reload){location.reload()}
    else if(j.label&&b){b.textContent=j.label;b.disabled=true} }
    if(!f.dataset.quiet)toast(j.message,false,j.undo);
  }catch(err){toast(err.message,true)}finally{b&&b.removeAttribute('aria-busy');f.closest('details')&&f.closest('details').removeAttribute('open')}
});

function hideEmptyWaiting(){const s=document.querySelector('[data-waiting]');if(s&&!s.querySelector('.waiting-item'))s.hidden=true}
function moveToWaiting(item){const s=document.querySelector('[data-waiting]'),list=s&&s.querySelector('.waiting-list');
  if(list){const li=document.createElement('li');li.className='later-item waiting-item';li.dataset.aid=item.dataset.aid;
    const wrap=document.createElement('span');wrap.className='wait-main';const ti=document.createElement('span');ti.className='mini-title';ti.textContent=item.querySelector('.focus-title').textContent;
    const sub=document.createElement('span');sub.className='mini-sub';sub.textContent='Opened just now';wrap.append(ti,sub);li.append(wrap);list.prepend(li);s.hidden=false}
  removeRow(item)}
document.addEventListener('click',async e=>{
  const op=e.target.closest('[data-open]');
  if(op){if(op.dataset.copyText&&navigator.clipboard)navigator.clipboard.writeText(op.dataset.copyText).catch(()=>{});
    fetch(op.dataset.open,{method:'POST',headers:{'x-inline':'1'},keepalive:true}).catch(()=>{});
    const item=op.closest('.focus-item'),card=op.closest('.deck-card'),row=op.closest('[data-row]');
    if('counts' in op.dataset){const aid=(item||card||row||{}).dataset?.aid;setTimeout(()=>{
      const c2=document.querySelector('.deck-card[data-aid="'+aid+'"]');if(c2)deckOut(c2,'right');
      document.querySelectorAll('[data-row][data-aid="'+aid+'"]').forEach(removeRow)},150);
      toast('The note is copied. Paste it and send. It counts as sent; you will see when they accept.');return}
    if(item)setTimeout(()=>moveToWaiting(item),150);
    else if(card)setTimeout(()=>deckOut(card,'right'),150);
    else if(row&&!row.querySelector('.chip.opened')){const m=row.querySelector('.row-meta');if(m){const c=document.createElement('span');c.className='chip opened';c.textContent='Opened';m.append(c)}}
    toast(op.dataset.copyText?'The note is copied. Paste it and send. This clears on its own once it is seen.':'Opened. It clears on its own once it is seen to be done.');return}
  const c=e.target.closest('[data-copy]');
  if(c){const el=document.getElementById(c.dataset.copy);try{await navigator.clipboard.writeText(el.innerText);const s=c.querySelector('span');const o=s.textContent;s.textContent='Copied';setTimeout(()=>s.textContent=o,1600)}catch{toast('Couldn\\u2019t copy. Select the text instead.',true)}return}
  const m=e.target.closest('.more');
  if(m){const d=m.previousElementSibling;const open=d.classList.toggle('open');m.textContent=open?'Show less':'Show more';m.setAttribute('aria-expanded',open);return}
  const tg=e.target.closest('.row-toggle');
  if(tg){const d=document.getElementById(tg.getAttribute('aria-controls'));const open=tg.getAttribute('aria-expanded')!=='true';tg.setAttribute('aria-expanded',open);d&&d.classList.toggle('open',open);return}
  const skip=e.target.closest('[data-skip]');
  if(skip){const card=skip.closest('.deck-card'),stack=card&&card.parentNode;if(!stack||stack.children.length<2)return;card.classList.add('out-left');
    setTimeout(()=>{card.classList.remove('out-left');stack.appendChild(card)},280);return}
  const keep=e.target.closest('[data-close]');
  if(keep){keep.closest('details')&&keep.closest('details').removeAttribute('open');return}
  const cmdBtn=e.target.closest('[data-cmd]');
  if(cmdBtn&&cmd){e.preventDefault();openCmd();return}
  document.querySelectorAll('details.pop[open],details.mnav[open]').forEach(d=>{if(!d.contains(e.target))d.removeAttribute('open')});
});
/* menus: place beside their button in viewport space; open upward when there is no room below */
function placeMenu(d){const m=d.querySelector(':scope>.menu'),s=d.querySelector(':scope>summary');if(!m||!s)return;
  m.classList.add('float');m.style.maxHeight='';m.style.left='0px';m.style.top='0px';
  const r=s.getBoundingClientRect(),w=m.offsetWidth,h=m.offsetHeight,vw=document.documentElement.clientWidth,vh=innerHeight,pad=8,gap=4;
  let left=r.right-w;if(left<pad)left=r.left;left=Math.max(pad,Math.min(left,vw-w-pad));
  const below=vh-r.bottom-gap-pad,above=r.top-gap-pad;let top;
  if(h<=below||below>=above){top=r.bottom+gap;if(h>below)m.style.maxHeight=below+'px'}else{const hh=Math.min(h,above);if(h>above)m.style.maxHeight=above+'px';top=r.top-gap-hh}
  m.style.left=left+'px';m.style.top=top+'px'}
document.addEventListener('toggle',e=>{const d=e.target;if(!(d instanceof HTMLDetailsElement)||!d.matches('.pop'))return;
  if(d.open)placeMenu(d);else{const m=d.querySelector(':scope>.menu');m&&m.classList.remove('float')}},true);
const replaceMenus=()=>document.querySelectorAll('details.pop[open]').forEach(placeMenu);
addEventListener('scroll',replaceMenus,{passive:true,capture:true});addEventListener('resize',replaceMenus);

function clamps(){document.querySelectorAll('.clamp').forEach(d=>{if(d.dataset.checked||!d.offsetParent)return;d.dataset.checked=1;if(d.scrollHeight>d.clientHeight+2){const b=document.createElement('button');b.type='button';b.className='more';b.textContent='Show more';b.setAttribute('aria-expanded','false');d.after(b)}})}
clamps();document.addEventListener('toggle',clamps,true);

/* search everywhere (⌘K): roles, companies, people, tasks, pages; a pasted link becomes the next step */
const cmd=document.getElementById('cmd'),cmdQ=cmd&&cmd.querySelector('#cmd-q'),cmdList=cmd&&cmd.querySelector('#cmd-results');
const ICONS=${JSON.stringify(Object.fromEntries(["home", "list", "calendar", "briefcase", "chart", "activity", "users", "building", "eye", "timer", "plus-circle", "search", "external"].map((n) => [n, icon(n)])))};
let hits=[],active=0,seq=0,tm;
function renderCmd(){cmdList.textContent='';let last='';
  hits.forEach((h,i)=>{if(h.group!==last){const g=document.createElement('p');g.className='cmd-group';g.textContent=h.group;cmdList.append(g);last=h.group}
    const b=document.createElement('button');b.type='button';b.className='cmd-item'+(i===active?' is-active':'');b.setAttribute('role','option');b.setAttribute('aria-selected',String(i===active));b.id='cmd-opt-'+i;b.dataset.i=i;
    b.insertAdjacentHTML('afterbegin',ICONS[h.icon]||'');const body=document.createElement('span');body.className='cmd-item-body';const t=document.createElement('span');t.className='cmd-item-text';t.textContent=h.label;body.append(t);
    if(h.sub){const s=document.createElement('span');s.className='cmd-item-sub';s.textContent=h.sub;body.append(s)}b.append(body);cmdList.append(b)});
  if(!hits.length){const p=document.createElement('p');p.className='cmd-empty';p.textContent='Nothing matches. Try part of a name or company, or paste a link.';cmdList.append(p)}
  cmdQ.setAttribute('aria-activedescendant',hits.length?'cmd-opt-'+active:'')}
async function runSearch(){const my=++seq;try{const r=await fetch('/search?format=json&q='+encodeURIComponent(cmdQ.value));const j=await r.json();if(my!==seq)return;hits=j.hits||[];active=0;renderCmd()}catch{}}
function go(h){if(!h)return;if(h.href){location.href=h.href;return}
  const f=document.createElement('form');f.method='post';f.action=h.post.action;Object.entries(h.post.fields).forEach(([k,v])=>{const i=document.createElement('input');i.type='hidden';i.name=k;i.value=v;f.append(i)});document.body.append(f);f.submit()}
function moveActive(d){if(!hits.length)return;active=(active+d+hits.length)%hits.length;renderCmd();const el=document.getElementById('cmd-opt-'+active);el&&el.scrollIntoView({block:'nearest'})}
function openCmd(){if(!cmd||cmd.open)return;cmd.showModal();cmdQ.value='';cmdQ.focus();runSearch()}
if(cmd){cmd.addEventListener('click',e=>{if(e.target===cmd){cmd.close();return}const b=e.target.closest('.cmd-item[data-i]');if(b)go(hits[+b.dataset.i])});
  cmdQ.addEventListener('input',()=>{clearTimeout(tm);tm=setTimeout(runSearch,120)});
  cmdQ.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();moveActive(1)}else if(e.key==='ArrowUp'){e.preventDefault();moveActive(-1)}
    else if(e.key==='Enter'){e.preventDefault();if(hits.length)go(hits[active]);else if(cmdQ.value.trim())location.href='/search?q='+encodeURIComponent(cmdQ.value)}})}

/* selection and batch actions on Home */
const bar=document.querySelector('.action-bar');
function selected(){return [...document.querySelectorAll('.row-chk:checked')].map(c=>c.closest('[data-row]')).filter(Boolean)}
function syncBar(){if(!bar)return;const s=selected();document.querySelectorAll('[data-row]').forEach(r=>r.classList.toggle('is-selected',!!r.querySelector('.row-chk:checked')));
  bar.hidden=!s.length;bar.querySelector('[data-sel-count]').textContent=s.length;const all=document.querySelector('[data-select-all]');if(all){const rows=document.querySelectorAll('.row-chk');all.checked=rows.length>0&&s.length===rows.length}}
document.addEventListener('change',e=>{
  if(e.target.matches('.row-chk'))syncBar();
  if(e.target.matches('[data-select-all]')){document.querySelectorAll('.row-chk').forEach(c=>{if(c.offsetParent)c.checked=e.target.checked});syncBar()}
});
bar&&bar.addEventListener('click',e=>{const b=e.target.closest('[data-batch]');if(!b)return;
  if(b.dataset.batch==='clear'){document.querySelectorAll('.row-chk:checked').forEach(c=>c.checked=false);syncBar();return}
  const rows=selected();rows.forEach(r=>{const f=r.querySelector('form[data-act="'+b.dataset.batch+'"]');if(f){f.dataset.quiet='1';f.requestSubmit()}});
  toast(rows.length+(b.dataset.batch==='done'?' tasks marked as done':b.dataset.batch==='snooze'?' tasks moved to tomorrow':' reminders removed'))});

/* keyboard: ⌘K anywhere; on Home J/K move, X select, E done, H later; / focuses a page filter */
let cur=-1;
function rows(){return [...document.querySelectorAll('[data-row]')].filter(r=>r.offsetParent)}
function focusRow(i){const r=rows();if(!r.length)return;cur=Math.max(0,Math.min(i,r.length-1));r.forEach((x,k)=>x.classList.toggle('is-focus',k===cur));r[cur].scrollIntoView({block:'nearest'})}
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCmd();return}
  if(e.target.closest('input,textarea,select,[contenteditable]')||e.metaKey||e.ctrlKey||e.altKey)return;
  const q=document.querySelector('[data-filter]');
  if(e.key==='/'&&q){e.preventDefault();q.focus();return}
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){const a=document.querySelector(e.key==='ArrowLeft'?'[data-nav="prev"]':'[data-nav="next"]');if(a){e.preventDefault();location.href=a.href}return}
  if(!document.querySelector('.tasks'))return;
  const r=rows()[cur];
  if(e.key==='j'){e.preventDefault();focusRow(cur+1)}
  else if(e.key==='k'){e.preventDefault();focusRow(cur-1)}
  else if(e.key==='x'&&r){const c=r.querySelector('.row-chk');c.checked=!c.checked;syncBar()}
  else if(e.key==='e'&&r){const f=r.querySelector('form[data-act="done"]');f&&f.requestSubmit()}
  else if(e.key==='h'&&r){const f=r.querySelector('form[data-act="snooze"]');f&&f.requestSubmit()}
});

const q=document.querySelector('[data-filter]');
if(q){const items=[...document.querySelectorAll(q.dataset.filter)];const out=document.querySelector('[data-filter-count]');const none=document.querySelector('[data-filter-empty]');
  const run=()=>{const v=q.value.trim().toLowerCase();let n=0;items.forEach(r=>{const hit=!v||r.dataset.text.includes(v);r.hidden=!hit;if(hit)n++});if(out)out.textContent=n;if(none)none.hidden=n>0};
  q.addEventListener('input',run);if(q.value)run()}
})();`;

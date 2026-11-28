import type { AccessRequest } from "./early-access.ts";
import type { Step } from "./provision.ts";

/**
 * The operator's /admin page, served by the router behind the gateway's sign-in: early-access
 * requests with Approve and Decline, and everyone on the hub with how their setup stands.
 */

export interface PersonRow {
  id: string;
  email: string;
  telegram: boolean;
  /** From their engine's /worker/status; null when the engine didn't answer. */
  app: { lastSeen: string | null; queued: number } | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function ago(iso: string | number | null, now = Date.now()): string {
  if (iso === null) return "never";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const m = Math.round((now - t) / 60_000);
  if (m < 2) return "just now";
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function stepsList(json: string | null): string {
  if (!json) return "";
  let steps: Step[] = [];
  try { steps = JSON.parse(json) as Step[]; } catch { return ""; }
  return `<ul class="steps">${steps.map((s) => `<li class="${s.ok ? "ok" : "bad"}"><b>${esc(s.name)}</b> ${esc(s.detail)}</li>`).join("")}</ul>`;
}

const button = (action: string, label: string, cls = "") =>
  `<form method="post" action="${esc(action)}"><button class="btn ${cls}">${esc(label)}</button></form>`;

export function adminPage(o: { requests: AccessRequest[]; people: PersonRow[]; flash?: string; now?: number }): string {
  const now = o.now ?? Date.now();
  const pending = o.requests.filter((r) => r.status === "pending");
  const decided = o.requests.filter((r) => r.status !== "pending");
  const failed = (r: AccessRequest) => r.status === "approved" && /"ok":false/.test(r.steps ?? "");
  const reqRow = (r: AccessRequest) => `<tr>
<td><div class="who">${esc(r.email)}</div><a href="${esc(r.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>${r.verified ? ` <span class="muted">· email confirmed</span>` : ""}${stepsList(r.steps)}</td>
<td>${r.status === "pending" ? `asked ${ago(r.created_at, now)}` : `${esc(r.status)} ${ago(r.decided_at, now)}`}</td>
<td class="actions">${r.status === "pending"
    ? button(`/admin/requests/${r.id}/approve`, "Approve", "primary") + button(`/admin/requests/${r.id}/decline`, "Decline")
    : failed(r) ? button(`/admin/requests/${r.id}/approve`, "Retry failed steps", "primary") : ""}</td></tr>`;
  const personRow = (p: PersonRow) => {
    const online = p.app?.lastSeen && now - Date.parse(p.app.lastSeen) < 2 * 60_000;
    return `<tr><td><div class="who">${esc(p.email)}</div><span class="muted">${esc(p.id)}</span></td>
<td>${p.app === null ? `<span class="bad-text">engine not answering</span>` : p.app.lastSeen ? `${online ? "online" : "offline"}, seen ${ago(p.app.lastSeen, now)}` : "not installed"}</td>
<td>${p.app ? p.app.queued : "–"}</td><td>${p.telegram ? "linked" : "not linked"}</td></tr>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Admin · kindahired</title><style>
:root{--bg:#fafafa;--surface:#fff;--ink:#0a0a0a;--ink-3:#6b6b6b;--line:#e5e5e5;--accent:#171717;--on-accent:#fafafa;--ok:#15803d;--bad:#c10007;--info:#eff6ff}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--surface:#171717;--ink:#fafafa;--ink-3:#a3a3a3;--line:#2e2e2e;--accent:#fafafa;--on-accent:#0a0a0a;--ok:#86efac;--bad:#fca5a5;--info:#172554}}
*{scrollbar-width:none}::-webkit-scrollbar{display:none;width:0;height:0}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/20px ui-sans-serif,-apple-system,system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 24px 48px;display:flex;flex-direction:column;gap:28px}
h1{font-size:24px;line-height:30px;margin:0}h2{font-size:17px;margin:0 0 10px}a{color:inherit;text-underline-offset:3px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 14px;vertical-align:top;border-top:1px solid var(--line)}
th{font-weight:500;color:var(--ink-3);border-top:0;font-size:13px}.who{font-weight:500}.muted{color:var(--ink-3)}
.actions{display:flex;gap:8px;justify-content:flex-end}form{margin:0}
.btn{font:inherit;font-weight:500;height:32px;padding:0 12px;border-radius:6px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
.btn.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.empty{padding:20px 14px;color:var(--ink-3)}.flash{background:var(--info);padding:12px 14px;border-radius:10px}
.steps{list-style:none;margin:6px 0 0;padding:0;font-size:13px}.steps .ok{color:var(--ok)}.steps .bad{color:var(--bad)}.bad-text{color:var(--bad)}
</style></head><body><main>
<h1>Admin</h1>
${o.flash ? `<p class="flash" role="status">${esc(o.flash)}</p>` : ""}
<section><h2>Early access · ${pending.length} waiting</h2><div class="panel">${pending.length
    ? `<table><thead><tr><th>Who</th><th>When</th><th></th></tr></thead><tbody>${pending.map(reqRow).join("")}</tbody></table>`
    : `<p class="empty">No requests waiting.</p>`}</div></section>
<section><h2>People · ${o.people.length}</h2><div class="panel">${o.people.length
    ? `<table><thead><tr><th>Who</th><th>App</th><th>Jobs waiting</th><th>Telegram</th></tr></thead><tbody>${o.people.map(personRow).join("")}</tbody></table>`
    : `<p class="empty">Nobody yet.</p>`}</div></section>
${decided.length ? `<section><h2>Decided</h2><div class="panel"><table><thead><tr><th>Who</th><th>When</th><th></th></tr></thead><tbody>${decided.map(reqRow).join("")}</tbody></table></div></section>` : ""}
</main></body></html>`;
}

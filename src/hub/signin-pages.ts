/**
 * The gateway's own pages: sign in (email, then code) and "You're not in yet". Standalone HTML in
 * the dashboard's tokens (src/web/ui.ts), since nobody is signed in to a dashboard yet.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const MARK = `<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 9.5A9 9 0 1 1 15 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7.5 12.5l3.5 3.5L19.5 6" fill="none" stroke="var(--tick)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${esc(title)} · kindahired</title>
<style>
:root{--bg:#fafafa;--surface:#fff;--surface-2:#f5f5f5;--ink:#0a0a0a;--ink-2:#525252;--ink-3:#6b6b6b;--line:#e5e5e5;--line-strong:#d4d4d4;--accent:#171717;--accent-hover:#2a2a2a;--accent-ink:#fafafa;--danger:#c10007;--danger-soft:#fef2f2;--info-soft:#eff6ff;--tick:#15803d;--ring:0 0 0 3px rgb(161 161 161 / .5);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--surface:#171717;--surface-2:#262626;--ink:#fafafa;--ink-2:#d4d4d4;--ink-3:#a3a3a3;--line:#2e2e2e;--line-strong:#404040;--accent:#fafafa;--accent-hover:#e5e5e5;--accent-ink:#171717;--danger:#fca5a5;--danger-soft:#2a1215;--info-soft:#172554;--tick:#4ade80;--ring:0 0 0 3px rgb(115 115 115 / .6);color-scheme:dark}}
*{scrollbar-width:none}::-webkit-scrollbar{display:none;width:0;height:0}*{box-sizing:border-box}html,body{margin:0}body{min-height:100vh}
body{background:var(--bg);color:var(--ink);font:400 14px/20px ui-sans-serif,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;padding:48px 16px}
main{width:100%;max-width:400px;display:flex;flex-direction:column;gap:24px}
.brand{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px;display:flex;flex-direction:column;gap:20px;box-shadow:0 1px 2px 0 rgb(0 0 0 / .05)}
h1{margin:0;font-size:24px;line-height:30px;font-weight:600;letter-spacing:-.015em}
p{margin:0}.lede{color:var(--ink-2);font-size:15px;line-height:22px}.muted{color:var(--ink-3)}.small{font-size:13px;line-height:20px}
form{margin:0;display:flex;flex-direction:column;gap:16px}
label{display:flex;flex-direction:column;gap:6px;font-weight:500}
input{font:inherit;font-weight:400;height:40px;padding:0 12px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:none;box-shadow:var(--ring)}
input.code{font-size:22px;letter-spacing:8px;text-align:center;font-variant-numeric:tabular-nums;height:52px}
input[aria-invalid=true]{border-color:var(--danger)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:500 14px/1 inherit;font-family:inherit;cursor:pointer;text-decoration:none}
.btn:hover{background:var(--surface-2)}.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}.btn.primary:hover{background:var(--accent-hover)}
.link{background:none;border:0;padding:0;font:inherit;color:var(--ink);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.row{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center}
.error{background:var(--danger-soft);color:var(--danger);padding:10px 12px;border-radius:8px}
.notice{background:var(--info-soft);padding:10px 12px;border-radius:8px}
a{color:var(--ink);text-underline-offset:3px}
</style></head><body><main><div class="brand">${MARK}kindahired</div>${body}</main></body></html>`;
}

const msg = (error?: string, notice?: string) =>
  `${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ""}`;

export function emailPage(o: { next: string; email?: string; error?: string }): string {
  return shell("Sign in", `<div class="card"><div><h1>Sign in</h1></div>${msg(o.error)}
<form method="post" action="/signin"><input type="hidden" name="next" value="${esc(o.next)}">
<label>Email<input type="email" name="email" value="${esc(o.email ?? "")}" required autocomplete="email" autofocus${o.error ? ' aria-invalid="true"' : ""}></label>
<button class="btn primary">Email me a code</button></form></div>
<p class="small muted">New here? <a href="https://kindahired.kindavishal.dev/#get">Request early access</a></p>`);
}

export function codePage(o: { email: string; next: string; error?: string; notice?: string }): string {
  const hidden = `<input type="hidden" name="email" value="${esc(o.email)}"><input type="hidden" name="next" value="${esc(o.next)}">`;
  return shell("Enter your code", `<div class="card"><div><h1>Check your email</h1><p class="lede" style="margin-top:8px">We sent a 6-digit code to <strong>${esc(o.email)}</strong>. It works for 10 minutes.</p></div>${msg(o.error, o.notice)}
<form method="post" action="/signin/code">${hidden}
<label>Code<input class="code" name="code" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" required autocomplete="one-time-code" autofocus${o.error ? ' aria-invalid="true"' : ""}></label>
<button class="btn primary">Sign in</button></form>
<div class="row small"><form method="post" action="/signin">${hidden}<button class="link">Send a new code</button></form><a href="/signin?next=${encodeURIComponent(o.next)}">Use a different email</a></div></div>
<p class="small muted">No email? Check spam for one from hired@kindavishal.dev.</p>`);
}

export type RequestStatus = "none" | "pending" | "declined" | "approved";

export function notInYetPage(o: { email: string; status: RequestStatus; error?: string; linkedin?: string }): string {
  const signOut = `<form method="post" action="/signout"><button class="link">Sign out</button></form>`;
  if (o.status === "approved") {
    return shell("Almost there", `<div class="card"><div><h1>You're in</h1><p class="lede" style="margin-top:8px">Your dashboard is being set up. Try again in a minute.</p></div>
<a class="btn primary" href="/">Try again</a></div><div class="row small muted">Signed in as ${esc(o.email)}. ${signOut}</div>`);
  }
  if (o.status === "pending" || o.status === "declined") {
    return shell("You're on the list", `<div class="card"><div><h1>You're on the list</h1><p class="lede" style="margin-top:8px">kindahired is in early access. We'll email ${esc(o.email)} when you're in.</p></div></div>
<div class="row small muted">Signed in as ${esc(o.email)}. ${signOut}</div>`);
  }
  return shell("You're not in yet", `<div class="card"><div><h1>You're not in yet</h1><p class="lede" style="margin-top:8px">kindahired is in early access. Ask for a spot and we'll email ${esc(o.email)} when you're in.</p></div>${msg(o.error)}
<form method="post" action="/request-access">
<label>LinkedIn profile<input type="text" inputmode="url" spellcheck="false" autocapitalize="off" name="linkedin" value="${esc(o.linkedin ?? "")}" required placeholder="linkedin.com/in/your-name" autocomplete="url" autofocus${o.error ? ' aria-invalid="true"' : ""}></label>
<button class="btn primary">Request access</button></form></div>
<div class="row small muted">Signed in as ${esc(o.email)}. ${signOut}</div>`);
}

export function problemPage(title: string, text: string): string {
  return shell(title, `<div class="card"><div><h1>${esc(title)}</h1><p class="lede" style="margin-top:8px">${esc(text)}</p></div><a class="btn" href="/signin">Back to sign in</a></div>`);
}

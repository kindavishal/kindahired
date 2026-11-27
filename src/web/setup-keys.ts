import crypto from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { DATA_DIR } from "../config.ts";
import { backToSetup, errorBox, hubMode, readForm, refuseCrossOrigin, sameOrigin, sendHtml } from "./forms.ts";
import { esc, page } from "./ui.ts";

/**
 * AI keys and settings, for hub mode (JH_HUB=1). Writes the person's own `<DATA_DIR>/.env`,
 * changing only the keys below and keeping every other line, comments included. Secrets are never
 * sent back to the browser: the page shows the last four characters at most. The engine reads the
 * file at start, so a save ends the process and systemd starts it again (Restart=always).
 */

type Spec = { key: string; label: string; hint: string; kind: "text" | "secret" | "quick" | "number" };
export const KEY_SPECS: Spec[] = [
  { key: "MY_EMAILS", label: "Your email addresses", kind: "text", hint: "Comma-separated. Emails from these addresses count as sent by you." },
  { key: "JH_TIMEZONE", label: "Time zone", kind: "text", hint: "An IANA name such as Asia/Kolkata or Europe/London. Reminders and the digest follow it." },
  { key: "GEMINI_API_KEY", label: "Gemini API key", kind: "secret", hint: "For quick steps: screening alerts and reading postings. Free from Google AI Studio." },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", kind: "secret", hint: "Needed only to run quick steps on Haiku." },
  { key: "JH_QUICK", label: "Quick steps run on", kind: "quick", hint: "Haiku needs an Anthropic API key." },
  { key: "FIRECRAWL_API_KEY", label: "Firecrawl API key", kind: "secret", hint: "Optional. Reads careers pages that block a plain browser." },
  { key: "X_BEARER_TOKEN", label: "X bearer token", kind: "secret", hint: "Optional. Finds roles posted on X." },
  { key: "X_MONTHLY_BUDGET_USD", label: "X monthly budget (USD)", kind: "number", hint: "Optional. The X search stops for the month at this spend." },
];

export const envFile = () => path.join(DATA_DIR, ".env");
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw: string): string {
  const v = raw.trim();
  const q = v.match(/^(["'`])(.*)\1$/);
  if (q) return q[2];
  return v.replace(/\s+#.*$/, "");
}

/** The value of each key in a .env text. Later lines win, as they do for systemd. */
export function envValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LINE);
    if (m) out.set(m[1], unquote(m[2]));
  }
  return out;
}

/**
 * Applies changes to a .env text: a string sets the key (in place, where it already is), null
 * removes it. Every other line stays exactly as it was.
 */
export function updateEnvText(text: string, changes: Record<string, string | null>): string {
  const lines = text === "" ? [] : text.split("\n");
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  const placed = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.match(LINE)?.[1];
    if (!key || !Object.hasOwn(changes, key)) { out.push(line); continue; }
    const value = changes[key];
    if (value === null || placed.has(key)) continue;
    out.push(`${key}=${value}`);
    placed.add(key);
  }
  for (const [key, value] of Object.entries(changes)) if (value !== null && !placed.has(key)) out.push(`${key}=${value}`);
  return out.length ? out.join("\n") + "\n" : "";
}

const readEnv = () => (existsSync(envFile()) ? readFileSync(envFile(), "utf8") : "");

/** Done once there is an AI key for the quick steps, in the settings file or the hub's. */
export function keysDone(): boolean {
  const v = envValues(readEnv());
  return Boolean(v.get("GEMINI_API_KEY") || v.get("ANTHROPIC_API_KEY") || process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

function writeEnv(text: string): void {
  const file = envFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** What the page may show for a secret: "set (ends …abcd)", never more. */
export const secretLabel = (v: string | undefined) =>
  !v ? "not set" : v.length >= 12 ? `set (ends …${v.slice(-4)})` : "set";

const isTimeZone = (s: string) => { try { new Intl.DateTimeFormat("en", { timeZone: s }); return true; } catch { return false; } };

/** Checks the form against the current values and works out the changes. Messages never quote a secret. */
export function keyChanges(form: URLSearchParams, current: Map<string, string>): { changes: Record<string, string | null>; errors: string[] } {
  const changes: Record<string, string | null> = {};
  const errors: string[] = [];
  const next = new Map(current);
  for (const s of KEY_SPECS) {
    const raw = form.get(s.key) ?? "";
    if (/["'`\r\n\0#]/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) {
      errors.push(`${s.label}: use one line with no quotes, # or line breaks.`);
      continue;
    }
    const v = raw.trim();
    if (v.length > 500) { errors.push(`${s.label} is too long.`); continue; }
    if (s.kind === "secret") {
      const remove = form.get(`${s.key}__remove`) === "1";
      if (v && remove) { errors.push(`${s.label}: either replace it or remove it, not both.`); continue; }
      if (v && /\s/.test(v)) { errors.push(`${s.label} can't contain spaces.`); continue; }
      if (v) next.set(s.key, v);
      else if (remove) next.delete(s.key);
      continue;
    }
    if (s.kind === "quick") {
      const choice = v || (current.get(s.key) ?? "gemini");
      if (choice !== "gemini" && choice !== "haiku") { errors.push(`${s.label}: pick Gemini or Haiku.`); continue; }
      if (choice === (current.get(s.key) ?? "gemini")) continue;
      next.set(s.key, choice);
      continue;
    }
    if (s.key === "MY_EMAILS" && v) {
      const bad = v.split(",").map((x) => x.trim()).filter((x) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(x));
      if (bad.length) { errors.push(`${s.label}: ${bad.map((b) => `"${b}"`).join(", ")} ${bad.length === 1 ? "isn't an email address" : "aren't email addresses"}.`); continue; }
    }
    if (s.key === "JH_TIMEZONE" && v && !isTimeZone(v)) { errors.push(`${s.label}: "${v}" isn't a time zone name. Try Asia/Kolkata.`); continue; }
    if (s.kind === "number" && v && !(/^\d+(\.\d+)?$/.test(v))) { errors.push(`${s.label} must be a number, such as 20.`); continue; }
    if (v) next.set(s.key, v);
    else next.delete(s.key);
  }
  if (next.get("JH_QUICK") === "haiku" && !next.get("ANTHROPIC_API_KEY")) {
    errors.push("Quick steps can run on Haiku only with an Anthropic API key. Add the key, or pick Gemini.");
  }
  if (errors.length) return { changes: {}, errors };
  for (const s of KEY_SPECS) {
    const before = current.get(s.key);
    const after = next.get(s.key);
    if (before !== after) changes[s.key] = after ?? null;
  }
  return { changes, errors };
}

// ---------- restart ----------

/** This process's id, so the saved page can tell when a new engine answers. */
const BOOT = crypto.randomUUID();
const exitSoon = () => { setTimeout(() => process.exit(0), 1000); };
let restart: () => void = exitSoon;

/** Tests swap the restart so the process stays up. Pass nothing to restore it. */
export function setRestart(fn?: () => void): void {
  restart = fn ?? exitSoon;
}

// ---------- pages ----------

function row(s: Spec, values: Map<string, string>): string {
  const v = values.get(s.key);
  const id = `k-${s.key}`;
  if (s.kind === "secret") {
    return `<div class="form-row"><label for="${id}">${esc(s.label)}</label><p class="hint">${esc(s.hint)} Now: <strong data-state="${s.key}">${esc(secretLabel(v))}</strong>.</p>
<input id="${id}" type="password" name="${s.key}" value="" autocomplete="off" spellcheck="false" placeholder="${v ? "Replace: paste a new key" : "Paste the key"}">
${v ? `<label class="choice"><input type="checkbox" name="${s.key}__remove" value="1"> Remove this key</label>` : ""}</div>`;
  }
  if (s.kind === "quick") {
    const cur = v ?? "gemini";
    const opt = (val: string, label: string) =>
      `<label class="choice"><input type="radio" name="${s.key}" value="${val}"${cur === val ? " checked" : ""}> ${label}</label>`;
    return `<fieldset class="form-row"><legend>${esc(s.label)}</legend><p class="hint">${esc(s.hint)}</p>${opt("gemini", "Gemini (default)")}${opt("haiku", "Haiku")}</fieldset>`;
  }
  return `<div class="form-row"><label for="${id}">${esc(s.label)}</label><p class="hint">${esc(s.hint)}</p>
<input id="${id}" type="${s.kind === "number" ? "number" : "text"}"${s.kind === "number" ? ` min="0" step="any"` : ""} name="${s.key}" value="${esc(v ?? "")}" spellcheck="false"></div>`;
}

function keysPage(values: Map<string, string>, o: { errors?: string[]; flash?: string | null } = {}): string {
  return page("AI keys · kindahired", `<div class="stack setup">${backToSetup}
<div><h1>AI keys and settings</h1><p class="lede">Keys are stored only in your own settings file on the hub. This page never shows a saved key again, only its last four characters.</p>
<p class="hint">Leave a key field empty to keep the key you have. Saving restarts your engine, which takes a few seconds.</p></div>
${errorBox(o.errors ?? [])}
<form method="post" action="/setup/keys" class="stack" autocomplete="off">
<div class="panel">${KEY_SPECS.map((s) => row(s, values)).join("")}</div>
<div class="btn-row"><button class="btn primary">Save and restart</button></div></form>
</div>`, { tab: "setup", flash: o.flash });
}

function restartingPage(): string {
  const done = "/setup/keys?flash=" + encodeURIComponent("Saved. Your engine has restarted.");
  return page("Restarting · kindahired", `<noscript><meta http-equiv="refresh" content="8;url=${esc(done)}"></noscript>
<div class="stack setup"><h1>Saved. Restarting your engine…</h1>
<p class="lede">This page reloads once the engine answers again, usually within 10 seconds.</p>
<p class="hint"><a href="${esc(done)}">Reload now</a></p></div>
<script>(function(){var boot=${JSON.stringify(BOOT)};function tick(){fetch('/setup/keys/ping',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.boot!==boot){location.href=${JSON.stringify(done)}}else{setTimeout(tick,1500)}},function(){setTimeout(tick,1500)})}setTimeout(tick,2000)})();</script>`, { tab: "setup" });
}

/** Handles /setup/keys and /setup/keys/ping. Returns false for any other path. */
export async function setupKeysRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!hubMode()) return false;
  if (url.pathname === "/setup/keys/ping" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ boot: BOOT }));
    return true;
  }
  if (url.pathname !== "/setup/keys") return false;
  if (req.method === "GET") {
    sendHtml(res, 200, keysPage(envValues(readEnv()), { flash: url.searchParams.get("flash") }));
    return true;
  }
  if (req.method !== "POST") return false;
  if (!sameOrigin(req)) { refuseCrossOrigin(res); return true; }
  const text = readEnv();
  const current = envValues(text);
  const form = await readForm(req, 64 * 1024);
  if (!form) { sendHtml(res, 413, keysPage(current, { errors: ["That form was too large."] })); return true; }
  const { changes, errors } = keyChanges(form, current);
  if (errors.length) { sendHtml(res, 400, keysPage(current, { errors })); return true; }
  if (!Object.keys(changes).length) {
    res.writeHead(303, { location: "/setup/keys?flash=" + encodeURIComponent("Nothing changed."), "cache-control": "no-store" });
    res.end();
    return true;
  }
  writeEnv(updateEnvText(text, changes));
  // Names only: values never reach the log.
  console.log(`Settings saved (${Object.keys(changes).join(", ")}). Restarting the engine.`);
  res.on("finish", () => restart());
  sendHtml(res, 200, restartingPage());
  return true;
}

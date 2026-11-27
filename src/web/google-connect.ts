import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type http from "node:http";
import type { Credentials } from "google-auth-library";
import { PATHS } from "../config.ts";
import { kvGet, kvSet } from "../db/index.ts";
import { CALENDAR_SCOPE, GOOGLE_SCOPES, googleConnected, grantedScopes, oauthClient, saveGoogleToken } from "../sources/google-auth.ts";
import { esc, linkButton, page, postButton } from "./ui.ts";

/**
 * Connect Google, for hub mode (JH_HUB=1). Same consent and scopes as `npm run jh -- auth:google`,
 * but the callback is the hub's public address, so it works from the browser. The gateway lets
 * /oauth/google/callback through on the person's Cloudflare Access cookie like any other page.
 */

const hubMode = () => process.env.JH_HUB === "1";
const STATE_KEY = "google.oauthStates";
const EMAIL_KEY = "google.email";
const STATE_TTL_MS = 10 * 60 * 1000;

export type GoogleExchange = (code: string, redirectUri: string) => Promise<{ tokens: Credentials; email?: string }>;

/** Trades the code for tokens, then asks Gmail which account it is (the scopes include no openid). */
const defaultExchange: GoogleExchange = async (code, redirectUri) => {
  const { tokens } = await oauthClient(redirectUri).getToken(code);
  let email: string | undefined;
  try {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (res.ok) email = ((await res.json()) as { emailAddress?: string }).emailAddress;
  } catch { /* the email is only for display */ }
  return { tokens, email };
};
let exchange: GoogleExchange = defaultExchange;

/** Tests swap the token exchange so nothing calls Google. Pass nothing to restore it. */
export function setGoogleExchange(fn?: GoogleExchange): void {
  exchange = fn ?? defaultExchange;
}

/** The callback on this hub: JH_PUBLIC_URL plus oauth/google/callback. */
export function googleRedirectUri(): string | null {
  const base = process.env.JH_PUBLIC_URL;
  if (!base) return null;
  return new URL("oauth/google/callback", base.endsWith("/") ? base : `${base}/`).toString();
}

type States = Record<string, number>;
function loadStates(now = Date.now()): States {
  let all: States = {};
  try { all = JSON.parse(kvGet(STATE_KEY) ?? "{}"); } catch { /* start over */ }
  return Object.fromEntries(Object.entries(all).filter(([, exp]) => exp > now));
}

/** Removes the state and reports whether it was live. Each state works once. */
function takeState(state: string | null): boolean {
  if (!state) return false;
  const states = loadStates();
  const ok = Object.hasOwn(states, state);
  delete states[state];
  kvSet(STATE_KEY, JSON.stringify(states));
  return ok;
}

const SCOPE_LABEL: Record<string, string> = {
  "https://www.googleapis.com/auth/gmail.readonly": "Gmail, read-only",
  [CALENDAR_SCOPE]: "Calendar, read-only",
  "https://www.googleapis.com/auth/spreadsheets": "Sheets",
  "https://www.googleapis.com/auth/drive.file": "Drive, only files this tool creates",
};

const UNVERIFIED = `<p class="muted">Google shows a <strong>"Google hasn't verified this app"</strong> screen the first time. Click <strong>Advanced</strong>, then <strong>Go to kindahired</strong>. You only see it once.</p>`;

function statusPage(): string {
  if (googleConnected()) {
    const scopes = grantedScopes();
    const email = kvGet(EMAIL_KEY);
    const missing = GOOGLE_SCOPES.filter((s) => !scopes.includes(s));
    return page("Google · Job hunt", `<div class="stack"><h1>Google is connected</h1>
<p class="lede">${email ? `Signed in as <strong>${esc(email)}</strong>.` : "Your Google account is connected."} ${scopes.includes(CALENDAR_SCOPE) ? "Calendar is allowed, so interview times come in on their own." : "Calendar isn't allowed yet, so interview times won't come in."}</p>
<ul>${GOOGLE_SCOPES.map((s) => `<li>${esc(SCOPE_LABEL[s] ?? s)}: ${scopes.includes(s) ? "allowed" : "not allowed"}</li>`).join("")}</ul>
${missing.length ? `<p>Connect again and tick every box to allow the rest.</p>${UNVERIFIED}` : ""}
<div class="btn-row">${postButton("/oauth/google/start", missing.length ? "Connect again" : "Reconnect Google", { variant: missing.length ? "primary" : "default" })}${linkButton("/", "Back to Home", missing.length ? "default" : "primary")}</div></div>`);
  }
  return page("Google · Job hunt", `<div class="stack"><h1>Connect Google</h1>
<p class="lede">The dashboard reads job alerts and replies from your Gmail (read-only, it never sends email), interview times from your Calendar (read-only), and keeps your tracker in Sheets. In Drive it can only see the files it creates.</p>
${UNVERIFIED}
<p>${postButton("/oauth/google/start", "Connect Google", { variant: "primary" })}</p></div>`);
}

function problem(res: http.ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page("Google · Job hunt", `<div class="stack"><h1>${esc(title)}</h1>${body}
<div class="btn-row">${postButton("/oauth/google/start", "Try again", { variant: "primary" })}${linkButton("/google", "Back")}</div></div>`));
}

/** Handles /google, /oauth/google/start and /oauth/google/callback. Returns false for any other path. */
export async function googleConnectRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!hubMode()) return false;
  const path = url.pathname;

  if (path === "/google" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(statusPage());
    return true;
  }

  if (path === "/oauth/google/start" && req.method === "POST") {
    const redirectUri = googleRedirectUri();
    if (!redirectUri) {
      problem(res, 500, "Google isn't set up on this hub", `<p>JH_PUBLIC_URL isn't set. The hub owner adds it to hub.env.</p>`);
      return true;
    }
    let authUrl: string;
    const state = crypto.randomBytes(24).toString("base64url");
    try {
      authUrl = oauthClient(redirectUri).generateAuthUrl({
        access_type: "offline", prompt: "consent", include_granted_scopes: true, scope: GOOGLE_SCOPES, state,
      });
    } catch (err) {
      problem(res, 500, "Google isn't set up on this hub", `<p>${esc(err instanceof Error ? err.message : err)}</p>`);
      return true;
    }
    const states = loadStates();
    states[state] = Date.now() + STATE_TTL_MS;
    kvSet(STATE_KEY, JSON.stringify(states));
    res.writeHead(303, { location: authUrl, "cache-control": "no-store" });
    res.end();
    return true;
  }

  if (path === "/oauth/google/callback" && req.method === "GET") {
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      takeState(state);
      if (error === "access_denied") {
        problem(res, 200, "Google wasn't connected", `<p class="lede">You cancelled on Google's screen, so nothing was connected and nothing was read.</p>
<p>The dashboard needs Gmail and Calendar (both read-only) and Sheets to find roles and track them. Connect whenever you're ready.</p>${UNVERIFIED}`);
      } else {
        problem(res, 400, "Google wasn't connected", `<p>Google said: <code>${esc(error)}</code>.</p>`);
      }
      return true;
    }
    if (!takeState(state)) {
      problem(res, 400, "That sign-in link has expired", `<p>Sign-in links work once, for 10 minutes. Start again from here.</p>`);
      return true;
    }
    const code = url.searchParams.get("code");
    const redirectUri = googleRedirectUri();
    if (!code || !redirectUri) {
      problem(res, 400, "Google wasn't connected", `<p>Google didn't send a sign-in code.</p>`);
      return true;
    }
    try {
      const { tokens, email } = await exchange(code, redirectUri);
      // A reconnect may come back without a refresh token; keep the one we have.
      const prior = existsSync(PATHS.googleToken) ? (JSON.parse(readFileSync(PATHS.googleToken, "utf8")) as Credentials) : {};
      saveGoogleToken(tokens.refresh_token || !prior.refresh_token ? tokens : { ...tokens, refresh_token: prior.refresh_token });
      if (email) kvSet(EMAIL_KEY, email);
    } catch (err) {
      problem(res, 502, "Google wasn't connected", `<p>The sign-in code couldn't be exchanged: ${esc(err instanceof Error ? err.message : err)}</p>`);
      return true;
    }
    res.writeHead(303, { location: "/google", "cache-control": "no-store" });
    res.end();
    return true;
  }

  return false;
}

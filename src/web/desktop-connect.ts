import type http from "node:http";
import { workerStatus } from "../worker/queue.ts";
import { esc, linkButton, page } from "./ui.ts";

/**
 * Desktop app setup, for hub mode (JH_HUB=1). Shows the two things the app asks for on first run:
 * this hub's address and this person's worker token. The page is behind Cloudflare Access like the
 * rest of the dashboard, so only the person signed in sees their token.
 */

const hubMode = () => process.env.JH_HUB === "1";
const RELEASES = "https://github.com/kindavishal/kindahired/releases/latest";

function desktopPage(): string {
  const hub = process.env.JH_PUBLIC_URL ?? "";
  const token = process.env.JH_WORKER_TOKEN ?? "";
  const { lastSeen, queued } = workerStatus();
  const state = lastSeen
    ? `<p class="lede">Connected. Last seen ${esc(new Date(lastSeen).toLocaleString())}. ${queued} Claude step${queued === 1 ? "" : "s"} waiting.</p>`
    : `<p class="lede">Not connected yet. ${queued} Claude step${queued === 1 ? "" : "s"} waiting for it.</p>`;
  return page("Desktop app · kindahired", `<div class="stack"><h1>Desktop app</h1>${state}
<ol>
<li>Install Claude Code and sign in to your Claude account. Run <code>claude</code> once to check.</li>
<li>${linkButton(RELEASES, "Download the app", "primary", true)} for macOS (.dmg) or Linux (.AppImage or .deb).</li>
<li>Open it and paste these two values:
<p><strong>Hub address</strong><br><code>${esc(hub || "(JH_PUBLIC_URL isn't set on the hub)")}</code></p>
<details><summary><strong>Worker token</strong> (keep it private)</summary><p><code>${esc(token || "(JH_WORKER_TOKEN isn't set on the hub)")}</code></p></details></li>
</ol>
<p class="muted">The app never asks for your Claude password. It runs the Claude Code you signed in to, on your computer.</p>
<p>${linkButton("/", "Back to Home")}</p></div>`);
}

/** Handles /desktop. Returns false for any other path. */
export function desktopConnectRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (url.pathname !== "/desktop" || !hubMode() || req.method !== "GET") return false;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(desktopPage());
  return true;
}

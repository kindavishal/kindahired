import type http from "node:http";
import { workerStatus } from "../worker/queue.ts";
import { esc, icon, linkButton, page } from "./ui.ts";

/**
 * Desktop app setup, for hub mode (JH_HUB=1). Shows the two things the app asks for on first run:
 * this hub's address and this person's worker token. The page is behind Cloudflare Access like the
 * rest of the dashboard, so only the person signed in sees their token.
 */

const hubMode = () => process.env.JH_HUB === "1";
const RELEASES_REPO = "kindavishal/kindahired";
const RELEASES = `https://github.com/${RELEASES_REPO}/releases/latest`;

type Downloads = { version: string; mac?: string; appImage?: string; deb?: string };
let cached: { at: number; value: Downloads | null } | null = null;

/** The latest release's files, so the buttons download them directly. Cached for 10 minutes; null when GitHub can't be reached. */
async function latestDownloads(): Promise<Downloads | null> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
  let value: Downloads | null = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "kindahired-hub" },
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      const rel = (await r.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
      const find = (re: RegExp) => rel.assets?.find((a) => re.test(a.name))?.browser_download_url;
      value = { version: (rel.tag_name ?? "").replace(/^desktop-v/, ""), mac: find(/\.dmg$/), appImage: find(/\.AppImage$/), deb: find(/\.deb$/) };
    }
  } catch {
    value = null;
  }
  cached = { at: Date.now(), value };
  return value;
}

function downloadButtons(d: Downloads | null): string {
  if (!d || !(d.mac || d.appImage || d.deb)) {
    return `<div class="btn-row">${linkButton(RELEASES, "Download the app", "primary", true)}</div>
<p class="muted">For macOS (.dmg) or Linux (.AppImage or .deb).</p>`;
  }
  const btns = [
    d.mac && linkButton(d.mac, `${icon("download")}macOS (.dmg)`, "primary"),
    d.appImage && linkButton(d.appImage, `${icon("download")}Linux (.AppImage)`),
    d.deb && linkButton(d.deb, `${icon("download")}Linux (.deb)`),
  ].filter(Boolean);
  return `<div class="btn-row">${btns.join("")}</div>
<p class="muted">Version ${esc(d.version)}. <a href="${esc(RELEASES)}" target="_blank" rel="noopener">All downloads</a></p>`;
}

function desktopPage(downloads: Downloads | null): string {
  const hub = process.env.JH_PUBLIC_URL ?? "";
  const token = process.env.JH_WORKER_TOKEN ?? "";
  const { lastSeen, queued } = workerStatus();
  const state = lastSeen
    ? `<p class="lede">Connected. Last seen ${esc(new Date(lastSeen).toLocaleString())}. ${queued} Claude step${queued === 1 ? "" : "s"} waiting.</p>`
    : `<p class="lede">Not connected yet. ${queued} Claude step${queued === 1 ? "" : "s"} waiting for it.</p>`;
  return page("Desktop app · kindahired", `<div class="stack"><h1>Desktop app</h1>${state}
<ol class="steps">
<li>Install Claude Code and sign in to your Claude account. Run <code>claude</code> once to check.</li>
<li><p>Download the app and install it.</p>${downloadButtons(downloads)}</li>
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
  void latestDownloads().then((d) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(desktopPage(d));
  });
  return true;
}

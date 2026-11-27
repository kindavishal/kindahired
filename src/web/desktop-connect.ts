import type http from "node:http";
import { APP_PAGE, hasApp, inApp, openInAppUrl } from "./app-presence.ts";
import { esc, icon, linkButton, page } from "./ui.ts";

/**
 * The desktop app, for hub mode (JH_HUB=1): /app is where a person gets it, and /desktop/pair hands
 * the signed-in app its worker token. The operator sees everyone's app status on /admin (the router).
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
    return `<div class="btn-row">${linkButton(RELEASES, `${icon("download")}Download for macOS or Linux`, "primary", true)}</div>`;
  }
  const btns = [
    d.mac && linkButton(d.mac, `${icon("download")}macOS (.dmg)`, "primary"),
    d.appImage && linkButton(d.appImage, `${icon("download")}Linux (.AppImage)`),
    d.deb && linkButton(d.deb, `${icon("download")}Linux (.deb)`),
  ].filter(Boolean);
  return `<div class="btn-row">${btns.join("")}</div>`;
}

/** The person's own "Get the app" page: downloads, Claude Code, sign in. */
function appPage(downloads: Downloads | null): string {
  const connected = hasApp();
  const status = connected
    ? `<div class="callout accent" role="status"><p>Your app is connected.</p>${inApp() ? "" : linkButton(openInAppUrl("/"), `Open in the app${icon("external")}`)}</div>`
    : "";
  return page("Get the app · kindahired", `<div class="stack"><div><h1>Get the kindahired app</h1>
<p class="lede">Packs and research are made by the app on your computer, with your own Claude plan.</p></div>${status}
<ol class="steps">
<li><p>Download the app and install it.</p>${downloadButtons(downloads)}</li>
<li><p>Install <a href="https://claude.com/claude-code" target="_blank" rel="noopener">Claude Code</a> and sign in to your Claude account.</p></li>
<li><p>Open the app and sign in with your email.</p></li>
</ol></div>`, { tab: "setup" });
}

/**
 * POST /desktop/pair: the desktop app calls this from its dashboard window right after the person
 * signs in, and keeps the worker token it gets back. The server only lets same-origin POSTs through,
 * and the custom header means another site can't even send it without a preflight.
 */
function pair(req: http.IncomingMessage, res: http.ServerResponse): void {
  const token = process.env.JH_WORKER_TOKEN ?? "";
  const body = (status: number, value: object) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };
  if (req.headers["x-kindahired-app"] !== "1") return body(400, { ok: false });
  if (!token) return body(503, { ok: false });
  body(200, { ok: true, token });
}

/** Handles /desktop and /desktop/pair. Returns false for any other path. */
export function desktopConnectRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (!hubMode()) return false;
  if (url.pathname === "/desktop/pair" && req.method === "POST") {
    pair(req, res);
    return true;
  }
  if (req.method !== "GET" || (url.pathname !== APP_PAGE && url.pathname !== "/desktop")) return false;
  // The old setup page's address: the app page replaced it.
  if (url.pathname === "/desktop") {
    res.writeHead(303, { location: APP_PAGE });
    res.end();
    return true;
  }
  void latestDownloads().then((d) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(appPage(d));
  });
  return true;
}

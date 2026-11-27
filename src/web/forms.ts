import type http from "node:http";
import { esc, icon, linkButton, page } from "./ui.ts";

/**
 * Shared bits for the hub's setup pages. The dashboard's other forms have no CSRF token, so these
 * pages, which write keys and personal details, accept a POST only from the dashboard itself: the
 * Origin header (or the Referer, when a browser leaves Origin out) must name the same host as Host.
 */

export const hubMode = () => process.env.JH_HUB === "1";

/** True when the POST came from a page on this same host. */
export function sameOrigin(req: http.IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const from = req.headers.origin ?? req.headers.referer;
  if (!from || from === "null") return false;
  try {
    return new URL(from).host === host;
  } catch {
    return false;
  }
}

/** Reads a urlencoded form body, up to `limit` bytes. Null when it is larger. */
export async function readForm(req: http.IncomingMessage, limit = 256 * 1024): Promise<URLSearchParams | null> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) return null;
  }
  return new URLSearchParams(data);
}

export function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

/** The answer to a POST that didn't come from this dashboard. */
export function refuseCrossOrigin(res: http.ServerResponse): void {
  sendHtml(res, 403, page("Not allowed · Job hunt", `<div class="stack setup"><h1>That form came from another site</h1>
<p class="lede">Settings can only be changed from this dashboard. Nothing was saved.</p>
<p>${linkButton("/setup", "Back to setup", "primary")}</p></div>`));
}

export const errorBox = (errors: string[]) =>
  errors.length ? `<div class="callout danger" role="alert"><p>${errors.map(esc).join("<br>")}</p></div>` : "";

export const backToSetup = `<a class="back" href="/setup">${icon("back")}Setup</a>`;

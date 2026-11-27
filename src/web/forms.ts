import type http from "node:http";
import { fromGateway } from "../hub/gateway-secret.ts";
import { esc, icon, linkButton, page } from "./ui.ts";

/**
 * Shared bits for the dashboard's forms. The forms have no CSRF token, so the server accepts a
 * POST (or any other non-GET request) only from the dashboard itself: the Origin header (or the
 * Referer, when a browser leaves Origin out) must name the same host as Host. server.ts checks
 * this once for every route except /worker/*; the setup pages check it again themselves.
 */

export const hubMode = () => process.env.JH_HUB === "1";

/**
 * True when the POST came from a page on this same host. Behind the hub's gateway (the request
 * carries the gateway secret) the public host is X-Forwarded-Host, in case a proxy rewrote Host.
 */
export function sameOrigin(req: http.IncomingMessage): boolean {
  const forwarded = req.headers["x-forwarded-host"];
  const host = (hubMode() && typeof forwarded === "string" && forwarded && fromGateway(req) ? forwarded : undefined) ?? req.headers.host;
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
  sendHtml(res, 403, page("Not allowed · kindahired", `<div class="stack setup"><h1>That form came from another site</h1>
<p class="lede">Changes can only be made from this dashboard. Nothing was saved.</p>
<p>${linkButton("/", "Back to the dashboard", "primary")}</p></div>`));
}

export const errorBox = (errors: string[]) =>
  errors.length ? `<div class="callout danger" role="alert"><p>${errors.map(esc).join("<br>")}</p></div>` : "";

export const backToSetup = `<a class="back" href="/setup">${icon("back")}Setup</a>`;

import type http from "node:http";
import { env } from "../config.ts";
import { kvGet } from "../db/index.ts";
import { api, linkChat } from "../notify/telegram.ts";
import { esc, linkButton, page, postButton } from "./ui.ts";

/**
 * Connect Telegram, for hub mode (JH_HUB=1). The hub's router hands out a one-time link to the
 * shared bot; opening it sends /start with the code, the router ties that chat to this person, and
 * linkChat() here picks the chat id up from the update. The daemon starts the bot within a minute.
 */

const hubMode = () => process.env.JH_HUB === "1";
const linked = () => Boolean(env.telegramChatId || kvGet("telegram.chatId"));
/** Whether this person's Telegram chat is linked (the setup checklist). */
export const telegramLinked = linked;

let pending: { url: string } | null = null;
let linking: Promise<unknown> | null = null;
let lastError: string | null = null;

async function requestLink(): Promise<string> {
  const res = await fetch(api("jhLinkCode"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const json = (await res.json()) as { ok: boolean; result?: { code: string; url: string }; description?: string };
  if (!json.ok || !json.result) throw new Error(json.description ?? "No link came back.");
  return json.result.url;
}

function connectPage(): string {
  if (linked()) {
    return page("Telegram · kindahired", `<div class="stack"><h1>Telegram is connected</h1>
<p class="lede">Alerts and your daily digest arrive in Telegram. The bot starts answering within a minute.</p>
<p>${linkButton("/setup", "Back to Setup", "primary")}</p></div>`);
  }
  const waiting = pending && linking;
  const body = waiting
    ? `<h1>Open the bot in Telegram</h1>
<p class="lede">Open the link on the phone or computer where you use Telegram and tap <strong>Start</strong>. This page updates once the chat is linked. The link works once, for 30 minutes.</p>
<p>${linkButton(pending!.url, "Open Telegram", "primary", true)}</p>
<p class="muted"><code>${esc(pending!.url)}</code></p>`
    : `<h1>Connect Telegram</h1>
${lastError ? `<div class="callout danger" role="alert"><p>${esc(lastError)}</p></div>` : ""}
<p class="lede">You get a one-time link to the kindahired bot. Opening it links your Telegram chat to this dashboard.</p>
<p>${postButton("/telegram/connect", "Get a link", { variant: "primary" })}</p>`;
  const refresh = waiting ? `<meta http-equiv="refresh" content="5">` : "";
  return page("Telegram · kindahired", `${refresh}<div class="stack">${body}</div>`);
}

/** Handles /telegram/connect. Returns false for any other path. */
export async function telegramConnectRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/telegram/connect" || !hubMode()) return false;
  if (req.method === "POST" && !linked()) {
    try {
      pending = { url: await requestLink() };
      lastError = null;
      linking ??= linkChat()
        .catch((err) => { lastError = `The chat wasn't linked: ${err instanceof Error ? err.message : err}`; })
        .finally(() => { linking = null; pending = null; });
    } catch (err) {
      console.error("Telegram connect:", err);
      lastError = "Couldn't get a Telegram link. Try again in a minute.";
    }
    res.writeHead(303, { location: "/telegram/connect" });
    res.end();
    return true;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(connectPage());
  return true;
}

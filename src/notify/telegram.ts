import { readFileSync } from "node:fs";
import path from "node:path";
import { env, localClock } from "../config.ts";
import { kvGet, kvSet, logEvent } from "../db/index.ts";

/** Thin Telegram Bot API client. Long polling, so it works from a laptop with no public URL. */

export type Button = { text: string; data: string } | { text: string; url: string };

/** TELEGRAM_API_BASE points at the hub's router instead of Telegram itself. */
export const api = (method: string) =>
  `${(process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "")}/bot${env.telegramToken}/${method}`;

export function telegramReady(): boolean {
  if (process.env.JH_NO_TELEGRAM) return false; // tests and dry runs never message my phone
  return Boolean(env.telegramToken && (env.telegramChatId || kvGet("telegram.chatId")));
}
function chatId(): string {
  return env.telegramChatId || kvGet("telegram.chatId") || "";
}

/** Between 11 PM and 7:30 AM your time messages arrive without a sound. */
export function quietHours(now = new Date()): boolean {
  const { minutes } = localClock(now);
  return minutes >= 23 * 60 || minutes < 7 * 60 + 30;
}

async function call<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const res = await fetch(api(method), body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

function keyboard(rows?: Button[][]) {
  if (!rows?.length) return undefined;
  return {
    inline_keyboard: rows.map((r) => r.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))),
  };
}

export const html = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TAG = /<(\/?)(b|strong|i|em|u|s|code|pre|blockquote|a|tg-spoiler)(\s[^>]*)?>/gi;

/** The tags still open at the end of an HTML fragment, outermost first, as written. */
function openTags(fragment: string): string[] {
  const stack: { name: string; raw: string }[] = [];
  for (const m of fragment.matchAll(TAG)) {
    const name = m[2].toLowerCase();
    if (m[1]) { const i = stack.map((t) => t.name).lastIndexOf(name); if (i >= 0) stack.splice(i, 1); }
    else stack.push({ name, raw: m[0] });
  }
  return stack.map((t) => t.raw);
}
const closers = (open: string[]) => [...open].reverse().map((t) => `</${t.match(/^<(\w[\w-]*)/)![1]}>`).join("");

/**
 * Telegram caps messages at 4096 characters; long ones are split on paragraph breaks (then line
 * breaks). A split inside a tag would leave "<blockquote>" open in one part and a stray
 * "</blockquote>" in the next, and Telegram rejects both, so each part closes what's open and the
 * next part reopens it.
 */
export function chunks(text: string, size = 3800): string[] {
  if (text.length <= size) return [text];
  const pieces = text.split("\n\n").flatMap((p) => (p.length > size ? p.split("\n") : [p]))
    .flatMap((p) => (p.length > size ? p.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))! : [p]));
  const raw: string[] = [];
  let cur = "";
  for (const para of pieces) {
    const sep = cur ? (text.includes(cur + "\n\n" + para) ? "\n\n" : "\n") : "";
    if (cur && (cur + sep + para).length > size) { raw.push(cur); cur = para; }
    else cur = cur + sep + para;
  }
  if (cur) raw.push(cur);
  const out: string[] = [];
  let carry: string[] = [];
  for (const part of raw) {
    const body = carry.join("") + part;
    const open = openTags(body);
    out.push(body + closers(open));
    carry = open;
  }
  return out;
}

/** Cuts HTML to a length without breaking a tag or an entity, then closes what's left open. */
export function truncateHtml(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 40);
  cut = cut.replace(/<[^>]*$/, "").replace(/&[a-z#0-9]*$/i, "");
  return cut.trimEnd() + "…" + closers(openTags(cut));
}

/** Last resort when Telegram still refuses the formatting: the same words, no tags. */
const plain = (t: string) => t.replace(TAG, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const isParseError = (err: unknown) => /can't parse entities|unsupported start tag|can't find end tag/i.test(String(err));

/** Sends a message (split if long) and returns the id of the last part. */
export async function send(
  text: string,
  buttons?: Button[][],
  opts: { silent?: boolean; forceReply?: string; replyTo?: number } = {},
): Promise<number | undefined> {
  if (!telegramReady()) return;
  const parts = chunks(text);
  let id: number | undefined;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const body = {
      chat_id: chatId(),
      text: parts[i],
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      disable_notification: opts.silent ?? quietHours(),
      reply_parameters: opts.replyTo && i === 0 ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
      reply_markup: last
        ? (opts.forceReply ? { force_reply: true, input_field_placeholder: opts.forceReply.slice(0, 64) } : keyboard(buttons))
        : undefined,
    };
    // A formatting slip loses the bold and folding, never the message.
    const sent = await call<{ message_id: number }>("sendMessage", body).catch((err) => {
      if (!isParseError(err)) throw err;
      logEvent("telegram.plain_fallback", null, String(err).slice(0, 200));
      return call<{ message_id: number }>("sendMessage", { ...body, text: plain(parts[i]), parse_mode: undefined });
    });
    id = sent.message_id;
  }
  return id;
}

export async function sendDocument(filePath: string, caption?: string, buttons?: Button[][]): Promise<number | undefined> {
  if (!telegramReady()) return;
  const form = new FormData();
  form.set("chat_id", chatId());
  if (caption) { form.set("caption", truncateHtml(caption, 1024)); form.set("parse_mode", "HTML"); }
  form.set("disable_notification", String(quietHours()));
  const markup = keyboard(buttons);
  if (markup) form.set("reply_markup", JSON.stringify(markup));
  form.set("document", new Blob([readFileSync(filePath)], { type: "application/pdf" }), path.basename(filePath));
  return (await call<{ message_id: number }>("sendDocument", form)).message_id;
}

/** Rewrites an earlier message, e.g. to show a decision on a card instead of its buttons. */
export async function editMessage(messageId: number, text: string, buttons?: Button[][]) {
  if (!telegramReady()) return;
  await call("editMessageText", {
    chat_id: chatId(), message_id: messageId, text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true }, reply_markup: keyboard(buttons) ?? { inline_keyboard: [] },
  }).catch(() => {}); // the message may be too old to edit; nothing to do then
}

/** Takes the buttons off an earlier message (works on documents too, which can't be re-texted). */
export async function clearButtons(messageId: number) {
  if (!telegramReady()) return;
  await call("editMessageReplyMarkup", { chat_id: chatId(), message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
}

export interface Incoming {
  kind: "text" | "button";
  text: string;
  callbackId?: string;
  chatId: string;
  /** For a typed reply: the message it answers. For a button: the message the button is on. */
  messageId?: number;
  replyTo?: number;
}

/** Waits up to 50 seconds for new messages or button taps. Only my chat is listened to. */
export async function poll(): Promise<Incoming[]> {
  if (!env.telegramToken || process.env.JH_NO_TELEGRAM) return [];
  const offset = Number(kvGet("telegram.offset") ?? 0);
  const updates = await call<Array<{
    update_id: number;
    message?: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { message_id: number } };
    callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
  }>>("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
  const out: Incoming[] = [];
  for (const u of updates) {
    kvSet("telegram.offset", String(u.update_id + 1));
    const from = String(u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? "");
    if (chatId() && from !== chatId()) {
      logEvent("telegram.ignored", from);
      continue;
    }
    if (u.message?.text) {
      out.push({ kind: "text", text: u.message.text, chatId: from, messageId: u.message.message_id, replyTo: u.message.reply_to_message?.message_id });
    }
    if (u.callback_query?.data) {
      out.push({ kind: "button", text: u.callback_query.data, callbackId: u.callback_query.id, chatId: from, messageId: u.callback_query.message?.message_id });
    }
  }
  return out;
}

export async function ackButton(callbackId: string, text: string) {
  await call("answerCallbackQuery", { callback_query_id: callbackId, text }).catch(() => {});
}

/** First run: I message the bot, this captures my chat id. */
export async function linkChat(): Promise<string> {
  if (!env.telegramToken) throw new Error("Set TELEGRAM_BOT_TOKEN in .env first.");
  console.log("Open your bot in Telegram and send it any message (for example /start). Waiting...");
  for (let i = 0; i < 6; i++) {
    const updates = await call<Array<{ update_id: number; message?: { chat: { id: number } } }>>("getUpdates", { timeout: 50 });
    const msg = updates.find((u) => u.message);
    if (msg?.message) {
      const id = String(msg.message.chat.id);
      kvSet("telegram.chatId", id);
      kvSet("telegram.offset", String(updates[updates.length - 1].update_id + 1));
      await call("sendMessage", { chat_id: id, text: "Linked. Job alerts and your morning summary will arrive here." });
      return id;
    }
  }
  throw new Error("No message received in 5 minutes.");
}

import { gmail, type gmail_v1 } from "@googleapis/gmail";
import { env, searchTerms } from "../config.ts";
import { htmlToText } from "../pipeline/evidence.ts";
import { googleClient } from "./google-auth.ts";

export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  fromEmail: string;
  to: string;
  subject: string;
  date: string; // ISO
  fromMe: boolean;
  labels: string[];
  body: string;
}

// Search used for the first backfill: anything that looks job-related in the last 90 days, plus your target role words.
export function backfillQuery(): string {
  const roles = searchTerms().slice(0, 12).map((t) => (/\s/.test(t) ? `"${t}"` : t));
  return `newer_than:90d -in:chats -category:social (job OR jobs OR role OR hiring OR "applied" OR application OR interview OR recruiter OR opportunity OR position OR offer OR referral${roles.map((r) => ` OR ${r}`).join("")})`;
}
export const RECENT_QUERY = "newer_than:2d -in:chats";

function api() {
  return gmail({ version: "v1", auth: googleClient() });
}

function decode(data?: string | null): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function bodyOf(part?: gmail_v1.Schema$MessagePart): string {
  if (!part) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    if (p.mimeType === "text/plain" && p.body?.data) plain.push(decode(p.body.data));
    else if (p.mimeType === "text/html" && p.body?.data) html.push(decode(p.body.data));
    p.parts?.forEach(walk);
  };
  walk(part);
  const text = plain.length ? plain.join("\n") : htmlToText(html.join("\n"));
  // Drop quoted history so each message is only what's new in it.
  return text.split(/\n(?:On .{5,120} wrote:|-{2,} ?Original Message|From: .+\nSent: )/)[0].trim().slice(0, 12000);
}

export async function listMessageIds(query: string, max = 500): Promise<{ id: string; threadId: string }[]> {
  const out: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withQuotaRetry(() => api().users.messages.list({ userId: "me", q: query, maxResults: 100, pageToken }));
    for (const m of res.data.messages ?? []) if (m.id && m.threadId) out.push({ id: m.id, threadId: m.threadId });
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries Gmail's per-minute quota errors with backoff instead of failing the whole sync. */
async function withQuotaRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { status?: number; code?: number; message?: string };
      const status = e.status ?? e.code;
      const quota = status === 429 || (status === 403 && /quota|rate/i.test(e.message ?? ""));
      if (!quota || attempt >= 5) throw err;
      await sleep(Math.min(60_000, 5_000 * 2 ** attempt));
    }
  }
}

/** Fetches messages a few at a time with a short gap, to stay inside Gmail's per-minute quota. */
export async function getMessages(ids: string[]): Promise<MailMessage[]> {
  const out: MailMessage[] = [];
  for (let i = 0; i < ids.length; i += 3) {
    out.push(...(await Promise.all(ids.slice(i, i + 3).map(getMessage))));
    await sleep(400);
  }
  return out;
}

export async function getMessage(id: string): Promise<MailMessage> {
  const res = await withQuotaRetry(() => api().users.messages.get({ userId: "me", id, format: "full" }));
  const m = res.data;
  const header = (name: string) => m.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? "";
  const from = header("from");
  const fromEmail = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  const labels = m.labelIds ?? [];
  return {
    id,
    threadId: m.threadId ?? id,
    from,
    fromEmail,
    to: header("to"),
    subject: header("subject"),
    date: new Date(Number(m.internalDate ?? Date.now())).toISOString(),
    fromMe: labels.includes("SENT") || env.myEmails.includes(fromEmail),
    labels,
    body: bodyOf(m.payload),
  };
}

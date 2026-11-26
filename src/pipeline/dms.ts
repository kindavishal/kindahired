import { createHash } from "node:crypto";
import { all, get, kvGet, kvSet, logEvent, run } from "../db/index.ts";
import { upsertContact } from "../db/contacts.ts";
import { reconcileActions } from "../loops/engine.ts";
import { readLinkedInInbox, type InboxEntry, type LinkedInConversation } from "../sources/linkedin.ts";
import type { MailMessage } from "../sources/gmail.ts";
import { classifyMail, linkThread, type ClassifiedItem } from "./ingest.ts";

/**
 * LinkedIn messages, filed like email: each job conversation becomes a thread on its role, a
 * reply to a note I sent marks that outreach as replied, and a DM I sent marks it as sent.
 *
 * Privacy: only conversations with someone I've already contacted (a known contact) or whose
 * latest line talks about a job are opened. Everything else is listed by LinkedIn on the inbox
 * page and left alone; its text is never stored or sent to the AI.
 */

export const JOB_WORDS = /\b(role|roles|hiring|hire|position|opening|opportunit(?:y|ies)|interview|recruit\w*|resume|cv|application|applied|apply|job|jd|salary|ctc|compensation|notice period|offer|team|devrel|community|referr\w*|candidate|talent)\b/i;

const SEEN = "linkedin.inbox.seen";
/** Name → a short hash of the last line, so a changed conversation is noticed without keeping its text. */
type Seen = Record<string, string>;
const fingerprint = (snippet: string) => createHash("sha256").update(snippet).digest("hex").slice(0, 12);

function knownNames(): Set<string> {
  return new Set(all<{ name: string }>("SELECT lower(name) AS name FROM contacts").map((r) => r.name.trim()));
}

/** Which inbox rows are worth opening: new or changed, and about my job search. */
export function pickConversations(entries: InboxEntry[], seen: Seen, known: Set<string>): InboxEntry[] {
  return entries.filter((e) => seen[e.name] !== fingerprint(e.snippet) && (known.has(e.name.toLowerCase()) || JOB_WORDS.test(e.snippet)));
}

/** One conversation as a message the email screener can read: its latest message, with the history as the body. */
export function asMail(c: LinkedInConversation, me: string): MailMessage {
  const last = c.messages[c.messages.length - 1];
  const transcript = c.messages.slice(-12).map((m) => `${m.fromMe ? me : m.sender || c.name} (${m.at.slice(0, 10)}): ${m.body}`).join("\n\n");
  return {
    id: last.id, threadId: c.threadId, from: last.fromMe ? me : c.name, fromEmail: "", to: last.fromMe ? c.name : me,
    subject: `LinkedIn conversation with ${c.name}`, date: last.at, fromMe: last.fromMe, labels: ["linkedin"],
    body: `[LinkedIn direct messages]\n\n${transcript}`.slice(0, 8000),
  };
}

/**
 * Files one classified conversation: thread, every message, and what it means for outreach
 * to this person (a DM I sent, or their reply). Returns the role it was filed on.
 */
export function fileConversation(c: LinkedInConversation, item: ClassifiedItem, me: string): number | null {
  const contact = upsertContact({ name: c.name, title: item.person_title ?? null });
  // A conversation with someone I reached out to about a role belongs to that role.
  const outreach = all<{ id: number; opportunity_id: number | null; status: string; sent_at: string | null; replied_at: string | null }>(
    "SELECT id, opportunity_id, status, sent_at, replied_at FROM outreach WHERE contact_id = $c ORDER BY created_at DESC", { c: contact.id },
  );
  const viaOutreach = outreach.find((r) => r.opportunity_id)?.opportunity_id ?? null;
  if (viaOutreach) {
    run(
      `INSERT INTO threads (channel, external_id, opportunity_id, contact_id, subject, kind)
       VALUES ('linkedin', $t, $o, $c, $s, 'conversation') ON CONFLICT(channel, external_id) DO NOTHING`,
      { t: c.threadId, o: viaOutreach, c: contact.id, s: `LinkedIn conversation with ${c.name}` },
    );
  }
  const mail = asMail(c, me);
  const opp = linkThread(mail, { ...item, person_name: item.person_name ?? c.name }, "linkedin", contact.id);
  const thread = get<{ id: number }>("SELECT id FROM threads WHERE channel = 'linkedin' AND external_id = $t", { t: c.threadId })!;
  // The screener saw the whole conversation as one message; the latest one keeps its own words.
  const latestMsg = c.messages[c.messages.length - 1];
  run("UPDATE messages SET body = $b, sender = $s WHERE external_id = $id", { b: latestMsg.body.slice(0, 8000), s: latestMsg.fromMe ? me : latestMsg.sender || c.name, id: latestMsg.id });
  run("UPDATE threads SET last_snippet = $b WHERE id = $id AND last_message_at = $at", { b: latestMsg.body.slice(0, 280), id: thread.id, at: latestMsg.at });
  for (const m of c.messages) {
    run(
      `INSERT INTO messages (thread_id, external_id, from_me, sender, sent_at, body)
       VALUES ($th, $id, $me, $sender, $at, $body) ON CONFLICT(external_id) DO NOTHING`,
      { th: thread.id, id: m.id, me: m.fromMe ? 1 : 0, sender: m.fromMe ? me : m.sender || c.name, at: m.at, body: m.body.slice(0, 8000) },
    );
  }

  // What the messages say about my outreach to this person.
  const firstMine = c.messages.find((m) => m.fromMe)?.at ?? null;
  const lastTheirs = [...c.messages].reverse().find((m) => !m.fromMe) ?? null;
  for (const r of outreach.filter((x) => x.opportunity_id === (opp ?? viaOutreach) || !opp)) {
    if (r.status === "skipped") continue;
    if (lastTheirs && (!r.sent_at || lastTheirs.at > r.sent_at) && (!r.replied_at || lastTheirs.at > r.replied_at) && lastTheirs.at > (firstMine ?? "")) {
      run(`UPDATE outreach SET status = 'replied', replied_at = $at, reply = $reply, sent_at = coalesce(sent_at, $sent),
             accepted_at = coalesce(accepted_at, $at) WHERE id = $id`,
        { at: lastTheirs.at, reply: lastTheirs.body.slice(0, 500), sent: firstMine, id: r.id });
    } else if (firstMine && ["drafted", "note_sent"].includes(r.status)) {
      // A conversation with my note in it means they accepted the connection (LinkedIn shows
      // nothing before that). The sync time stands in for the moment they accepted.
      run(`UPDATE outreach SET status = 'dm_sent', sent_at = coalesce(sent_at, $at),
             accepted_at = coalesce(accepted_at, $now) WHERE id = $id`, { at: firstMine, now: new Date().toISOString(), id: r.id });
    }
  }
  // My reply after theirs: the outreach becomes an ongoing conversation.
  const last = c.messages[c.messages.length - 1];
  if (last.fromMe) run("UPDATE outreach SET status = 'conversation' WHERE contact_id = $c AND status = 'replied' AND replied_at < $at", { c: contact.id, at: last.at });
  return opp ?? viaOutreach;
}

/** Reads the LinkedIn inbox and files the job conversations that changed since last time. */
export async function syncLinkedInMessages(me: string, deps: { read?: typeof readLinkedInInbox; classify?: typeof classifyMail } = {}) {
  const read = deps.read ?? readLinkedInInbox;
  const classify = deps.classify ?? classifyMail;
  let seen: Seen = {};
  try { seen = JSON.parse(kvGet(SEEN) ?? "{}"); } catch { /* start over */ }
  const known = knownNames();
  const { inbox, opened } = await read({ maxList: 25, maxOpen: 8, shouldOpen: (e) => pickConversations([e], seen, known).length > 0 });

  const stats = { listed: inbox.length, opened: opened.length, filed: 0, needsReply: 0, roles: [] as number[] };
  if (opened.length) {
    const mails = opened.map((c) => asMail(c, me));
    const classified = await classify(mails);
    for (const c of opened) {
      const item = classified.find((r) => r.message_id === c.messages[c.messages.length - 1].id);
      if (item && item.kind !== "other") {
        const opp = fileConversation(c, item, me);
        stats.filed++;
        if (opp && !stats.roles.includes(opp)) stats.roles.push(opp);
        if (!c.messages[c.messages.length - 1].fromMe && item.needs_my_reply) stats.needsReply++;
      }
      seen[c.name] = fingerprint(c.snippet);
    }
  }
  // Rows that aren't about the job search are remembered as unchanged. Job rows left over by the
  // per-run cap stay unseen, so the next run opens them.
  const wanted = new Set(pickConversations(inbox, seen, known).map((e) => e.name));
  for (const e of inbox) if (!wanted.has(e.name)) seen[e.name] = fingerprint(e.snippet);
  kvSet(SEEN, JSON.stringify(seen));
  kvSet("linkedin.inbox.lastSync", new Date().toISOString());
  reconcileActions();
  logEvent("linkedin.messages", null, stats);
  return stats;
}

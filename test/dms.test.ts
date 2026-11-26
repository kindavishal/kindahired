import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { all, get, run, useMemoryDb } from "../src/db/index.ts";
import { upsertContact } from "../src/db/contacts.ts";
import { upsertOpportunity } from "../src/db/opportunities.ts";
import { dueActions } from "../src/loops/engine.ts";
import { pickConversations, syncLinkedInMessages } from "../src/pipeline/dms.ts";
import type { ClassifiedItem } from "../src/pipeline/ingest.ts";
import { messageTime, type InboxEntry, type LinkedInConversation } from "../src/sources/linkedin.ts";

beforeEach(() => useMemoryDb());

const urn = (ms: number, n = 0) => `urn:li:msg_message:(urn:li:fsd_profile:ME,2-${Buffer.from(`${ms}b7${n}-100&abc`).toString("base64")})`;
const T = (iso: string) => new Date(iso).getTime();

test("a message's time comes from its ID", () => {
  assert.equal(messageTime("urn:li:msg_message:(urn:li:fsd_profile:A,2-MTc5NTA4MDA5NTgwMmI3MDY0NC0xMDAmYzYz)"), "2026-11-19T09:21:35.802Z");
  assert.equal(messageTime("nonsense"), null);
});

test("only job conversations are opened: known contacts, or a last line about a role", () => {
  const entries: InboxEntry[] = [
    { index: 0, name: "Omar Haddad", snippet: "Ekhono bhalo ekta job pelam na", fromMe: false, unread: false },
    { index: 1, name: "Lena Fischer", snippet: "Got a chance?", fromMe: true, unread: false },
    { index: 2, name: "Mira Shah", snippet: "We're hiring for a DevRel lead, keen to chat?", fromMe: false, unread: true },
    { index: 3, name: "Old Friend", snippet: "see you saturday", fromMe: false, unread: false },
  ];
  const picked = pickConversations(entries, {}, new Set(["lena fischer"])).map((e) => e.name);
  // "job" in a personal chat still matches the word list; the AI screen then drops it unstored.
  assert.deepEqual(picked, ["Omar Haddad", "Lena Fischer", "Mira Shah"]);
});

const convo = (name: string, threadId: string, msgs: [boolean, string, string][]): LinkedInConversation => ({
  index: 0, name, snippet: msgs[msgs.length - 1][2], fromMe: msgs[msgs.length - 1][0], unread: false, threadId,
  url: `https://www.linkedin.com/messaging/thread/${threadId}/`,
  messages: msgs.map(([fromMe, at, body], i) => ({ id: urn(T(at), i), fromMe, sender: fromMe ? "Sam Rivera" : name, at, body })),
});

const item = (over: Partial<ClassifiedItem>): ClassifiedItem => ({
  message_id: "", kind: "conversation", jobs: [], about_company: null, about_role: null, person_name: null, person_title: null,
  needs_my_reply: false, update: "none", ...over,
});

test("a reply to my LinkedIn note is filed on the role, marks the outreach replied, and asks me to answer", async () => {
  const o = upsertOpportunity("Helius", "Developer Advocate", { status: "applied", date_applied: "2026-11-18" });
  const c = upsertContact({ name: "Lena Fischer" });
  run("INSERT INTO outreach (opportunity_id, contact_id, status, sent_at) VALUES ($o, $c, 'drafted', NULL)", { o: o.id, c: c.id });
  const conv = convo("Lena Fischer", "T1", [
    [true, "2026-11-19T09:21:35.000Z", "Hi Lena, Grace passed my profile to you for the Helius role"],
    [false, "2026-11-19T12:20:00.000Z", "Thanks for reaching out! Can you share your availability for a call?"],
  ]);
  const r = await syncLinkedInMessages("Sam Rivera", {
    read: async (opts) => ({ inbox: [conv], opened: [conv].filter(opts.shouldOpen) }),
    classify: async (mails) => mails.map((m) => item({ message_id: m.id, about_company: "Helius", about_role: "Developer Advocate", needs_my_reply: true })),
  });
  assert.equal(r.filed, 1);
  const t = get<{ opportunity_id: number; channel: string; last_from: string; needs_reply: number }>("SELECT * FROM threads")!;
  assert.deepEqual([t.opportunity_id, t.channel, t.last_from, t.needs_reply], [o.id, "linkedin", "them", 1]);
  assert.equal(all("SELECT * FROM messages").length, 2);
  assert.match(get<{ last_snippet: string }>("SELECT last_snippet FROM threads")!.last_snippet, /^Thanks for reaching out/);
  assert.ok(!all<{ body: string }>("SELECT body FROM messages").some((m) => m.body.includes("[LinkedIn direct messages]")));
  const out = get<{ status: string; sent_at: string; replied_at: string }>("SELECT * FROM outreach")!;
  assert.equal(out.status, "replied");
  assert.equal(out.sent_at, "2026-11-19T09:21:35.000Z");
  const now = new Date("2026-11-20T10:00:00Z");
  assert.ok(dueActions(now).some((a) => a.kind === "reply" && /Lena Fischer/.test(a.title)));

  // Nothing changed: the next run doesn't open it again.
  let opened = 0;
  await syncLinkedInMessages("Sam Rivera", {
    read: async (opts) => { const o2 = [conv].filter(opts.shouldOpen); opened = o2.length; return { inbox: [conv], opened: o2 }; },
    classify: async () => { throw new Error("should not classify"); },
  });
  assert.equal(opened, 0);
});

test("a DM I sent marks the drafted outreach as sent; a personal chat is never stored", async () => {
  const o = upsertOpportunity("Acme", "DevRel", { status: "ready" });
  const c = upsertContact({ name: "Mira Shah" });
  run("INSERT INTO outreach (opportunity_id, contact_id, status) VALUES ($o, $c, 'drafted')", { o: o.id, c: c.id });
  const mine = convo("Mira Shah", "T2", [[true, "2026-11-21T05:00:00.000Z", "Hi Mira, I'd love to talk about the DevRel role"]]);
  const personal = convo("Omar Haddad", "T3", [[false, "2026-11-21T06:00:00.000Z", "no job yet, startups are a mess"]]);
  await syncLinkedInMessages("Sam Rivera", {
    read: async (opts) => ({ inbox: [mine, personal], opened: [mine, personal].filter(opts.shouldOpen) }),
    classify: async (mails) => mails.map((m) => item({ message_id: m.id, kind: m.threadId === "T3" ? "other" : "conversation" })),
  });
  assert.equal(get<{ status: string }>("SELECT status FROM outreach")!.status, "dm_sent");
  assert.deepEqual(all<{ external_id: string }>("SELECT external_id FROM threads").map((t) => t.external_id), ["T2"]);
  assert.ok(!all<{ body: string }>("SELECT body FROM messages").some((m) => /startups/.test(m.body)));
  assert.ok(!(get<{ value: string }>("SELECT value FROM kv WHERE key = 'linkedin.inbox.seen'")!.value).includes("startups"));
});

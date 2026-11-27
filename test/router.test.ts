import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { loadPeople, savePeople, type Person } from "../src/hub/people.ts";
import { startRouter, type Router } from "../src/hub/router.ts";

/** A stand-in for api.telegram.org that records every call the router forwards. */
type Call = { method: string; token: string; type: string; body: Record<string, unknown> };
const calls: Call[] = [];
let fake: http.Server;
let fakeBase = "";

const SECRET = "webhook-secret";
let dir = "";
let router: Router;
let base = "";

const person = (id: string, chatId: number | null): Person => ({
  id, email: `${id}@example.com`, port: 4400, relaySecret: `relay-${id}`, workerToken: `worker-${id}`, chatId,
});

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: { ok?: boolean; result?: any; description?: string } = {};
  try { json = JSON.parse(text); } catch { /* the webhook answers in plain text */ }
  return { status: res.status, json, text };
}
const relay = (who: string, method: string, body: unknown = {}) => post(`${base}/relay/botrelay-${who}/${method}`, body);
const webhook = (update: unknown, secret = SECRET) => post(`${base}/telegram/webhook`, update, { "x-telegram-bot-api-secret-token": secret });
const msg = (chat: number, text: string, update_id = 1) => ({ update_id, message: { message_id: update_id, chat: { id: chat }, text } });

before(async () => {
  fake = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const raw = Buffer.concat(parts);
    const [, token, method] = req.url!.match(/^\/bot([^/]+)\/(\w+)$/)!;
    const type = String(req.headers["content-type"] ?? "");
    let body: Record<string, unknown> = {};
    if (type.startsWith("multipart/")) {
      const form = await new Request("http://x/", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(raw) }).formData();
      for (const [k, v] of form) body[k] = typeof v === "string" ? v : `<file ${v.name}>`;
    } else if (raw.length) body = JSON.parse(raw.toString());
    calls.push({ method, token, type, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(method === "getMe" ? { ok: true, result: { username: "jh_test_bot" } } : { ok: true, result: { message_id: 42 } }));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((r) => fake.close(() => r()));
});

beforeEach(async () => {
  if (router) await router.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(os.tmpdir(), "jh-router-"));
  savePeople([person("ana", 111), person("ben", 222), person("cat", null)], dir);
  calls.length = 0;
  router = await startRouter({ port: 0, hubDir: dir, botToken: "REAL", webhookSecret: SECRET, telegramBase: fakeBase, log: () => {} });
  base = `http://127.0.0.1:${router.port}`;
});

after(async () => {
  await router?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("the webhook puts each update in the queue of the person whose chat it came from", async () => {
  assert.equal((await webhook(msg(222, "hello ben", 9001))).status, 200);
  const ben = await relay("ben", "getUpdates", { offset: 0, timeout: 0 });
  assert.equal(ben.json.ok, true);
  assert.equal(ben.json.result.length, 1);
  assert.equal(ben.json.result[0].message.text, "hello ben");
  assert.equal(ben.json.result[0].update_id, 1, "update ids are the router's own, per person");
  const ana = await relay("ana", "getUpdates", { offset: 0, timeout: 0 });
  assert.deepEqual(ana.json.result, []);
});

test("an update from a chat nobody owns is dropped", async () => {
  assert.equal((await webhook(msg(999, "who is this"))).status, 200);
  for (const who of ["ana", "ben", "cat"]) {
    assert.deepEqual((await relay(who, "getUpdates", { timeout: 0 })).json.result, []);
  }
  assert.equal(calls.length, 0);
});

test("/start with a link code ties the chat to that person, queues the update and replies Linked.", async () => {
  const before = await relay("cat", "sendMessage", { chat_id: 333, text: "too early" });
  assert.equal(before.json.ok, false);
  assert.equal(before.json.description, "Telegram not linked");

  const link = await relay("cat", "jhLinkCode");
  assert.equal(link.json.ok, true);
  const { code, url } = link.json.result;
  assert.equal(url, `https://t.me/jh_test_bot?start=${code}`);

  await webhook(msg(333, `/start ${code}`));
  assert.equal(loadPeople(dir).find((p) => p.id === "cat")!.chatId, 333);
  const reply = calls.find((c) => c.method === "sendMessage");
  assert.deepEqual(reply?.body, { chat_id: 333, text: "Linked." });
  assert.equal(reply?.token, "REAL");
  const got = await relay("cat", "getUpdates", { timeout: 0 });
  assert.equal(got.json.result[0].message.text, `/start ${code}`);

  // Single use: the same code from another chat does nothing.
  await webhook(msg(444, `/start ${code}`));
  assert.equal(loadPeople(dir).find((p) => p.id === "cat")!.chatId, 333);
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 1);
});

test("getUpdates follows Bot API offsets: earlier updates are confirmed and gone, ids keep rising", async () => {
  for (let i = 0; i < 3; i++) await webhook(msg(111, `m${i}`, 500 + i));
  const all = (await relay("ana", "getUpdates", { offset: 0, timeout: 0 })).json.result;
  assert.deepEqual(all.map((u: { update_id: number }) => u.update_id), [1, 2, 3]);

  const fromTwo = (await relay("ana", "getUpdates", { offset: 2, timeout: 0 })).json.result;
  assert.deepEqual(fromTwo.map((u: { update_id: number }) => u.update_id), [2, 3]);
  const again = (await relay("ana", "getUpdates", { timeout: 0 })).json.result;
  assert.deepEqual(again.map((u: { update_id: number }) => u.update_id), [2, 3], "update 1 was dropped by offset 2");

  assert.deepEqual((await relay("ana", "getUpdates", { offset: 4, timeout: 0 })).json.result, []);
  await webhook(msg(111, "m3"));
  const next = (await relay("ana", "getUpdates", { offset: 4, timeout: 0 })).json.result;
  assert.deepEqual(next.map((u: { update_id: number }) => u.update_id), [4]);
});

test("a stale offset from polling Telegram directly is ignored instead of dropping the queue", async () => {
  await webhook(msg(111, "moved over"));
  const got = (await relay("ana", "getUpdates", { offset: 108621211, timeout: 0 })).json.result;
  assert.ok(got.length >= 1, "queued updates are still delivered");
  assert.ok(got.some((u: { message?: { text?: string } }) => u.message?.text === "moved over"));
});

test("getUpdates holds the request until an update arrives, or the timeout passes", async () => {
  const started = Date.now();
  const waiting = relay("ana", "getUpdates", { offset: 0, timeout: 5 });
  await new Promise((r) => setTimeout(r, 200));
  await webhook(msg(111, "late"));
  const got = await waiting;
  assert.equal(got.json.result[0].message.text, "late");
  assert.ok(Date.now() - started < 2000, "answered as soon as the update came in");

  const t0 = Date.now();
  const empty = await relay("ben", "getUpdates", { offset: 0, timeout: 1 });
  assert.deepEqual(empty.json.result, []);
  assert.ok(Date.now() - t0 >= 900, "waited for the timeout");
});

test("sends are forwarded with chat_id set to the person's own chat, including documents", async () => {
  const sent = await relay("ana", "sendMessage", { chat_id: 222, text: "hi" });
  assert.equal(sent.json.ok, true);
  assert.equal(sent.json.result.message_id, 42);
  const call = calls.find((c) => c.method === "sendMessage")!;
  assert.equal(call.token, "REAL");
  assert.equal(call.body.chat_id, 111);
  assert.equal(call.body.text, "hi");

  const form = new FormData();
  form.set("chat_id", "222");
  form.set("caption", "resume");
  form.set("document", new Blob([Buffer.from("%PDF-1.4")], { type: "application/pdf" }), "resume.pdf");
  const doc = await fetch(`${base}/relay/botrelay-ana/sendDocument`, { method: "POST", body: form });
  assert.equal(((await doc.json()) as { ok: boolean }).ok, true);
  const docCall = calls.find((c) => c.method === "sendDocument")!;
  assert.match(docCall.type, /^multipart\/form-data/);
  assert.equal(docCall.body.chat_id, "111");
  assert.equal(docCall.body.caption, "resume");
  assert.equal(docCall.body.document, "<file resume.pdf>");
});

test("a callback can only be answered by the person it was delivered to", async () => {
  await webhook({ update_id: 7, callback_query: { id: "cb-ben", data: "x", message: { message_id: 3, chat: { id: 222 } } } });
  const foreign = await relay("ana", "answerCallbackQuery", { callback_query_id: "cb-ben", text: "nope" });
  assert.equal(foreign.json.ok, false);
  assert.equal(calls.filter((c) => c.method === "answerCallbackQuery").length, 0);

  const own = await relay("ben", "answerCallbackQuery", { callback_query_id: "cb-ben", text: "Done" });
  assert.equal(own.json.ok, true);
  assert.deepEqual(calls.find((c) => c.method === "answerCallbackQuery")!.body, { callback_query_id: "cb-ben", text: "Done" });
});

test("an unknown relay secret gets 401, and so does a webhook without the right secret", async () => {
  const bad = await post(`${base}/relay/botnot-a-secret/getUpdates`, { timeout: 0 });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.ok, false);
  assert.equal((await webhook(msg(111, "spoofed"), "wrong")).status, 401);
  assert.deepEqual((await relay("ana", "getUpdates", { timeout: 0 })).json.result, []);
});

test("methods that would change the bot itself are not forwarded", async () => {
  const r = await relay("ana", "setWebhook", { url: "https://evil.example.com" });
  assert.equal(r.json.ok, false);
  assert.equal(calls.length, 0);
});

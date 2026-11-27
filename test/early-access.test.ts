import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { personIdFor, validateRequest } from "../src/hub/early-access.ts";
import { savePeople, type Person } from "../src/hub/people.ts";
import { allowEmail, inviteText, provision, type ProvisionDeps, type Step } from "../src/hub/provision.ts";
import { startRouter, type Router } from "../src/hub/router.ts";

test("the form: an email and a LinkedIn profile link, cleaned up", () => {
  assert.deepEqual(validateRequest(" Asha@Example.com ", "linkedin.com/in/asha-rao/?trk=x"), { email: "asha@example.com", linkedin: "https://www.linkedin.com/in/asha-rao" });
  assert.deepEqual(validateRequest("a@b.co", "https://in.linkedin.com/in/asha"), { email: "a@b.co", linkedin: "https://www.linkedin.com/in/asha" });
  assert.ok("error" in validateRequest("not an email", "linkedin.com/in/a"));
  assert.ok("error" in validateRequest("a@b.co", ""));
  assert.ok("error" in validateRequest("a@b.co", "https://linkedin.com/company/acme"));
  assert.ok("error" in validateRequest("a@b.co", "https://evil.example/in/asha"));
});

test("person ids come from the email and never clash", () => {
  assert.equal(personIdFor("Asha.Rao+jobs@example.com", []), "asha-rao-jobs");
  assert.equal(personIdFor("asha@example.com", ["asha", "asha-2"]), "asha-3");
});

test("the invite says what to do, with this email", () => {
  const m = inviteText("asha@example.com", "https://kindahired.example");
  assert.match(m.text, /Download the app for Mac or Linux: https:\/\/kindahired\.example/);
  assert.match(m.text, /sign in with asha@example\.com/);
});

function fakeDeps(fail: Partial<Record<"engine" | "allow" | "invite", boolean>> = {}) {
  const calls: string[] = [];
  const people: { id: string; email: string }[] = [{ id: "asha", email: "someone@else.com" }];
  const deps: ProvisionDeps = {
    addPerson: (id, email) => { calls.push(`add ${id}`); people.push({ id, email }); },
    startEngine: (id) => { calls.push(`engine ${id}`); if (fail.engine) throw new Error("launchctl failed"); return "started"; },
    allowEmail: async (e) => { calls.push(`allow ${e}`); if (fail.allow) throw new Error("Cloudflare isn't set up"); return "added"; },
    sendInvite: async (e) => { calls.push(`invite ${e}`); if (fail.invite) throw new Error("smtp down"); return "sent"; },
    people: () => people,
  };
  return { deps, calls, people };
}

test("approving: every step, and a retry only redoes what failed", async () => {
  const first = fakeDeps({ allow: true });
  const r1 = await provision({ email: "asha@example.com", person: null }, first.deps);
  assert.equal(r1.person, "asha-2");
  assert.deepEqual(first.calls, ["add asha-2", "engine asha-2", "allow asha@example.com"]);
  assert.deepEqual(r1.steps.map((s) => [s.name, s.ok]), [["account", true], ["engine", true], ["sign-in", false], ["email", false]]);

  // Retry with Cloudflare fixed: the account exists and the engine already started.
  const again = fakeDeps();
  again.people.push({ id: "asha-2", email: "asha@example.com" });
  const r2 = await provision({ email: "asha@example.com", person: "asha-2" }, again.deps, r1.steps);
  assert.deepEqual(again.calls, ["allow asha@example.com", "invite asha@example.com"]);
  assert.ok(r2.steps.every((s) => s.ok));
});

test("Cloudflare: adds the email to the policy once, keeping the rest of it", async () => {
  const policy = { id: "p1", name: "Dashboards", decision: "allow", include: [{ email: { email: "me@example.com" } }], exclude: [], require: [], session_duration: "720h", created_at: "x" };
  const sent: { method: string; body?: any }[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ success: true, result: policy }), { status: 200 });
  }) as typeof fetch;
  const env = { CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a", CF_ACCESS_POLICY_ID: "p1" };
  assert.equal(await allowEmail("new@example.com", env, fakeFetch), "Added to the sign-in list");
  const put = sent.find((s) => s.method === "PUT")!;
  assert.deepEqual(put.body.include, [{ email: { email: "me@example.com" } }, { email: { email: "new@example.com" } }]);
  assert.equal(put.body.session_duration, "720h");
  assert.equal(put.body.id, undefined);
  assert.equal(put.body.created_at, undefined);
  sent.length = 0;
  assert.equal(await allowEmail("ME@example.com", env, fakeFetch), "Already on the sign-in list");
  assert.ok(!sent.some((s) => s.method === "PUT"));
  await assert.rejects(allowEmail("x@example.com", {}, fakeFetch), /Cloudflare isn't set up/);
});

// ---------- Through the router ----------

const calls: { method: string; body: Record<string, any> }[] = [];
let fake: http.Server;
let fakeBase = "";
let dir = "";
let router: Router;
let base = "";
let provisioned: string[] = [];
const LANDING = "https://landing.example";
const GW = "gw-secret";

const person = (id: string, email: string, chatId: number | null): Person => ({ id, email, port: 4400, relaySecret: `relay-${id}`, workerToken: `worker-${id}`, chatId });

before(async () => {
  fake = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const method = req.url!.split("/").pop()!;
    calls.push({ method, body: parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {} });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: 77 } }));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
after(async () => {
  if (router) await router.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((r) => fake.close(() => r()));
});
beforeEach(async () => {
  if (router) await router.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(os.tmpdir(), "jh-ea-"));
  savePeople([person("boss", "boss@example.com", 900), person("ana", "ana@example.com", 111)], dir);
  calls.length = 0;
  provisioned = [];
  const deps: ProvisionDeps = {
    addPerson: (id) => { provisioned.push(`add ${id}`); },
    startEngine: (id) => { provisioned.push(`engine ${id}`); return "started"; },
    allowEmail: async (e) => { provisioned.push(`allow ${e}`); return "added"; },
    sendInvite: async (e) => { provisioned.push(`invite ${e}`); return "sent"; },
    people: () => [],
  };
  router = await startRouter({
    port: 0, hubDir: dir, botToken: "REAL", webhookSecret: "wh", telegramBase: fakeBase, botUsername: "b", log: () => {}, deps,
    env: { ADMIN_EMAILS: "Boss@example.com", HUB_GATEWAY_SECRET: GW, LANDING_ORIGIN: LANDING },
    engineStatus: async (p) => (p.id === "ana" ? { lastSeen: new Date().toISOString(), queued: 2 } : null),
  });
  base = `http://127.0.0.1:${router.port}`;
});

const ask = (body: Record<string, string>, ip = "1.2.3.4") => fetch(`${base}/early-access`, {
  method: "POST", headers: { "content-type": "application/json", origin: LANDING, "x-forwarded-for": ip }, body: JSON.stringify(body),
});
const settle = () => new Promise((r) => setTimeout(r, 50));

test("a request is stored once and the operator gets Approve and Decline in Telegram", async () => {
  const pre = await fetch(`${base}/early-access`, { method: "OPTIONS", headers: { origin: LANDING } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), LANDING);
  const res = await ask({ email: "new@example.com", linkedin: "linkedin.com/in/new" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), LANDING);
  await settle();
  const sent = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, 900);
  assert.match(sent[0].body.text, /new@example\.com/);
  assert.deepEqual(sent[0].body.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data), ["ea:approve:1", "ea:decline:1"]);
  // Asking again: same answer, no second message.
  assert.equal((await ask({ email: "NEW@example.com", linkedin: "linkedin.com/in/new" })).status, 200);
  await settle();
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 1);
});

test("bots, bad input and floods are turned away", async () => {
  assert.equal((await ask({ email: "bot@example.com", linkedin: "linkedin.com/in/bot", website: "spam" })).status, 200);
  assert.equal((await ask({ email: "x@example.com", linkedin: "https://example.com" })).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await ask({ email: `p${i}@example.com`, linkedin: `linkedin.com/in/p${i}` }, "9.9.9.9")).status, 200);
  assert.equal((await ask({ email: "p6@example.com", linkedin: "linkedin.com/in/p6" }, "9.9.9.9")).status, 429);
  await settle();
  assert.ok(!calls.some((c) => JSON.stringify(c.body).includes("bot@example.com")));
});

test("Approve in Telegram runs every step and updates the message; others' taps don't count", async () => {
  await ask({ email: "new@example.com", linkedin: "linkedin.com/in/new" });
  await settle();
  const tap = (chat: number, data: string) => fetch(`${base}/telegram/webhook`, {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wh" },
    body: JSON.stringify({ update_id: 5, callback_query: { id: "cb1", data, message: { message_id: 77, chat: { id: chat } } } }),
  });
  // Ana isn't an admin: her tap goes to her own engine's queue, nothing is approved.
  await tap(111, "ea:approve:1");
  assert.deepEqual(provisioned, []);
  await tap(900, "ea:approve:1");
  assert.deepEqual(provisioned, ["add new", "engine new", "allow new@example.com", "invite new@example.com"]);
  const edit = calls.find((c) => c.method === "editMessageText")!;
  assert.match(edit.body.text, /Approved\./);
  assert.ok(calls.some((c) => c.method === "answerCallbackQuery"));
});

test("/admin: only through the gateway, only for admins; changes only from the page", async () => {
  await ask({ email: "new@example.com", linkedin: "linkedin.com/in/new" });
  const h = (email: string, extra: Record<string, string> = {}) => ({ "x-kindahired-gateway": GW, "x-kindahired-email": email, "x-forwarded-host": "hub.example", ...extra });
  assert.equal((await fetch(`${base}/admin`, { headers: { "x-kindahired-email": "boss@example.com" } })).status, 403);
  assert.equal((await fetch(`${base}/admin`, { headers: h("ana@example.com") })).status, 403);
  const page = await (await fetch(`${base}/admin`, { headers: h("boss@example.com") })).text();
  assert.match(page, /Early access · 1 waiting/);
  assert.match(page, /new@example\.com/);
  assert.match(page, /online, seen just now/);
  assert.match(page, /engine not answering/);
  const decline = (origin: string) => fetch(`${base}/admin/requests/1/decline`, { method: "POST", redirect: "manual", headers: h("boss@example.com", { origin }) });
  assert.equal((await decline("https://evil.example")).status, 403);
  const ok = await decline("https://hub.example");
  assert.equal(ok.status, 303);
  assert.match(decodeURIComponent(ok.headers.get("location")!), /Declined new@example\.com/);
  assert.match(await (await fetch(`${base}/admin`, { headers: h("boss@example.com") })).text(), /Early access · 0 waiting/);
});

test("a step that failed shows on /admin with a retry", async () => {
  const steps: Step[] = [{ name: "sign-in", ok: false, detail: "Cloudflare isn't set up" }];
  const { adminPage } = await import("../src/hub/admin-page.ts");
  const html = adminPage({ requests: [{ id: 3, email: "x@example.com", linkedin: "https://www.linkedin.com/in/x", created_at: 0, status: "approved", decided_at: 0, person: "x", steps: JSON.stringify(steps), telegram_message: null }], people: [] });
  assert.match(html, /Retry failed steps/);
  assert.match(html, /Cloudflare isn&#39;t set up/);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../src/hub/gateway.ts";
import type { Mail } from "../src/hub/mail.ts";
import type { Person } from "../src/hub/people.ts";
import { openSigninStore } from "../src/hub/signin.ts";

const TEAM = "team.cloudflareaccess.com";
const AUD = "test-aud";
const SECRET = "gw-secret-for-tests";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const sign = (claims: Record<string, unknown>, key = privateKey, kid = "k1") => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", kid })}.${enc(claims)}`;
  return `${body}.${crypto.sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
};
const nowSec = () => Math.floor(Date.now() / 1000);
const good = (email: string, over: Record<string, unknown> = {}) =>
  sign({ email, aud: [AUD], iss: `https://${TEAM}`, exp: nowSec() + 600, ...over });

interface Seen { name: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const seen: Seen[] = [];
const mails: Mail[] = [];
const servers: http.Server[] = [];

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(s));
    servers.push(s);
  });
}
const portOf = (s: http.Server) => (s.address() as AddressInfo).port;
const upstream = (name: string) => listen((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ name, url: req.url ?? "", headers: req.headers, body });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`from ${name}`);
  });
});

let base = "";
before(async () => {
  const jwks = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] }));
  });
  const sam = await upstream("sam");
  const ana = await upstream("ana");
  const router = await upstream("router");
  const people: Person[] = [
    { id: "sam", email: "sam@example.com", port: portOf(sam), relaySecret: "r1", workerToken: "wt-sam", chatId: null },
    { id: "ana", email: "ana@example.com", port: portOf(ana), relaySecret: "r2", workerToken: "wt-ana", chatId: null },
  ];
  const gw = createGateway({
    teamDomain: TEAM, aud: AUD, certsUrl: `http://127.0.0.1:${portOf(jwks)}/certs`,
    routerUrl: `http://127.0.0.1:${portOf(router)}`, loadPeople: () => people, gatewaySecret: SECRET,
    signin: openSigninStore(path.join(mkdtempSync(path.join(os.tmpdir(), "jh-gw-")), "gateway.db"), SECRET),
    sendMail: async (m) => { mails.push(m); },
  });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  servers.push(gw);
  base = `http://127.0.0.1:${portOf(gw)}`;
});
after(() => servers.forEach((s) => s.close()));

const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers });

test("a valid token reaches the right person's engine", async () => {
  const a = await call("/x?y=1", { "cf-access-jwt-assertion": good("sam@example.com") });
  assert.equal(a.status, 200);
  assert.equal(await a.text(), "from sam");
  const b = await call("/", { "cf-access-jwt-assertion": good("Ana@Example.com") });
  assert.equal(await b.text(), "from ana");
  assert.equal(seen.find((s) => s.name === "sam")!.url, "/x?y=1");
});

test("request bodies are streamed through", async () => {
  const r = await call("/post", { "cf-access-jwt-assertion": good("sam@example.com") }, { method: "POST", body: "hello" });
  assert.equal(r.status, 200);
  assert.equal(seen.filter((s) => s.name === "sam").at(-1)!.body, "hello");
});

test("the Google OAuth callback rides the Access cookie to the right person's engine", async () => {
  const cb = "/oauth/google/callback?state=s1&code=c1&scope=x";
  const r = await call(cb, { "cf-access-jwt-assertion": good("ana@example.com") });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "from ana");
  assert.equal(seen.filter((s) => s.name === "ana").at(-1)!.url, cb);
  assert.equal((await call(cb, {}, { redirect: "manual" })).status, 303);
});

test("not signed in: pages go to /signin and come back, other requests get 401", async () => {
  const r = await call("/o/12?x=1", {}, { redirect: "manual" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/signin?next=%2Fo%2F12%3Fx%3D1");
  assert.equal((await call("/a/1/done", {}, { method: "POST", redirect: "manual" })).status, 401);
});

test("bad tokens get 403", async () => {
  const bad = [
    "garbage",
    sign({ email: "sam@example.com", aud: [AUD], exp: nowSec() + 600 }, otherKey),
    good("sam@example.com", { exp: nowSec() - 10 }),
    good("sam@example.com", { aud: ["someone-else"] }),
    good("sam@example.com", { iss: "https://evil.example.com" }),
    sign({ email: "sam@example.com", aud: [AUD], exp: nowSec() + 600 }, privateKey, "unknown-kid"),
  ];
  for (const t of bad) assert.equal((await call("/", { "cf-access-jwt-assertion": t })).status, 403, t.slice(0, 20));
});

test("an email that is not in the registry gets the not-in-yet page and no engine call", async () => {
  const engineCalls = () => seen.filter((s) => s.name !== "router").length;
  const before = engineCalls();
  const r = await call("/", { "cf-access-jwt-assertion": good("stranger@example.com") });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /You&#39;re not in yet/);
  assert.equal(engineCalls(), before);
});

test("the Telegram webhook goes to the router with no token", async () => {
  const r = await call("/telegram/webhook", {}, { method: "POST", body: "{}" });
  assert.equal(await r.text(), "from router");
});

test("worker requests route by bearer token", async () => {
  const a = await call("/worker/claim", { authorization: "Bearer wt-ana" }, { method: "POST" });
  assert.equal(await a.text(), "from ana");
  assert.equal((await call("/worker/claim", { authorization: "Bearer nope" }, { method: "POST" })).status, 401);
  assert.equal((await call("/worker/claim", {}, { method: "POST" })).status, 401);
});

test("healthz needs no auth", async () => {
  assert.equal((await call("/healthz")).status, 200);
});

test("Cf-Access headers are stripped and forwarded headers are set", async () => {
  await call("/hdr", {
    "cf-access-jwt-assertion": good("sam@example.com"),
    "cf-access-authenticated-user-email": "sam@example.com",
    "x-forwarded-for": "6.6.6.6",
  });
  const h = seen.filter((s) => s.url === "/hdr").at(-1)!.headers;
  assert.equal(h["cf-access-jwt-assertion"], undefined);
  assert.equal(h["cf-access-authenticated-user-email"], undefined);
  assert.notEqual(h["x-forwarded-for"], "6.6.6.6");
  assert.equal(h["x-forwarded-host"], new URL(base).host);
  assert.equal(h.host, new URL(base).host);
  assert.equal(h["x-forwarded-proto"], "https");
});

test("engines get the gateway secret; a client's own copy is replaced, and the router never sees it", async () => {
  await call("/gw", { "cf-access-jwt-assertion": good("sam@example.com"), "x-kindahired-gateway": "spoofed" });
  assert.equal(seen.filter((s) => s.url === "/gw").at(-1)!.headers["x-kindahired-gateway"], SECRET);
  await call("/worker/status", { authorization: "Bearer wt-ana", "x-kindahired-gateway": "spoofed" });
  assert.equal(seen.filter((s) => s.name === "ana" && s.url === "/worker/status").at(-1)!.headers["x-kindahired-gateway"], SECRET);
  await call("/oauth/google/callback?state=s&code=c", { "cf-access-jwt-assertion": good("sam@example.com") });
  assert.equal(seen.filter((s) => s.url.startsWith("/oauth/")).at(-1)!.headers["x-kindahired-gateway"], SECRET);
  await call("/telegram/webhook", { "x-kindahired-gateway": "spoofed" }, { method: "POST", body: "{}" });
  assert.equal(seen.filter((s) => s.name === "router").at(-1)!.headers["x-kindahired-gateway"], undefined);
});

test("the gateway won't start without a secret", () => {
  const saved = process.env.HUB_GATEWAY_SECRET;
  delete process.env.HUB_GATEWAY_SECRET;
  try {
    assert.throws(() => createGateway({ teamDomain: TEAM, aud: AUD, loadPeople: () => [] }), /HUB_GATEWAY_SECRET/);
  } finally {
    if (saved !== undefined) process.env.HUB_GATEWAY_SECRET = saved;
  }
});

test("early access reaches the router with no sign-in, and never with a gateway secret or email", async () => {
  const r = await call("/early-access", { "x-kindahired-gateway": "spoofed", "x-kindahired-email": "boss@example.com" }, { method: "POST", body: "{}" });
  assert.equal(await r.text(), "from router");
  const h = seen.filter((s) => s.name === "router" && s.url === "/early-access").at(-1)!.headers;
  assert.equal(h["x-kindahired-gateway"], undefined);
  assert.equal(h["x-kindahired-email"], undefined);
});

test("/admin needs a sign-in and carries the signed-in email, never the client's", async () => {
  assert.equal((await call("/admin", { "x-kindahired-email": "boss@example.com" }, { redirect: "manual" })).status, 303);
  const r = await call("/admin", { "cf-access-jwt-assertion": good("someone@example.com"), "x-kindahired-email": "boss@example.com" });
  assert.equal(await r.text(), "from router");
  const h = seen.filter((s) => s.name === "router" && s.url === "/admin").at(-1)!.headers;
  assert.equal(h["x-kindahired-email"], "someone@example.com");
  assert.equal(h["x-kindahired-gateway"], SECRET);
});

// ---------- Our own sign-in ----------

const form = (fields: Record<string, string>, origin: string | null = base) => ({
  method: "POST", redirect: "manual" as const, body: new URLSearchParams(fields).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
});
const lastCode = (to: string) => mails.filter((m) => m.to === to).at(-1)!.subject.slice(0, 6);
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];

async function signIn(email: string, next = "/") {
  const sent = await fetch(`${base}/signin`, form({ email, next }));
  assert.equal(sent.status, 200);
  const r = await fetch(`${base}/signin/code`, form({ email, next, code: lastCode(email) }));
  assert.equal(r.status, 303);
  return { cookie: cookieOf(r), location: r.headers.get("location") };
}

test("sign in with an emailed code reaches your own dashboard", async () => {
  const page = await (await fetch(`${base}/signin?next=%2Fo%2F12`)).text();
  assert.match(page, /Email me a code/);
  const sent = await fetch(`${base}/signin`, form({ email: "Sam@Example.com", next: "/o/12" }));
  assert.match(await sent.text(), /We sent a 6-digit code to <strong>sam@example.com/);
  const mail = mails.at(-1)!;
  assert.equal(mail.to, "sam@example.com");
  assert.match(mail.subject, /^\d{6} is your kindahired code$/);
  // A wrong code first.
  const wrongCode = lastCode("sam@example.com") === "000000" ? "111111" : "000000";
  const wrong = await fetch(`${base}/signin/code`, form({ email: "sam@example.com", next: "/o/12", code: wrongCode }));
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /4 tries left/);
  const ok = await fetch(`${base}/signin/code`, form({ email: "sam@example.com", next: "/o/12", code: lastCode("sam@example.com") }));
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/o/12");
  const set = ok.headers.get("set-cookie")!;
  assert.match(set, /^__Host-kh_session=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const r = await call("/o/12", { cookie: cookieOf(ok) });
  assert.equal(await r.text(), "from sam");
  // The same code doesn't work twice.
  assert.equal((await fetch(`${base}/signin/code`, form({ email: "sam@example.com", code: lastCode("sam@example.com") }))).status, 400);
});

test("five wrong codes end that code", async () => {
  await fetch(`${base}/signin`, form({ email: "ana@example.com" }));
  const right = lastCode("ana@example.com");
  const wrongCode = right === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) await fetch(`${base}/signin/code`, form({ email: "ana@example.com", code: wrongCode }));
  const fifth = await fetch(`${base}/signin/code`, form({ email: "ana@example.com", code: wrongCode }));
  assert.match(await fifth.text(), /Too many wrong codes/);
  assert.equal((await fetch(`${base}/signin/code`, form({ email: "ana@example.com", code: right }))).status, 400);
});

test("sign-in forms from another site, and odd next paths, are refused", async () => {
  assert.equal((await fetch(`${base}/signin`, form({ email: "sam@example.com" }, "https://evil.example"))).status, 403);
  assert.equal((await fetch(`${base}/signin`, form({ email: "sam@example.com" }, null))).status, 403);
  const { location } = await signIn("sam@example.com", "//evil.example/x");
  assert.equal(location, "/");
});

test("sign out ends the session", async () => {
  const { cookie } = await signIn("ana@example.com");
  assert.equal(await (await call("/x", { cookie })).text(), "from ana");
  const out = await fetch(`${base}/signout`, { ...form({}), headers: { ...form({}).headers, cookie } });
  assert.equal(out.status, 303);
  assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((await call("/x", { cookie }, { redirect: "manual" })).status, 303);
});

test("someone without a dashboard can sign in and ask for access in one step", async () => {
  const { cookie } = await signIn("new@example.com");
  const page = await (await call("/", { cookie })).text();
  assert.match(page, /You're not in yet/);
  assert.match(page, /Signed in as new@example.com/);
  const r = await fetch(`${base}/request-access`, { ...form({ linkedin: "linkedin.com/in/new" }), headers: { ...form({}).headers, cookie } });
  assert.equal(r.status, 400); // the stand-in router doesn't answer {ok:true}
  const asked = seen.filter((s) => s.name === "router" && s.url === "/early-access/verified").at(-1)!;
  assert.equal(asked.headers["x-kindahired-email"], "new@example.com");
  assert.equal(asked.headers["x-kindahired-gateway"], SECRET);
  assert.deepEqual(JSON.parse(asked.body), { linkedin: "linkedin.com/in/new" });
});

test("codes are limited per email", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/signin`, form({ email: "busy@example.com" }))).status, 200);
  const sixth = await fetch(`${base}/signin`, form({ email: "busy@example.com" }));
  assert.equal(sixth.status, 429);
  assert.match(await sixth.text(), /That&#39;s a lot of codes/);
});

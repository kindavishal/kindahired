import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createGateway } from "../src/hub/gateway.ts";
import type { Person } from "../src/hub/registry.ts";

const TEAM = "team.cloudflareaccess.com";
const AUD = "test-aud";
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
    routerUrl: `http://127.0.0.1:${portOf(router)}`, loadPeople: () => people,
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

test("no token gets 401", async () => {
  assert.equal((await call("/")).status, 401);
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

test("an email that is not in the registry gets the 403 page and no upstream call", async () => {
  const before = seen.length;
  const r = await call("/", { "cf-access-jwt-assertion": good("stranger@example.com") });
  assert.equal(r.status, 403);
  assert.match(await r.text(), /signed in as stranger@example.com but don't have a dashboard here yet/);
  assert.equal(seen.length, before);
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

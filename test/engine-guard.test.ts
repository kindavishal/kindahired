import assert from "node:assert/strict";
import { once } from "node:events";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { get, run, useMemoryDb } from "../src/db/index.ts";
import { startServer } from "../src/web/server.ts";

const SECRET = "engine-guard-secret";
let server: Server;
let base = "";

before(async () => {
  process.env.JH_WORKER_TOKEN = "wt";
  server = startServer(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  useMemoryDb();
  delete process.env.JH_HUB;
  process.env.HUB_GATEWAY_SECRET = SECRET;
});

const task = () => {
  run("INSERT INTO actions (kind, title, due_at) VALUES ('custom', 'Call back', $d)", { d: new Date(Date.now() - 3_600_000).toISOString() });
  return get<{ id: number }>("SELECT max(id) id FROM actions")!.id;
};
const statusOf = (id: number) => get<{ status: string }>("SELECT status FROM actions WHERE id = $id", { id })!.status;
const done = (id: number, headers: Record<string, string>) =>
  fetch(`${base}/a/${id}/done`, { method: "POST", redirect: "manual", headers });

// ---------- Fix 1: only the gateway reaches an engine in hub mode ----------

test("hub mode: no gateway header or the wrong one gets 403, the right one is served", async () => {
  process.env.JH_HUB = "1";
  assert.equal((await fetch(base + "/")).status, 403);
  assert.equal((await fetch(base + "/", { headers: { "x-kindahired-gateway": "wrong" } })).status, 403);
  assert.equal((await fetch(base + "/", { headers: { "x-kindahired-gateway": SECRET + "x" } })).status, 403);
  assert.equal((await fetch(base + "/", { headers: { "x-kindahired-gateway": SECRET } })).status, 200);
});

test("hub mode: /worker/* needs the gateway header too, before the bearer token", async () => {
  process.env.JH_HUB = "1";
  assert.equal((await fetch(base + "/worker/status", { headers: { authorization: "Bearer wt" } })).status, 403);
  assert.equal((await fetch(base + "/worker/status", { headers: { authorization: "Bearer wt", "x-kindahired-gateway": SECRET } })).status, 200);
});

test("hub mode without HUB_GATEWAY_SECRET refuses everything", async () => {
  process.env.JH_HUB = "1";
  delete process.env.HUB_GATEWAY_SECRET;
  assert.equal((await fetch(base + "/")).status, 403);
  assert.equal((await fetch(base + "/", { headers: { "x-kindahired-gateway": "" } })).status, 403);
  assert.equal((await fetch(base + "/", { headers: { "x-kindahired-gateway": "anything" } })).status, 403);
});

test("outside hub mode nothing changes: no header needed", async () => {
  assert.equal((await fetch(base + "/")).status, 200);
  delete process.env.HUB_GATEWAY_SECRET;
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/worker/status", { headers: { authorization: "Bearer wt" } })).status, 200);
});

// ---------- Fix 2: every state-changing request must come from the dashboard ----------

test("a cross-origin POST to /a/<id>/done is refused and changes nothing", async () => {
  const id = task();
  const r = await done(id, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(statusOf(id), "open");
  const inline = await done(id, { origin: "https://evil.example", "x-inline": "1" });
  assert.equal(inline.status, 403);
  assert.equal((await inline.json()).ok, false);
  assert.equal((await done(id, { referer: "https://evil.example/page" })).status, 403);
  assert.equal(statusOf(id), "open");
});

test("a POST with neither Origin nor Referer is refused", async () => {
  const id = task();
  assert.equal((await done(id, {})).status, 403);
  assert.equal((await done(id, { origin: "null" })).status, 403);
  assert.equal(statusOf(id), "open");
});

test("a same-origin POST works, by Origin or by Referer", async () => {
  const a = task();
  assert.equal((await done(a, { origin: base })).status, 303);
  assert.equal(statusOf(a), "done");
  const b = task();
  assert.equal((await done(b, { referer: base + "/tasks" })).status, 303);
  assert.equal(statusOf(b), "done");
});

test("other routes are covered too: /timers/reset, /add, /sources", async () => {
  for (const p of ["/timers/reset", "/add", "/sources", "/companies", "/insights/clear-drafts"]) {
    const r = await fetch(base + p, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "url=https://x.example/job" });
    assert.equal(r.status, 403, p);
  }
  assert.equal(get<{ n: number }>("SELECT count(*) n FROM inbox_items")!.n, 0);
});

test("/worker/* is exempt: a bearer-token POST with no Origin still works", async () => {
  const r = await fetch(base + "/worker/release", { method: "POST", headers: { authorization: "Bearer wt", "content-type": "application/json" }, body: "{}" });
  assert.notEqual(r.status, 403);
});

test("behind the gateway, the public host is checked (Origin https://app-…, Host app-…)", async () => {
  process.env.JH_HUB = "1";
  const id = task();
  const gw = { "x-kindahired-gateway": SECRET };
  // The gateway passes the original Host through (fetch can't set Host, so use http.request).
  const raw = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const u = new URL(`${base}/a/${id}/done`);
    http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); })
      .on("error", reject).end();
  });
  assert.equal(await raw({ ...gw, host: "app-hub.example.dev", origin: "https://evil.example" }), 403);
  assert.equal(statusOf(id), "open");
  assert.equal(await raw({ ...gw, host: "app-hub.example.dev", origin: "https://app-hub.example.dev" }), 303);
  assert.equal(statusOf(id), "done");
  // If Host were rewritten, X-Forwarded-Host (trusted only with the gateway header) is used.
  const b = task();
  assert.equal((await done(b, { ...gw, "x-forwarded-host": "app-hub.example.dev", origin: "https://app-hub.example.dev" })).status, 303);
  assert.equal(statusOf(b), "done");
  const c = task();
  assert.equal((await done(c, { ...gw, "x-forwarded-host": "app-hub.example.dev", origin: "https://evil.example" })).status, 403);
  assert.equal(statusOf(c), "open");
});

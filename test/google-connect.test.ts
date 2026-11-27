import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

// A private data folder, so the token file written here never touches other test files.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "jh-google-"));
process.env.JH_DATA_DIR = dataDir;
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.JH_PUBLIC_URL = "https://hub.example.com/";

const { useMemoryDb, kvGet, kvSet } = await import("../src/db/index.ts");
const { startServer } = await import("../src/web/server.ts");
const { setGoogleExchange } = await import("../src/web/google-connect.ts");
const { PATHS } = await import("../src/config.ts");
const { calendarReady } = await import("../src/pipeline/interviews.ts");
const { googleConnected } = await import("../src/sources/google-auth.ts");

let server: Server;
let base = "";
const calls: { code: string; redirectUri: string }[] = [];
const REDIRECT = "https://hub.example.com/oauth/google/callback";
const ALL = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file";

before(async () => {
  server = startServer(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  setGoogleExchange();
  server.closeAllConnections();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  useMemoryDb();
  process.env.JH_HUB = "1";
  rmSync(PATHS.googleToken, { force: true });
  calls.length = 0;
  setGoogleExchange(async (code, redirectUri) => {
    calls.push({ code, redirectUri });
    return { tokens: { access_token: "at", refresh_token: "rt", scope: ALL, token_type: "Bearer", expiry_date: Date.now() + 3600_000 }, email: "sam@example.com" };
  });
});

const get = (p: string) => fetch(base + p, { redirect: "manual" });
async function start(): Promise<URL> {
  const res = await fetch(base + "/oauth/google/start", { method: "POST", redirect: "manual" });
  assert.equal(res.status, 303);
  return new URL(res.headers.get("location")!);
}

test("start stores a state and redirects to Google with the hub's callback", async () => {
  const to = await start();
  assert.equal(to.origin + to.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = to.searchParams;
  assert.equal(q.get("redirect_uri"), REDIRECT);
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.equal(q.get("include_granted_scopes"), "true");
  assert.equal(q.get("client_id"), "test-client-id");
  assert.equal(q.get("response_type"), "code");
  assert.deepEqual(q.get("scope")!.split(" "), ALL.split(" "));
  const state = q.get("state")!;
  assert.ok(state.length >= 32);
  assert.ok(JSON.parse(kvGet("google.oauthStates")!)[state] > Date.now());
});

test("callback refuses a missing, wrong, expired or reused state", async () => {
  assert.equal((await get("/oauth/google/callback?code=c")).status, 400);
  await start();
  assert.equal((await get("/oauth/google/callback?code=c&state=nope")).status, 400);

  kvSet("google.oauthStates", JSON.stringify({ old: Date.now() - 1 }));
  assert.equal((await get("/oauth/google/callback?code=c&state=old")).status, 400);

  const state = (await start()).searchParams.get("state")!;
  assert.equal((await get(`/oauth/google/callback?code=c&state=${state}`)).status, 303);
  assert.equal((await get(`/oauth/google/callback?code=c&state=${state}`)).status, 400);
  assert.equal(calls.length, 1);
});

test("a good callback exchanges the code and saves the token where the rest of the code reads it", async () => {
  assert.equal(googleConnected(), false);
  const state = (await start()).searchParams.get("state")!;
  const res = await get(`/oauth/google/callback?code=the-code&state=${state}`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/google");
  assert.deepEqual(calls, [{ code: "the-code", redirectUri: REDIRECT }]);
  assert.equal(JSON.parse(readFileSync(PATHS.googleToken, "utf8")).refresh_token, "rt");
  assert.equal(googleConnected(), true);
  assert.equal(calendarReady(), true);
  const status = await (await get("/google")).text();
  assert.match(status, /Google is connected/);
  assert.match(status, /sam@example\.com/);
  assert.match(status, /Calendar is allowed/);
});

test("access_denied shows a friendly page and saves nothing", async () => {
  const state = (await start()).searchParams.get("state")!;
  const res = await get(`/oauth/google/callback?error=access_denied&state=${state}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You cancelled on Google's screen/);
  assert.equal(existsSync(PATHS.googleToken), false);
  assert.equal(calls.length, 0);
});

test("the status page explains the unverified-app screen and the Home callout shows until connected", async () => {
  const page = await (await get("/google")).text();
  assert.match(page, /Connect Google/);
  assert.match(page, /Go to kindahired/);
  // Home folds Google into the one setup callout; the checklist links here.
  assert.match(await (await get("/")).text(), /Finish setup \(\d of 6\)/);
  assert.match(await (await get("/setup")).text(), /href="\/google"/);
});

test("the routes are absent outside hub mode", async () => {
  delete process.env.JH_HUB;
  assert.equal((await get("/google")).status, 404);
  assert.equal((await fetch(base + "/oauth/google/start", { method: "POST", redirect: "manual" })).status, 404);
  assert.equal((await get("/oauth/google/callback?code=c&state=s")).status, 404);
  assert.doesNotMatch(await (await get("/")).text(), /href="\/google"/);
});

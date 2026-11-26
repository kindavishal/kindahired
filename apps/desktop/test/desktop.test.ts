import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { checkClaude, claudeCandidates, findClaude, interpretCheck, widenedPath } from "../src/claude.ts";
import { checkHub } from "../src/hub-check.ts";
import { addDone, autostartDesktopEntry, compareVersions, DEFAULT_SETTINGS, doneToday, loadSettings, normalizeHubUrl, saveSettings, settingsFile } from "../src/settings.ts";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "kh-desktop-"));

test("settings: defaults when missing or broken, and a round trip", () => {
  const dir = tmp();
  assert.deepEqual(loadSettings(dir), DEFAULT_SETTINGS);
  writeFileSync(settingsFile(dir), "{not json");
  assert.deepEqual(loadSettings(dir), DEFAULT_SETTINGS);
  writeFileSync(settingsFile(dir), JSON.stringify({ hubUrl: 7, paused: "yes", today: { day: "2026-11-26", done: 1.5 } }));
  assert.deepEqual(loadSettings(dir), { ...DEFAULT_SETTINGS, today: { day: "2026-11-26", done: 0 } });

  const s = { hubUrl: "https://hub.example.com/", openAtLogin: false, paused: true, today: { day: "2026-11-26", done: 3 } };
  saveSettings(dir, s);
  assert.deepEqual(loadSettings(dir), s);
  // Nothing secret goes in the settings file.
  assert.doesNotMatch(readFileSync(settingsFile(dir), "utf8"), /token/i);
});

test("settings: hub addresses are cleaned up or refused", () => {
  assert.deepEqual(normalizeHubUrl("jobs.example.com"), { url: "https://jobs.example.com/" });
  assert.deepEqual(normalizeHubUrl("  https://jobs.example.com/dashboard?x=1#y "), { url: "https://jobs.example.com/" });
  assert.deepEqual(normalizeHubUrl("http://localhost:8080"), { url: "http://localhost:8080/" });
  assert.ok("error" in normalizeHubUrl(""));
  assert.ok("error" in normalizeHubUrl("http://jobs.example.com"));
  assert.ok("error" in normalizeHubUrl("ftp://jobs.example.com"));
  assert.ok("error" in normalizeHubUrl("https://me:pw@jobs.example.com"));
});

test("settings: jobs done today reset on a new day", () => {
  const nov26 = new Date(2026, 10, 26, 23, 0);
  const nov27 = new Date(2026, 10, 27, 0, 30);
  let s = addDone(DEFAULT_SETTINGS, 2, nov26);
  s = addDone(s, 1, nov26);
  assert.equal(doneToday(s, nov26), 3);
  assert.equal(doneToday(s, nov27), 0);
  assert.equal(doneToday(addDone(s, 1, nov27), nov27), 1);
});

test("versions compare with or without a tag prefix", () => {
  assert.equal(compareVersions("desktop-v0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
});

test("the Linux autostart entry quotes the path", () => {
  const entry = autostartDesktopEntry("kindahired", '/home/sam/Apps/kinda "hired".AppImage');
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Exec="\/home\/sam\/Apps\/kinda \\"hired\\"\.AppImage"$/m);
});

test("claude is looked for on PATH first, then the usual install places", () => {
  const home = "/home/sam";
  const list = claudeCandidates({ home, pathEnv: ["/usr/bin", "relative/bin", "/usr/local/bin"].join(path.delimiter), platform: "linux" });
  assert.deepEqual(list, [
    "/usr/bin/claude",
    "/usr/local/bin/claude",
    "/home/sam/.claude/local/claude",
    "/home/sam/.local/bin/claude",
    "/opt/homebrew/bin/claude",
  ]);
  const found = findClaude({ home, pathEnv: "/usr/bin", platform: "linux", isExecutable: (f) => f === "/home/sam/.local/bin/claude" });
  assert.equal(found, "/home/sam/.local/bin/claude");
  assert.equal(findClaude({ home, pathEnv: "", platform: "linux", isExecutable: () => false }), null);
});

test("the real file check finds an executable claude and skips one that isn't", () => {
  const home = tmp();
  const bin = path.join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "claude");
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o644);
  assert.notEqual(findClaude({ home, pathEnv: "" }), file);
  chmodSync(file, 0o755);
  assert.equal(findClaude({ home, pathEnv: "" }), file);
});

test("PATH is widened with claude's folder and the install places, without repeats", () => {
  const p = widenedPath(["/usr/bin", "/opt/homebrew/bin"].join(path.delimiter), "/Users/sam", "/Users/sam/.local/bin/claude").split(path.delimiter);
  assert.deepEqual(p, ["/usr/bin", "/opt/homebrew/bin", "/Users/sam/.local/bin", "/Users/sam/.claude/local", "/usr/local/bin"]);
});

test("the Claude Code check reads ok, signed out, missing and other answers", () => {
  const ok = interpretCheck("/x/claude", { code: 0, stdout: 'noise\n{"is_error":false,"result":"ok"}\n', stderr: "" });
  assert.equal(ok.state, "ok");
  assert.equal(interpretCheck("/x/claude", { code: 1, stdout: '{"is_error":true,"result":"Invalid API key · Please run /login"}', stderr: "" }).state, "signed-out");
  assert.equal(interpretCheck("/x/claude", { code: 1, stdout: "", stderr: "Not logged in. Run claude to log in." }).state, "signed-out");
  assert.equal(interpretCheck("/x/claude", { code: null, stdout: "", stderr: "", spawnError: "spawn /x/claude ENOENT" }).state, "missing");
  const limit = interpretCheck("/x/claude", { code: 1, stdout: '{"is_error":true,"result":"Claude usage limit reached"}', stderr: "" });
  assert.equal(limit.state, "error");
});

test("the Claude Code check runs the binary without an API key in its environment", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const fake = path.join(dir, "claude");
  // Prints is_error true when an API key leaks through, so the check would fail.
  writeFileSync(fake, '#!/bin/sh\nif [ -n "$ANTHROPIC_API_KEY" ]; then echo \'{"is_error":true,"result":"key leaked"}\'; else echo \'{"is_error":false,"result":"ok"}\'; fi\n');
  chmodSync(fake, 0o755);
  const r = await checkClaude(fake, { cwd: path.join(dir, "agent"), env: { ...process.env, ANTHROPIC_API_KEY: "sk-test" } });
  assert.deepEqual(r, { state: "ok", bin: fake });
  assert.equal((await checkClaude(null, { cwd: dir, env: {} })).state, "missing");
});

test("the hub check reports reachability and the token", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") return res.end("ok");
    if (req.url === "/worker/status") {
      if (req.headers.authorization !== "Bearer good") { res.writeHead(401); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ queued: 2, claimed: 0, lastSeen: null }));
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const good = await checkHub(hub, "good");
    assert.equal(good.hub.ok, true);
    assert.equal(good.token?.ok, true);
    assert.match(good.token!.message, /2 Claude steps are waiting/);
    assert.equal((await checkHub(hub, "bad")).token?.ok, false);
    assert.equal((await checkHub(hub, "")).token?.ok, false);
  } finally {
    server.close();
  }
  const down = await checkHub(hub, "good", fetch, 2000);
  assert.equal(down.hub.ok, false);
  assert.equal(down.token, null);
});

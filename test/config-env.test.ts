import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repo = path.resolve(import.meta.dirname, "..");

/** Runs config.ts in a fresh process against a fake repo copy (src only) with its own .env. */
function run(hub: boolean) {
  const base = mkdtempSync(path.join(os.tmpdir(), "kh-cfg-"));
  const fakeRepo = path.join(base, "repo");
  mkdirSync(fakeRepo);
  cpSync(path.join(repo, "src"), path.join(fakeRepo, "src"), { recursive: true });
  writeFileSync(path.join(fakeRepo, ".env"), "TELEGRAM_BOT_TOKEN=leak\nGOOGLE_CLIENT_ID=leak-google\n");
  const data = path.join(base, "people", "sam");
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, ".env"), "TELEGRAM_BOT_TOKEN=person\n");
  const hubDir = path.join(base, "hub");
  mkdirSync(hubDir);
  writeFileSync(path.join(hubDir, "hub.env"), "TELEGRAM_BOT_TOKEN=hub\nGOOGLE_CLIENT_ID=hub-google\n");
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: base, JH_DATA_DIR: data, JH_HUB_DIR: hubDir };
  if (hub) childEnv.JH_HUB = "1";
  const tsx = path.join(repo, "node_modules", ".bin", "tsx");
  const res = spawnSync(tsx, ["-e", `import { env } from "./src/config.ts"; console.log(JSON.stringify(env));`], { cwd: fakeRepo, env: childEnv, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split("\n").pop()!) as { telegramToken: string; googleClientId: string };
}

test("hub mode never loads the repo .env; person beats hub.env", () => {
  const env = run(true);
  assert.equal(env.telegramToken, "person");
  assert.equal(env.googleClientId, "hub-google");
});

test("non-hub mode still loads the repo .env first", () => {
  assert.equal(run(false).telegramToken, "leak");
});

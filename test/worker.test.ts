import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { z } from "zod";
import { kvSet, useMemoryDb } from "../src/db/index.ts";
import type { ClaudeResult } from "../src/llm/claude-code.ts";
import { claudeResearch, claudeStructured, PlanUnavailableError } from "../src/llm/providers.ts";
import { isAccountError } from "../src/jobs.ts";
import { refusedArgs, startWorker, type Spawner } from "../src/worker/client.ts";
import { claimJob, completeJob, enqueueClaude, workerOnline, workerStatus, WorkerOfflineError } from "../src/worker/queue.ts";
import { startServer } from "../src/web/server.ts";

const TOKEN = "test-worker-token";
let server: Server;
let hub = "";

before(async () => {
  process.env.JH_WORKER_TOKEN = TOKEN;
  // Claude Code must never really run here.
  process.env.JH_CLAUDE_BIN = "/nonexistent/claude";
  server = startServer(0);
  await once(server, "listening");
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  useMemoryDb();
  delete process.env.JH_CLAUDE_VIA;
  delete process.env.JH_WORKER_GRACE_MS;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await sleep(10);
  }
}

function fakeClaude(answer: Partial<ClaudeResult> = {}) {
  const calls: { args: string[]; prompt: string }[] = [];
  const spawn: Spawner = async (args, prompt) => {
    calls.push({ args, prompt });
    return { is_error: false, result: "Found it.", structured_output: { ok: true }, ...answer };
  };
  return { calls, spawn };
}

async function withWorker<T>(spawn: Spawner, fn: () => Promise<T>): Promise<T> {
  const worker = startWorker({ hub, token: TOKEN, spawn, claimWaitMs: 200, backoffMs: 50 });
  try {
    await waitFor(() => workerOnline());
    return await fn();
  } finally {
    await worker.stop();
  }
}

test("a Claude step on the hub goes through the desktop worker and back", async () => {
  process.env.JH_CLAUDE_VIA = "worker";
  const fake = fakeClaude();
  await withWorker(fake.spawn, async () => {
    const out = await claudeStructured("test.step", z.object({ ok: z.boolean() }), { system: "Be brief.", prompt: "Is it ok?" });
    assert.deepEqual(out, { ok: true });
    const text = await claudeResearch("test.research", { system: "Look it up.", prompt: "Who's hiring?" });
    assert.equal(text, "Found it.");
  });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].prompt, "Is it ok?");
  assert.deepEqual(fake.calls[0].args.slice(0, 7), ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""]);
  assert.ok(fake.calls[1].args.includes("--allowedTools"));
  const s = workerStatus();
  assert.equal(s.queued + s.claimed, 0);
  assert.ok(s.lastSeen);
});

test("a plan problem on the computer comes back as PlanUnavailableError", async () => {
  const spawn: Spawner = async () => { throw new PlanUnavailableError("usage limit reached"); };
  await withWorker(spawn, async () => {
    await assert.rejects(enqueueClaude(["-p"], "hi", 5000), (err) => err instanceof PlanUnavailableError && /usage limit/.test(err.message));
  });
});

test("with no worker seen for 3 minutes, Claude steps pause as computer offline", async () => {
  await assert.rejects(enqueueClaude(["-p"], "hi", 5000), WorkerOfflineError);
  kvSet("worker.lastSeen", new Date(Date.now() - 4 * 60_000).toISOString());
  const err = await enqueueClaude(["-p"], "hi", 5000).catch((e) => e);
  assert.ok(err instanceof WorkerOfflineError);
  assert.ok(err instanceof PlanUnavailableError);
  assert.ok(isAccountError(err), "the pack and summary queues pause on it");
  assert.match(err.message, /computer is offline/);
  assert.equal(workerStatus().queued, 0, "nothing was queued");
});

test("arguments outside the allow-list are refused and never run", async () => {
  assert.equal(refusedArgs(["-p", "--tools", "", "--effort", "medium"]), null);
  assert.equal(refusedArgs(["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch", "WebFetch", "--model", "haiku"]), null);
  assert.match(refusedArgs(["-p", "--dangerously-skip-permissions"])!, /isn't allowed/);
  assert.match(refusedArgs(["--tools", "Bash"])!, /WebSearch and WebFetch/);
  assert.match(refusedArgs(["--allowedTools", "WebSearch", "Bash(rm *)"])!, /WebSearch and WebFetch/);
  assert.match(refusedArgs(["--model", "--add-dir"])!, /no value/);
  assert.match(refusedArgs(["-p", "do something"])!, /isn't allowed/);
  assert.ok(refusedArgs("-p"));

  const fake = fakeClaude();
  await withWorker(fake.spawn, async () => {
    for (const args of [["-p", "--dangerously-skip-permissions"], ["--tools", "Bash"], ["--allowedTools", "WebFetch", "Write"], ["--mcp-config", "x.json"]]) {
      await assert.rejects(enqueueClaude(args, "hi", 5000), /refused args/);
    }
  });
  assert.equal(fake.calls.length, 0);
});

test("a claim that doesn't finish in time goes back once, then fails", async () => {
  process.env.JH_WORKER_GRACE_MS = "0";
  kvSet("worker.lastSeen", new Date().toISOString());
  const answer = enqueueClaude(["-p"], "slow one", 100);
  const outcome = answer.catch((e: Error) => e);
  const first = await claimJob(0);
  assert.equal(first?.prompt, "slow one");
  assert.equal(first?.timeoutMs, 100);
  await waitFor(() => workerStatus().queued === 1);
  const second = await claimJob(0);
  assert.equal(second?.id, first!.id);
  const err = await outcome;
  assert.ok(err instanceof Error);
  assert.match(err.message, /didn't finish/);
  assert.equal(completeJob(first!.id, { result: { is_error: false, result: "late" } }), false, "a late answer is ignored");
  assert.deepEqual(await claimJob(0), null);
});

test("worker endpoints need the right bearer token", async () => {
  const status = (headers: Record<string, string>) => fetch(new URL("worker/status", hub), { headers });
  assert.equal((await status({})).status, 401);
  assert.equal((await status({ authorization: "Bearer wrong" })).status, 401);
  assert.equal((await status({ authorization: `Bearer ${TOKEN}x` })).status, 401);
  assert.equal((await fetch(new URL("worker/claim", hub), { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
  const ok = await status({ authorization: `Bearer ${TOKEN}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { queued: 0, claimed: 0, lastSeen: null });

  const worker = startWorker({ hub, token: "wrong", spawn: fakeClaude().spawn, claimWaitMs: 100, backoffMs: 50 });
  await waitFor(() => worker.status().state === "unauthorized");
  await worker.stop();
  assert.equal(workerOnline(), false, "a refused worker doesn't count as seen");
});

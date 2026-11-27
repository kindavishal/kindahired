import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { useMemoryDb } from "../src/db/index.ts";
import { ai, HAIKU_MODEL, haikuAvailable, llm, resetHaiku } from "../src/llm/client.ts";

const schema = z.object({ ok: z.boolean() });
const opts = { system: "s", prompt: "p" };

let apiCalls: Record<string, unknown>[] = [];
let apiError: Error | null = null;
let geminiCalls = 0;
const messages = ai().beta.messages as unknown as { stream: unknown };
const realStream = messages.stream;
const realFetch = globalThis.fetch;
const dir = mkdtempSync(path.join(tmpdir(), "quick-"));
const argsFile = path.join(dir, "args.txt");
const fakeClaude = path.join(dir, "claude");
writeFileSync(fakeClaude, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat >/dev/null\necho '{"is_error":false,"structured_output":{"ok":true}}'\n`);
chmodSync(fakeClaude, 0o755);

beforeEach(() => {
  useMemoryDb();
  resetHaiku();
  apiCalls = [];
  apiError = null;
  geminiCalls = 0;
  process.env.JH_QUICK = "haiku";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "g-key";
  process.env.JH_CLAUDE_BIN = fakeClaude;
  delete process.env.JH_CLAUDE_MODEL;
  delete process.env.JH_CLAUDE_QUICK_MODEL;
  messages.stream = (params: Record<string, unknown>) => {
    apiCalls.push(params);
    return {
      finalMessage: async () => {
        if (apiError) throw apiError;
        return { stop_reason: "end_turn", parsed_output: { ok: true }, usage: {}, content: [] };
      },
    };
  };
  globalThis.fetch = (async () => {
    geminiCalls++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  messages.stream = realStream;
  globalThis.fetch = realFetch;
  delete process.env.JH_QUICK;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

const httpError = (status: number, message: string) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers());

test("haiku is chosen for a quick step when JH_QUICK=haiku and the key is set, without server-side fallback", async () => {
  await llm.structured("gmail.classify:1", schema, opts);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].model, HAIKU_MODEL);
  assert.equal(apiCalls[0].fallbacks, undefined);
  assert.equal(geminiCalls, 0);
});

test("haiku is not used without the key, or when JH_QUICK is gemini", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await llm.structured("gmail.classify:1", schema, opts);
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.JH_QUICK = "gemini";
  await llm.structured("gmail.classify:2", schema, opts);
  assert.equal(apiCalls.length, 0);
  assert.equal(geminiCalls, 2);
});

test("the fit read never goes to haiku", async () => {
  await llm.structured("fit:1", schema, opts);
  assert.equal(apiCalls.length, 0);
});

test("a credit, auth or permission error turns haiku off and the step falls through to gemini", async () => {
  for (const err of [httpError(401, "bad key"), httpError(403, "no access"), httpError(400, "Your credit balance is too low")]) {
    resetHaiku();
    apiError = err;
    geminiCalls = 0;
    await llm.structured("gmail.classify:1", schema, opts);
    assert.equal(geminiCalls, 1, err.message);
    assert.equal(haikuAvailable(), false);
  }
});

test("with haiku out and no gemini key, the step falls through to Claude Code", async () => {
  apiError = httpError(401, "bad key");
  delete process.env.GEMINI_API_KEY;
  await llm.structured("gmail.classify:1", schema, opts);
  assert.match(readFileSync(argsFile, "utf8"), /--model haiku/);
  // Off for 3 hours: the next step doesn't try the API again.
  apiCalls = [];
  await llm.structured("gmail.classify:2", schema, opts);
  assert.equal(apiCalls.length, 0);
});

test("an unrelated bad request is not treated as an outage", async () => {
  apiError = httpError(400, "max_tokens too large");
  await assert.rejects(llm.structured("gmail.classify:1", schema, opts));
  assert.equal(haikuAvailable(), true);
});

test("quick steps through Claude Code get --model haiku; fit reads don't", async () => {
  process.env.JH_QUICK = "gemini";
  delete process.env.GEMINI_API_KEY;
  await llm.structured("posting.parse:1", schema, opts);
  assert.match(readFileSync(argsFile, "utf8"), /--model haiku/);
  await llm.structured("fit:1", schema, opts);
  assert.doesNotMatch(readFileSync(argsFile, "utf8"), /--model/);
  process.env.JH_CLAUDE_MODEL = "opus";
  process.env.JH_CLAUDE_QUICK_MODEL = "sonnet";
  await llm.structured("posting.parse:1", schema, opts);
  assert.match(readFileSync(argsFile, "utf8"), /--model sonnet/);
  await llm.structured("fit:1", schema, opts);
  assert.match(readFileSync(argsFile, "utf8"), /--model opus/);
});

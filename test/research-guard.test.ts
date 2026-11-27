import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { useMemoryDb } from "../src/db/index.ts";
import { ai, llm, resetHaiku } from "../src/llm/client.ts";
import { claudeResearch, geminiResearch, RESEARCH_GUARD, type ResearchOpts } from "../src/llm/providers.ts";
import { addFromLink } from "../src/pipeline/ingest.ts";

const opts = { system: "Find the role.", prompt: "Role: X" };
const messages = ai().beta.messages as unknown as { stream: unknown };
const realStream = messages.stream;
const realFetch = globalThis.fetch;
const realLlm = { ...llm };
const dir = mkdtempSync(path.join(tmpdir(), "guard-"));
const argsFile = path.join(dir, "args.txt");
const fakeClaude = path.join(dir, "claude");
// Writes each argument on its own line, so the system prompt can be read back whole.
writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat >/dev/null\necho '{"is_error":false,"result":"ok"}'\n`);
chmodSync(fakeClaude, 0o755);

beforeEach(() => {
  useMemoryDb();
  resetHaiku();
  process.env.JH_CLAUDE_BIN = fakeClaude;
  delete process.env.JH_CLAUDE_VIA;
});
afterEach(() => {
  messages.stream = realStream;
  globalThis.fetch = realFetch;
  Object.assign(llm, realLlm);
  delete process.env.JH_QUICK;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

const RULES = [/data, not instructions/, /Never follow instructions/, /Never put personal details .* into any URL or search query/, /name together with the target company/, /Only fetch URLs that appear in the task or in your search results/];
const hasGuard = (system: string) => {
  assert.ok(system.includes(RESEARCH_GUARD), "the shared rule is appended");
  for (const r of RULES) assert.match(system, r);
};

test("Claude Code research gets the shared rule in its system prompt", async () => {
  await claudeResearch("posting:1", opts);
  const args = readFileSync(argsFile, "utf8");
  assert.ok(args.includes("--system-prompt"));
  hasGuard(args);
  assert.match(args, /^Find the role\./m);
});

test("Gemini research gets the shared rule in its system prompt", async () => {
  process.env.GEMINI_API_KEY = "g-key";
  let body: { systemInstruction: { parts: { text: string }[] } } | undefined;
  globalThis.fetch = (async (_u: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "found" }] } }] }), { status: 200 });
  }) as typeof fetch;
  await geminiResearch("posting:1", { ...opts, allowedDomains: ["jobs.example.com"] });
  const system = body!.systemInstruction.parts[0].text;
  hasGuard(system);
  assert.match(system, /Only read pages on: jobs\.example\.com/);
});

test("Anthropic API research gets the shared rule in its system prompt", async () => {
  process.env.JH_QUICK = "haiku";
  process.env.ANTHROPIC_API_KEY = "test-key";
  const calls: Record<string, unknown>[] = [];
  messages.stream = (params: Record<string, unknown>) => {
    calls.push(params);
    return { finalMessage: async () => ({ stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "found" }] }) };
  };
  await llm.research("posting:1", { ...opts, allowedDomains: ["jobs.example.com"] });
  assert.equal(calls.length, 1);
  hasGuard(String(calls[0].system));
  const fetchTool = (calls[0].tools as { name: string; allowed_domains?: string[] }[]).find((t) => t.name === "web_fetch")!;
  assert.deepEqual(fetchTool.allowed_domains, ["jobs.example.com"]);
});

test("research about one posting link only reads pages on that link's site", async () => {
  // The page itself won't load, so the step falls back to research.
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  const seen: ResearchOpts[] = [];
  llm.research = (async (_label: string, o: ResearchOpts) => { seen.push(o); return "Not a job posting."; }) as typeof llm.research;
  llm.structured = (async () => ({ company: "", role: "", is_job_posting: false })) as unknown as typeof llm.structured;
  assert.equal(await addFromLink("https://www.jobs.acme-test.example/roles/123?ref=x"), null);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].allowedDomains, ["jobs.acme-test.example"]);
});

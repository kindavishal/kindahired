import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DATA_DIR } from "../config.ts";
import { logEvent } from "../db/index.ts";

export type Effort = "low" | "medium" | "high" | "xhigh";
export interface StructuredOpts { system: string; prompt: string; effort?: Effort; maxTokens?: number }
export interface ResearchOpts { system: string; prompt: string; effort?: Effort; maxSearches?: number; allowedDomains?: string[] }

/** My Claude plan has hit its usage limit, or Claude Code isn't logged in. Work waits; nothing is lost. */
export class PlanUnavailableError extends Error {}

function jsonSchemaOf(schema: z.ZodType) {
  const s = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

// ---------- Claude Code, on my Claude plan ----------

// Runs in an empty folder with no project settings, hooks, plugins or MCP servers, so only the
// prompt and the tools named here are in play.
const AGENT_DIR = path.join(DATA_DIR, "agent");
mkdirSync(AGENT_DIR, { recursive: true });

interface ClaudeResult {
  is_error: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
}

function runClaudeCode(args: string[], prompt: string, timeoutMs: number, model = process.env.JH_CLAUDE_MODEL):Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    // An API key in the environment would make Claude Code bill the API instead of my plan.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(process.env.JH_CLAUDE_BIN ?? "claude", [
      "-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "",
      ...(model ? ["--model", model] : []),
      ...args,
    ], { cwd: AGENT_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Claude Code timed out after ${timeoutMs / 60000} min`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new PlanUnavailableError(`Couldn't start Claude Code: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim().split("\n").pop() ?? "";
      let parsed: ClaudeResult;
      try {
        parsed = JSON.parse(text);
      } catch {
        const msg = (err || out).slice(0, 500);
        if (/log ?in|auth|usage limit|rate limit/i.test(msg)) return reject(new PlanUnavailableError(msg));
        return reject(new Error(`Claude Code exited ${code}: ${msg}`));
      }
      if (parsed.is_error) {
        const msg = String(parsed.result ?? parsed.subtype ?? "error");
        if (/usage limit|limit reached|rate limit|log ?in|authenticat|credit/i.test(msg) || parsed.api_error_status === 429) {
          return reject(new PlanUnavailableError(msg));
        }
        return reject(new Error(`Claude Code: ${msg.slice(0, 500)}`));
      }
      resolve(parsed);
    });
    child.stdin.end(prompt);
  });
}

/** The model for quick steps through Claude Code: Haiku unless JH_CLAUDE_QUICK_MODEL says otherwise. */
export const claudeQuickModel = () => process.env.JH_CLAUDE_QUICK_MODEL || "haiku";

export async function claudeStructured<S extends z.ZodType>(label: string, schema: S, opts: StructuredOpts, quick = false): Promise<z.infer<S>> {
  const res = await runClaudeCode([
    "--system-prompt", opts.system,
    "--tools", "",
    "--effort", opts.effort ?? "medium",
    "--json-schema", JSON.stringify(jsonSchemaOf(schema)),
  ], opts.prompt, 20 * 60_000, quick ? claudeQuickModel() : undefined);
  const parsed = schema.safeParse(res.structured_output ?? safeJson(res.result));
  if (!parsed.success) throw new Error(`${label}: answer didn't match the expected shape: ${parsed.error.message.slice(0, 300)}`);
  logEvent("llm.call", label, { via: "claude-code" });
  return parsed.data;
}

export async function claudeResearch(label: string, opts: ResearchOpts, quick = false):Promise<string> {
  const limits = [
    opts.maxSearches ? `Use at most ${opts.maxSearches} web searches.` : "",
    opts.allowedDomains ? `Only read pages on: ${opts.allowedDomains.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  const res = await runClaudeCode([
    "--system-prompt", `${opts.system}\n\n${limits}\nWhen you're done, reply with your findings as plain text.`.trim(),
    "--tools", "WebSearch,WebFetch",
    "--allowedTools", "WebSearch", "WebFetch",
    "--effort", opts.effort ?? "medium",
  ], opts.prompt, 20 * 60_000, quick ? claudeQuickModel() : undefined);
  logEvent("llm.research", label, { via: "claude-code" });
  return (res.result ?? "").trim();
}

function safeJson(text?: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

// ---------- Gemini (Google AI Studio key), for the fast steps ----------

const GEMINI_KEY = () => process.env.GEMINI_API_KEY ?? "";
export const GEMINI_MODEL = process.env.JH_GEMINI_MODEL ?? "gemini-3.5-flash-lite";
// The free tier allows about 15 requests a minute and a few hundred a day.
const GEMINI_MIN_GAP_MS = 60_000 / Number(process.env.JH_GEMINI_RPM ?? 14);
let geminiNextSlot = 0;
let geminiOutUntil = 0;
// Google Search inside Gemini is a separate quota; on the free tier it can be zero.
let geminiSearchOutUntil = 0;

export function geminiSearchAvailable(): boolean {
  return geminiAvailable() && Date.now() >= geminiSearchOutUntil;
}

export class GeminiUnavailableError extends Error {}

export function geminiAvailable(): boolean {
  return Boolean(GEMINI_KEY()) && Date.now() >= geminiOutUntil;
}

/** Waits for the next free slot under the per-minute limit. */
async function geminiSlot() {
  const now = Date.now();
  const at = Math.max(now, geminiNextSlot);
  geminiNextSlot = at + GEMINI_MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  error?: { code: number; message: string; status: string };
}

async function geminiCall(body: Record<string, unknown>, label: string): Promise<string> {
  if (!geminiAvailable()) throw new GeminiUnavailableError("Gemini isn't set up or is out of quota for today.");
  for (let attempt = 0; attempt < 4; attempt++) {
    await geminiSlot();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const json = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (res.status === 429 && body.tools) {
      // Search isn't available on this key (or is used up): stop trying it for a day.
      geminiSearchOutUntil = Date.now() + 24 * 3600_000;
      logEvent("gemini.search_unavailable", label, json.error?.message?.slice(0, 200));
      throw new GeminiUnavailableError("Gemini web search isn't available on this key.");
    }
    if (res.status === 429) {
      // A daily quota runs out until the next day; a per-minute one clears quickly.
      if (/per ?day|daily|PerDay/i.test(json.error?.message ?? "")) {
        geminiOutUntil = Date.now() + 3 * 3600_000;
        logEvent("gemini.quota", label, json.error?.message);
        throw new GeminiUnavailableError("Gemini's free daily quota is used up; falling back for a few hours.");
      }
      await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
      continue;
    }
    if (res.status === 400 || res.status === 403 || res.status === 404) {
      throw new GeminiUnavailableError(`Gemini ${res.status}: ${json.error?.message ?? ""}`.slice(0, 300));
    }
    if (!res.ok) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (text) return text;
  }
  // An empty answer (often a safety stop on one message) isn't worth failing the step for: the
  // next provider gets it.
  throw new GeminiUnavailableError(`${label}: Gemini gave no answer after retries`);
}

export async function geminiStructured<S extends z.ZodType>(label: string, schema: S, opts: StructuredOpts): Promise<z.infer<S>> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await geminiCall({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: [{ text: attempt ? `${opts.prompt}\n\nYour last answer was invalid: ${last}. Answer again in the exact format.` : opts.prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: jsonSchemaOf(schema) },
    }, label);
    const parsed = schema.safeParse(safeJson(text));
    if (parsed.success) {
      logEvent("llm.call", label, { via: "gemini", model: GEMINI_MODEL });
      return parsed.data;
    }
    last = parsed.error.message.slice(0, 300);
  }
  throw new Error(`${label}: Gemini gave an invalid answer twice: ${last}`);
}

/** Research with Google Search and page reading built in. Returns written findings. */
export async function geminiResearch(label: string, opts: ResearchOpts): Promise<string> {
  const text = await geminiCall({
    systemInstruction: { parts: [{ text: `${opts.system}\n\nSearch the web and read the pages you need. Quote links exactly as you found them. Say plainly when you couldn't find something.` }] },
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    tools: [{ google_search: {} }, { url_context: {} }],
    generationConfig: { temperature: 0 },
  }, label);
  logEvent("llm.research", label, { via: "gemini", model: GEMINI_MODEL });
  return text.trim();
}

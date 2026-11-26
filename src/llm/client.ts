import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { MODEL } from "../config.ts";
import { logEvent } from "../db/index.ts";
import {
  claudeResearch, claudeStructured, geminiAvailable, geminiResearch, geminiSearchAvailable, geminiStructured, GeminiUnavailableError,
  type Effort, type ResearchOpts, type StructuredOpts,
} from "./providers.ts";

/** The quick-step model on the Anthropic API. It has no server-side fallback. */
export const HAIKU_MODEL = "claude-haiku-5-5";

let instance: Anthropic | null = null;
export function ai(): Anthropic {
  instance ??= new Anthropic();
  return instance;
}


// Server-side fallback: if a request is declined, the API retries it on a fallback model.
const FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

const fallbackFor = (model: string) => (model === HAIKU_MODEL ? {} : FALLBACK);

export class RefusalError extends Error {}

function checkStop(msg: { stop_reason: string | null; stop_details?: unknown }, label: string) {
  if (msg.stop_reason === "refusal") {
    logEvent("llm.refusal", label, msg.stop_details ?? null);
    throw new RefusalError(`Model declined: ${label}`);
  }
  if (msg.stop_reason === "max_tokens") throw new Error(`Output cut off (max_tokens): ${label}`);
}

/** One call that must return JSON matching `schema`. */
async function apiStructured<S extends z.ZodType>(
  label: string,
  schema: S,
  opts: { system: string; prompt: string; effort?: Effort; maxTokens?: number },
  model: string = MODEL,
): Promise<z.infer<S>> {
  // Streamed so long outputs (resumes, the evidence bank) don't hit request timeouts.
  const msg = await ai()
    .beta.messages.stream({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      ...fallbackFor(model),
      cache_control: { type: "ephemeral" },
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
      output_config: { format: betaZodOutputFormat(schema), effort: opts.effort ?? "medium" },
    })
    .finalMessage();
  checkStop(msg, label);
  if (msg.parsed_output == null) throw new Error(`No structured output: ${label}`);
  logEvent("llm.call", label, { usage: msg.usage });
  return msg.parsed_output as z.infer<S>;
}

/**
 * A research step with live web search and page fetching. Returns the model's written findings.
 * Long server-tool turns can pause; those are resumed here.
 */
async function apiResearch(
  label: string,
  opts: { system: string; prompt: string; effort?: Effort; maxSearches?: number; allowedDomains?: string[] },
  model: string = MODEL,
): Promise<string> {
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    { type: "web_search_20260209", name: "web_search", max_uses: opts.maxSearches ?? 8 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8, ...(opts.allowedDomains ? { allowed_domains: opts.allowedDomains } : {}) },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.prompt }];
  let text = "";
  for (let turn = 0; turn < 5; turn++) {
    const msg = await ai()
      .beta.messages.stream({
        model,
        max_tokens: 32000,
        ...fallbackFor(model),
        cache_control: { type: "ephemeral" },
        system: opts.system,
        tools,
        messages,
        output_config: { effort: opts.effort ?? "medium" },
      })
      .finalMessage();
    for (const block of msg.content) if (block.type === "text") text += block.text;
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
      continue;
    }
    checkStop(msg, label);
    logEvent("llm.research", label, { usage: msg.usage, turns: turn + 1 });
    return text.trim();
  }
  throw new Error(`Research did not finish: ${label}`);
}

/**
 * Where each step runs. JH_AI picks the mode:
 *   hybrid (default): quick steps (email screening, reading postings, extraction) on Gemini
 *                     when GEMINI_API_KEY is set, else Claude Code; the fit read and writing
 *                     (resume, cover note, outreach) through Claude Code on my Claude plan.
 *   claude:           everything through Claude Code.
 *   api:              the Anthropic API with an API key (needs credit).
 * JH_QUICK=haiku moves the quick steps to Haiku on the Anthropic API (needs ANTHROPIC_API_KEY),
 * ahead of Gemini. Quick steps through Claude Code run on JH_CLAUDE_QUICK_MODEL (default haiku).
 * When a provider is missing or out of quota, the step falls through to the next one.
 */
const MODE = (process.env.JH_AI ?? "hybrid") as "hybrid" | "claude" | "api";
// The fit read stays on Claude: it's the decision I act on, and smaller models misapply the playbook.
const QUICK_STEPS = new Set(["company.screen", "gmail.classify", "status.review", "x.screen", "identify.parse", "posting.parse", "profile.parse", "source.extract"]);
const QUICK_RESEARCH = new Set(["posting", "identify", "people", "profile"]);

// Quick steps on Haiku: JH_QUICK=haiku with an API key. A key, permission or credit problem
// turns it off for 3 hours.
let haikuOutUntil = 0;
export function haikuAvailable(): boolean {
  return process.env.JH_QUICK === "haiku" && Boolean(process.env.ANTHROPIC_API_KEY) && Date.now() >= haikuOutUntil;
}
/** Which provider quick steps use right now (for `jh status`). */
export function quickProvider(): "haiku" | "gemini" | "claude-code" {
  if (MODE === "hybrid" && haikuAvailable()) return "haiku";
  if (MODE === "hybrid" && geminiAvailable()) return "gemini";
  return "claude-code";
}
/** Clears a Haiku outage (tests). */
export function resetHaiku() { haikuOutUntil = 0; }

function haikuDown(err: unknown, label: string): boolean {
  const out =
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    (err instanceof Anthropic.BadRequestError && /credit|billing/i.test(err.message));
  if (out) {
    haikuOutUntil = Date.now() + 3 * 3600_000;
    logEvent("haiku.unavailable", label, String((err as Error).message).slice(0, 200));
  }
  return out;
}

async function routedStructured<S extends z.ZodType>(label: string, schema: S, opts: StructuredOpts): Promise<z.infer<S>> {
  if (MODE === "api") return apiStructured(label, schema, opts);
  const step = label.split(":")[0];
  const quick = QUICK_STEPS.has(step);
  if (MODE === "hybrid" && quick && haikuAvailable()) {
    try {
      return await apiStructured(label, schema, opts, HAIKU_MODEL);
    } catch (err) {
      if (!haikuDown(err, label)) throw err;
    }
  }
  if (MODE === "hybrid" && quick && geminiAvailable()) {
    try {
      return await geminiStructured(label, schema, opts);
    } catch (err) {
      if (!(err instanceof GeminiUnavailableError)) throw err;
    }
  }
  return claudeStructured(label, schema, opts, quick);
}

async function routedResearch(label: string, opts: ResearchOpts): Promise<string> {
  if (MODE === "api") return apiResearch(label, opts);
  const quick = QUICK_RESEARCH.has(label.split(":")[0]);
  if (MODE === "hybrid" && quick && haikuAvailable()) {
    try {
      return await apiResearch(label, opts, HAIKU_MODEL);
    } catch (err) {
      if (!haikuDown(err, label)) throw err;
    }
  }
  if (MODE === "hybrid" && quick && geminiSearchAvailable()) {
    try {
      return await geminiResearch(label, opts);
    } catch (err) {
      if (!(err instanceof GeminiUnavailableError)) throw err;
    }
  }
  return claudeResearch(label, opts, quick);
}

export const AI_MODE = MODE;

/** The AI calls the pipeline uses. Tests swap these for stand-ins. */
export const llm = { structured: routedStructured, research: routedResearch };

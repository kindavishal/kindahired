import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { MODEL } from "../config.ts";
import { logEvent } from "../db/index.ts";
import {
  claudeResearch, claudeStructured, geminiAvailable, geminiResearch, geminiSearchAvailable, geminiStructured, GeminiUnavailableError,
  localAvailable, localStructured,
  type Effort, type ResearchOpts, type StructuredOpts,
} from "./providers.ts";

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
): Promise<z.infer<S>> {
  // Streamed so long outputs (resumes, the evidence bank) don't hit request timeouts.
  const msg = await ai()
    .beta.messages.stream({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 16000,
      ...FALLBACK,
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
        model: MODEL,
        max_tokens: 32000,
        ...FALLBACK,
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
 *                     when GEMINI_API_KEY is set, else the local model; the fit read and writing
 *                     (resume, cover note, outreach) through Claude Code on my Claude plan.
 *   claude:           everything through Claude Code.
 *   local:            quick steps on the local model only.
 *   api:              the Anthropic API with an API key (needs credit).
 * When a provider is missing or out of quota, the step falls through to the next one.
 */
const MODE = (process.env.JH_AI ?? "hybrid") as "hybrid" | "claude" | "local" | "api";
// The fit read stays on Claude: it's the decision I act on, and smaller models misapply the playbook.
const QUICK_STEPS = new Set(["company.screen", "gmail.classify", "status.review", "x.screen", "identify.parse", "posting.parse", "profile.parse", "source.extract"]);
const QUICK_RESEARCH = new Set(["posting", "identify", "people", "profile"]);
const LOCAL_OK = new Set(["company.screen", "gmail.classify", "status.review", "x.screen", "identify.parse", "posting.parse", "profile.parse", "source.extract"]);

async function routedStructured<S extends z.ZodType>(label: string, schema: S, opts: StructuredOpts): Promise<z.infer<S>> {
  if (MODE === "api") return apiStructured(label, schema, opts);
  const step = label.split(":")[0];
  if (MODE === "hybrid" && QUICK_STEPS.has(step) && geminiAvailable()) {
    try {
      return await geminiStructured(label, schema, opts);
    } catch (err) {
      if (!(err instanceof GeminiUnavailableError)) throw err;
    }
  }
  const wantLocal = MODE === "local" || (MODE === "hybrid" && LOCAL_OK.has(step));
  if (wantLocal && (await localAvailable())) return localStructured(label, schema, opts);
  return claudeStructured(label, schema, opts);
}

async function routedResearch(label: string, opts: ResearchOpts): Promise<string> {
  if (MODE === "api") return apiResearch(label, opts);
  if (MODE === "hybrid" && QUICK_RESEARCH.has(label.split(":")[0]) && geminiSearchAvailable()) {
    try {
      return await geminiResearch(label, opts);
    } catch (err) {
      if (!(err instanceof GeminiUnavailableError)) throw err;
    }
  }
  return claudeResearch(label, opts);
}

export const AI_MODE = MODE;

/** Which provider a quick step will use right now: "gemini", "local" or "claude". */
export async function quickProvider(label: string): Promise<"gemini" | "local" | "claude"> {
  const step = label.split(":")[0];
  if (MODE === "hybrid" && QUICK_STEPS.has(step) && geminiAvailable()) return "gemini";
  if ((MODE === "local" || MODE === "hybrid") && LOCAL_OK.has(step) && (await localAvailable())) return "local";
  return "claude";
}

/** True when this step will run on the local model right now. */
export async function willRunLocally(label: string): Promise<boolean> {
  return (await quickProvider(label)) === "local";
}

/** The AI calls the pipeline uses. Tests swap these for stand-ins. */
export const llm = { structured: routedStructured, research: routedResearch };

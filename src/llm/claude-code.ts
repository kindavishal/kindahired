import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PlanUnavailableError } from "./errors.ts";

/** What `claude -p --output-format json` prints as its last line. */
export interface ClaudeResult {
  is_error: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
}

/**
 * The empty folder Claude Code runs in: <JH_DATA_DIR>/agent, else data/agent in the repo.
 *
 * Read at call time and kept free of config.ts, so the desktop app can bundle this file without
 * loading the repo .env or creating repo data folders. It sets JH_DATA_DIR to its own folder.
 */
export function agentDir(): string {
  const dataDir = process.env.JH_DATA_DIR ?? path.resolve(import.meta.dirname, "..", "..", "data");
  return path.join(dataDir, "agent");
}

/**
 * Runs Claude Code once with these arguments and the prompt on stdin. Used on this computer
 * directly, and by the desktop worker for jobs it takes from the hub.
 *
 * It runs in an empty folder with no project settings, hooks, plugins or MCP servers, so only the
 * prompt and the tools named in the arguments are in play.
 */
export function spawnClaude(args: string[], prompt: string, timeoutMs: number): Promise<ClaudeResult> {
  const cwd = agentDir();
  mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    // An API key in the environment would make Claude Code bill the API instead of my plan.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(process.env.JH_CLAUDE_BIN ?? "claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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

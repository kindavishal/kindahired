import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Finding Claude Code on this computer and checking it's signed in. The app never reads or stores
 * Claude's own credentials; it only runs `claude` and reads what it prints.
 */

export const CLAUDE_INSTALL_URL = "https://claude.com/claude-code";

/** Folders an app opened from Finder or a desktop menu often lacks on its PATH. */
export function extraBinDirs(home: string): string[] {
  return [path.join(home, ".claude", "local"), path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** Where to look for `claude`, in order: every PATH entry, then the usual install places. */
export function claudeCandidates(opts: { home: string; pathEnv?: string; platform?: NodeJS.Platform }): string[] {
  const name = (opts.platform ?? process.platform) === "win32" ? "claude.exe" : "claude";
  const dirs = [...(opts.pathEnv ?? "").split(path.delimiter).filter(Boolean), ...extraBinDirs(opts.home)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue; // A relative PATH entry depends on where the app started.
    const file = path.join(dir, name);
    if (!seen.has(file)) { seen.add(file); out.push(file); }
  }
  return out;
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first `claude` that can be run, or null. */
export function findClaude(opts: { home: string; pathEnv?: string; platform?: NodeJS.Platform; isExecutable?: (f: string) => boolean }): string | null {
  const ok = opts.isExecutable ?? isExecutableFile;
  return claudeCandidates(opts).find(ok) ?? null;
}

/** PATH with the usual install folders added, so `claude` (and the node a wrapper script needs) can be found. */
export function widenedPath(pathEnv: string | undefined, home: string, claudeBin?: string | null): string {
  const parts = (pathEnv ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [...(claudeBin ? [path.dirname(claudeBin)] : []), ...extraBinDirs(home)]) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(path.delimiter);
}

export type ClaudeCheck =
  | { state: "ok"; bin: string }
  | { state: "missing"; message: string }
  | { state: "signed-out"; bin: string; message: string }
  | { state: "error"; bin: string; message: string };

const SIGNED_OUT = /log ?in|logged out|not authenticated|authenticat|\/login|api key|oauth|credential/i;

/** Reads the outcome of `claude -p "Reply with ok" --output-format json`. */
export function interpretCheck(bin: string, out: { code: number | null; stdout: string; stderr: string; spawnError?: string }): ClaudeCheck {
  if (out.spawnError) {
    return /ENOENT/.test(out.spawnError)
      ? { state: "missing", message: "Claude Code isn't installed on this computer." }
      : { state: "error", bin, message: `Couldn't start Claude Code: ${out.spawnError}` };
  }
  const last = out.stdout.trim().split("\n").pop() ?? "";
  let parsed: { is_error?: boolean; result?: unknown; subtype?: unknown } | null = null;
  try { parsed = JSON.parse(last); } catch { parsed = null; }
  if (parsed && parsed.is_error === false) return { state: "ok", bin };
  const text = parsed ? String(parsed.result ?? parsed.subtype ?? "") : (out.stderr || out.stdout);
  const short = text.trim().slice(0, 300) || `it exited with code ${out.code}`;
  if (SIGNED_OUT.test(text)) {
    return { state: "signed-out", bin, message: "Claude Code isn't signed in. Open a terminal, run claude, and sign in with your Claude account." };
  }
  if (/usage limit|limit reached|rate limit/i.test(text)) {
    return { state: "error", bin, message: `Claude Code is signed in but has hit its usage limit: ${short}` };
  }
  return { state: "error", bin, message: `Claude Code didn't answer as expected: ${short}` };
}

/**
 * Runs Claude Code once with a tiny prompt, in an empty folder and without any Anthropic API key
 * from the environment (so it uses the person's plan, as the worker does).
 */
export function checkClaude(bin: string | null, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ClaudeCheck> {
  if (!bin) return Promise.resolve({ state: "missing", message: "Claude Code isn't installed on this computer." });
  mkdirSync(opts.cwd, { recursive: true });
  const env = { ...opts.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise((resolve) => {
    let stdout = "", stderr = "", settled = false;
    const finish = (r: ClaudeCheck) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const child = spawn(bin, ["-p", "Reply with ok", "--output-format", "json", "--no-session-persistence"], { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ state: "error", bin, message: "Claude Code took over a minute to answer. Try again, or run claude in a terminal to see what it's waiting for." });
    }, opts.timeoutMs ?? 60_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish(interpretCheck(bin, { code: null, stdout, stderr, spawnError: e.message })));
    child.on("close", (code) => finish(interpretCheck(bin, { code, stdout, stderr })));
  });
}

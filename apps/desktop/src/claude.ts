import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnCli, stopTree } from "../../../src/llm/cli-spawn.ts";

/**
 * Finding Claude Code on this computer and checking it's signed in. The app never reads or stores
 * Claude's own credentials; it only runs `claude` and reads what it prints.
 */

export const CLAUDE_INSTALL_URL = "https://claude.com/claude-code";

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

/** Folders an app opened from Finder, a desktop menu or the Start menu often lacks on its PATH. */
export function extraBinDirs(home: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const p = pathFor(platform);
  if (platform === "win32") {
    // The Windows installer puts claude.exe in ~\.local\bin; an npm install puts claude.cmd in %APPDATA%\npm.
    return [p.join(home, ".local", "bin"), p.join(home, ".claude", "local"), p.join(env.APPDATA || p.join(home, "AppData", "Roaming"), "npm")];
  }
  return [p.join(home, ".claude", "local"), p.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** Where to look for `claude`, in order: every PATH entry, then the usual install places. */
export function claudeCandidates(opts: { home: string; pathEnv?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): string[] {
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  // In each folder the real program comes before npm's .cmd launcher.
  const names = platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = [...(opts.pathEnv ?? "").split(p.delimiter).filter(Boolean), ...extraBinDirs(opts.home, platform, opts.env)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (!p.isAbsolute(dir)) continue; // A relative PATH entry depends on where the app started.
    for (const name of names) {
      const file = p.join(dir, name);
      const key = platform === "win32" ? file.toLowerCase() : file;
      if (!seen.has(key)) { seen.add(key); out.push(file); }
    }
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
export function findClaude(opts: { home: string; pathEnv?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; isExecutable?: (f: string) => boolean }): string | null {
  const ok = opts.isExecutable ?? isExecutableFile;
  return claudeCandidates(opts).find(ok) ?? null;
}

/** PATH with the usual install folders added, so `claude` (and the node a wrapper script needs) can be found. */
export function widenedPath(pathEnv: string | undefined, home: string, claudeBin?: string | null, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  const parts = (pathEnv ?? "").split(p.delimiter).filter(Boolean);
  for (const dir of [...(claudeBin ? [p.dirname(claudeBin)] : []), ...extraBinDirs(home, platform)]) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(p.delimiter);
}

export type ClaudeCheck =
  | { state: "ok"; bin: string }
  | { state: "missing"; message: string }
  | { state: "signed-out"; bin: string; message: string }
  | { state: "error"; bin: string; message: string };

/** Why Claude Code wasn't found. On Windows, a copy inside WSL is out of the app's reach. */
export function missingMessage(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "Claude Code isn't installed on this computer. If you use it inside WSL, also install the Windows version: the app can't run Claude Code inside WSL."
    : "Claude Code isn't installed on this computer.";
}

const SIGNED_OUT = /log ?in|logged out|not authenticated|authenticat|\/login|api key|oauth|credential/i;

/** Reads the outcome of `claude -p "Reply with ok" --output-format json`. */
export function interpretCheck(bin: string, out: { code: number | null; stdout: string; stderr: string; spawnError?: string }): ClaudeCheck {
  if (out.spawnError) {
    return /ENOENT/.test(out.spawnError)
      ? { state: "missing", message: missingMessage() }
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
  if (!bin) return Promise.resolve({ state: "missing", message: missingMessage() });
  mkdirSync(opts.cwd, { recursive: true });
  const env = { ...opts.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise((resolve) => {
    let stdout = "", stderr = "", settled = false;
    const finish = (r: ClaudeCheck) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(bin, ["-p", "Reply with ok", "--output-format", "json", "--no-session-persistence"], { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ state: "error", bin, message: `Couldn't start Claude Code: ${(e as Error).message}` });
    }
    const timer = setTimeout(() => {
      stopTree(child);
      finish({ state: "error", bin, message: "Claude Code took over a minute to answer. Try again, or run claude in a terminal to see what it's waiting for." });
    }, opts.timeoutMs ?? 60_000);
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish(interpretCheck(bin, { code: null, stdout, stderr, spawnError: e.message })));
    child.on("close", (code) => finish(interpretCheck(bin, { code, stdout, stderr })));
  });
}

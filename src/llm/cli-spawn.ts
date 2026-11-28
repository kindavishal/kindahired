import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Starting a command-line program, and stopping it with everything it started, on macOS, Linux
 * and Windows. Kept free of config.ts so the desktop app can bundle it.
 */

export interface Launch {
  command: string;
  args: string[];
}

/**
 * What to run for `bin args`. On Windows an npm install of Claude Code is a `claude.cmd` shim, and
 * Node won't start a .cmd without a shell (where the arguments would be re-parsed by cmd.exe). So
 * the shim is read for the program it starts, and that program is run directly: a .exe as it is,
 * a .js with the node next to the shim, else the node on PATH, as the shim itself does.
 */
export function launchFor(
  bin: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; readFile?: (f: string) => string; exists?: (f: string) => boolean } = {},
): Launch {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return { command: bin, args };
  const read = opts.readFile ?? ((f: string) => readFileSync(f, "utf8"));
  const exists = opts.exists ?? existsSync;
  const dir = path.win32.dirname(bin);
  let shim: string;
  try {
    shim = read(bin);
  } catch (err) {
    throw new Error(`Couldn't read ${bin}: ${(err as Error).message}`);
  }
  const targets = [...shim.matchAll(/"%~?dp0%?\\([^"%]+?\.(?:exe|js|cjs|mjs))"/gi)]
    .map((m) => m[1])
    .filter((t) => !/(^|\\)node\.exe$/i.test(t));
  const target = targets.pop();
  if (!target) {
    throw new Error(`${bin} isn't a launcher this app can read. Install Claude Code with its Windows installer from https://claude.com/claude-code instead.`);
  }
  const file = path.win32.join(dir, target);
  if (/\.exe$/i.test(file)) return { command: file, args };
  const localNode = path.win32.join(dir, "node.exe");
  return { command: exists(localNode) ? localNode : "node", args: [file, ...args] };
}

/** Starts `bin args` (see launchFor) with no console window on Windows. */
export function spawnCli(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ("pipe" | "ignore")[] }): ChildProcess {
  const l = launchFor(bin, args);
  return spawn(l.command, l.args, { cwd: opts.cwd, env: opts.env, stdio: opts.stdio as never, windowsHide: true });
}

/**
 * Stops the program and whatever it started. On Windows a signal ends only that one process, so
 * Claude Code's own tools and servers would keep running: taskkill /T takes the whole tree.
 */
export function stopTree(child: ChildProcess, platform: NodeJS.Platform = process.platform) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32" && child.pid) {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
}

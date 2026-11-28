import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnClaude, type ClaudeResult } from "../llm/claude-code.ts";
import { PlanUnavailableError } from "../llm/errors.ts";

/**
 * The desktop worker. It takes Claude Code jobs from the person's engine on the hub, runs them on
 * this computer (on the person's own Claude plan), and sends the answers back.
 *
 *   npm run worker -- --hub https://<hub domain>/ --token <worker token>
 *
 * The token can also come from JH_WORKER_TOKEN. The desktop app starts it with startWorker().
 */

// Only the flags the engine itself sends. Anything else is refused and never run.
const BARE_FLAGS = new Set(["-p", "--no-session-persistence", "--strict-mcp-config"]);
const VALUE_FLAGS = new Set(["--output-format", "--setting-sources", "--model", "--system-prompt", "--tools", "--effort", "--json-schema"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);
const onlyWebTools = (v: string) => v.split(/[\s,]+/).filter(Boolean).every((t) => WEB_TOOLS.has(t));

/** Why these arguments can't be run, or null when they're allowed. */
export function refusedArgs(args: unknown): string | null {
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return "the arguments aren't a list of strings";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (BARE_FLAGS.has(flag)) continue;
    if (VALUE_FLAGS.has(flag)) {
      const value = args[++i];
      // A value that looks like a flag could be read as one.
      if (value === undefined || value.startsWith("-")) return `${flag} has no value`;
      if (flag === "--tools" && !onlyWebTools(value)) return "--tools may only name WebSearch and WebFetch";
      continue;
    }
    if (flag === "--allowedTools") {
      let named = 0;
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        if (!onlyWebTools(args[++i])) return "--allowedTools may only name WebSearch and WebFetch";
        named++;
      }
      if (!named) return "--allowedTools has no value";
      continue;
    }
    return `${flag.slice(0, 60)} isn't allowed`;
  }
  return null;
}

export type Spawner = (args: string[], prompt: string, timeoutMs: number) => Promise<ClaudeResult>;

export interface WorkerStatus {
  /** connecting: not reached the hub yet; online: waiting for jobs; working: running at least one. */
  state: "connecting" | "online" | "working" | "offline" | "unauthorized" | "stopped";
  running: number;
  done: number;
  /** What the running jobs are doing, as the hub describes them ("Writing your resume for Toast"). */
  doing: string[];
  error?: string;
}

export interface WorkerOptions {
  hub: string;
  token: string;
  /** Jobs run at the same time. Default 1. */
  concurrency?: number;
  onStatus?: (s: WorkerStatus) => void;
  /** For tests: runs a job instead of the real Claude Code. */
  spawn?: Spawner;
  /** Wait after a network error. Default 30 s. */
  backoffMs?: number;
  /** How long each claim may wait on the hub. Default (and cap) 25 s. */
  claimWaitMs?: number;
}

interface Job { id: number; args: unknown; prompt: string; timeoutMs: number; title?: unknown }

export function startWorker(opts: WorkerOptions): { stop: () => Promise<void>; status: () => WorkerStatus } {
  const base = new URL(opts.hub.endsWith("/") ? opts.hub : opts.hub + "/");
  const spawner = opts.spawn ?? spawnClaude;
  const backoffMs = opts.backoffMs ?? 30_000;
  const stopping = new AbortController();
  let status: WorkerStatus = { state: "connecting", running: 0, done: 0, doing: [] };
  const report = (patch: Partial<WorkerStatus>) => {
    status = { ...status, ...patch };
    if (status.state !== "offline" && status.state !== "unauthorized") delete status.error;
    opts.onStatus?.({ ...status });
  };
  const idle = () => report({ state: status.running ? "working" : "online" });

  const call = (p: string, init: { method: string; body?: unknown; timeoutMs: number; stoppable: boolean }) => fetch(new URL(p, base), {
    method: init.method,
    headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.stoppable ? AbortSignal.any([stopping.signal, AbortSignal.timeout(init.timeoutMs)]) : AbortSignal.timeout(init.timeoutMs),
  });

  const pause = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); stopping.signal.removeEventListener("abort", done); resolve(); }
    stopping.signal.addEventListener("abort", done);
  });

  async function run(job: Job): Promise<Record<string, unknown>> {
    const why = refusedArgs(job.args);
    if (why) {
      console.error(`Worker: refused job ${job.id}: ${why}`);
      return { id: job.id, error: "refused args", planUnavailable: false };
    }
    try {
      return { id: job.id, result: await spawner(job.args as string[], String(job.prompt ?? ""), Number(job.timeoutMs) || 20 * 60_000) };
    } catch (err) {
      return { id: job.id, error: String((err as Error)?.message ?? err), planUnavailable: err instanceof PlanUnavailableError };
    }
  }

  async function complete(body: Record<string, unknown>) {
    // The answer took real work, so keep trying for a while, even while stopping.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const res = await call("worker/complete", { method: "POST", body, timeoutMs: 30_000, stoppable: false });
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 401)) return;
        if (res.status === 401) report({ state: "unauthorized", error: "The hub refused this worker's token." });
      } catch (err) {
        report({ state: "offline", error: String((err as Error)?.message ?? err) });
      }
      if (stopping.signal.aborted) return;
      await pause(backoffMs);
    }
  }

  async function slot() {
    while (!stopping.signal.aborted) {
      let job: Job | null;
      try {
        const res = await call("worker/claim", { method: "POST", body: { waitMs: opts.claimWaitMs ?? 25_000 }, timeoutMs: 60_000, stoppable: true });
        if (res.status === 401) {
          report({ state: "unauthorized", error: "The hub refused this worker's token." });
          await pause(backoffMs);
          continue;
        }
        if (!res.ok) throw new Error(`The hub answered ${res.status}`);
        job = ((await res.json()) as { job: Job | null }).job;
      } catch (err) {
        if (stopping.signal.aborted) break;
        report({ state: "offline", error: String((err as Error)?.message ?? err) });
        await pause(backoffMs);
        continue;
      }
      if (!job) { if (status.state !== "online" && status.state !== "working") idle(); continue; }
      // An older hub sends no title.
      const title = typeof job.title === "string" && job.title.trim() ? job.title.trim().slice(0, 80) : "Preparing something for you";
      report({ running: status.running + 1, state: "working", doing: [...status.doing, title] });
      const outcome = await run(job);
      await complete(outcome);
      const doing = [...status.doing];
      doing.splice(doing.indexOf(title), 1);
      report({ running: status.running - 1, done: status.done + 1, doing });
      idle();
    }
  }

  // Say hello first, so the status shows online without waiting out a whole claim.
  const hello = call("worker/status", { method: "GET", timeoutMs: 15_000, stoppable: true })
    .then((res) => res.status === 401 ? report({ state: "unauthorized", error: "The hub refused this worker's token." }) : res.ok ? idle() : undefined)
    .catch(() => {});
  const loops = Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, () => slot());

  return {
    status: () => ({ ...status }),
    async stop() {
      stopping.abort();
      await Promise.all([hello, ...loops]);
      report({ state: "stopped" });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { hub: { type: "string" }, token: { type: "string" }, concurrency: { type: "string" } } });
  const token = values.token ?? process.env.JH_WORKER_TOKEN ?? "";
  if (!values.hub || !token) {
    console.error("Usage: npm run worker -- --hub <url> --token <worker token>  (or set JH_WORKER_TOKEN)");
    process.exit(1);
  }
  let last = "";
  const worker = startWorker({
    hub: values.hub,
    token,
    concurrency: Number(values.concurrency ?? 1),
    onStatus: (s) => {
      const line = `${s.state}${s.running ? `, running ${s.running}` : ""}${s.error ? `: ${s.error}` : ""}`;
      if (line !== last) console.log(`${new Date().toISOString()} ${line}`);
      last = line;
    },
  });
  const quit = () => { void worker.stop().then(() => process.exit(0)); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

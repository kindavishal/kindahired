import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { db, kvGet, kvSet, nowIso } from "../db/index.ts";
import type { ClaudeResult } from "../llm/claude-code.ts";
import { PlanUnavailableError } from "../llm/errors.ts";

/**
 * On the hub, Claude Code runs on the person's own computer. The engine queues each call here, the
 * desktop worker claims it over HTTP (see routes.ts), runs it, and sends the result back.
 */

/** No claim from the worker for this long means the computer is off or asleep. */
export const OFFLINE_AFTER_MS = 3 * 60_000;
/** The longest a claim request is held open when nothing is queued. */
export const CLAIM_WAIT_MAX_MS = 25_000;
/** A job is handed out at most this many times. */
const MAX_ATTEMPTS = 2;
// Extra time past a job's own timeout before a claim counts as abandoned, so the worker's own
// timeout report arrives first.
const graceMs = () => Number(process.env.JH_WORKER_GRACE_MS ?? 15_000);

export class WorkerOfflineError extends PlanUnavailableError {
  constructor(message = "Your computer is offline, so kindahired can't prepare anything until it's back.") {
    super(message);
    this.name = "WorkerOfflineError";
  }
}

/** `title` says what the job is doing, for the desktop app's menu ("Writing your resume for Toast"). */
export interface ClaimedJob { id: number; args: string[]; prompt: string; timeoutMs: number; title?: string }
export type Completion = { result: ClaudeResult } | { error: string; planUnavailable?: boolean };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_jobs (
  id INTEGER PRIMARY KEY,
  args TEXT NOT NULL,              -- JSON array of claude arguments
  prompt TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL,
  title TEXT,                      -- what it's doing, in the person's words
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | claimed | done | failed
  result TEXT,                     -- JSON ClaudeResult
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at TEXT,
  finished_at TEXT
);
`;

interface Waiter { resolve: (r: ClaudeResult) => void; reject: (e: Error) => void }
interface State { waiters: Map<number, Waiter>; timers: Map<number, NodeJS.Timeout> }
// Keyed by database, so a test's fresh in-memory database starts clean.
const states = new WeakMap<DatabaseSync, State>();
const bus = new EventEmitter();
bus.setMaxListeners(0);

function open(): { d: DatabaseSync; s: State } {
  const d = db();
  let s = states.get(d);
  if (!s) {
    d.exec(SCHEMA);
    // Older databases made the table before it had a title.
    if (!(d.prepare("SELECT 1 FROM pragma_table_info('worker_jobs') WHERE name = 'title'").get())) d.exec("ALTER TABLE worker_jobs ADD COLUMN title TEXT");
    // Nobody is waiting for jobs left over from before a restart.
    d.prepare("UPDATE worker_jobs SET status = 'failed', error = 'The engine restarted before this finished', finished_at = ? WHERE status IN ('queued', 'claimed')").run(nowIso());
    d.prepare("DELETE FROM worker_jobs WHERE finished_at < ?").run(new Date(Date.now() - 24 * 3600_000).toISOString());
    s = { waiters: new Map(), timers: new Map() };
    states.set(d, s);
  }
  return { d, s };
}

export function workerLastSeen(): string | null {
  return kvGet("worker.lastSeen") ?? null;
}

export function workerOnline(now = Date.now()): boolean {
  const seen = workerLastSeen();
  return Boolean(seen) && now - new Date(seen!).getTime() < OFFLINE_AFTER_MS;
}

/** Queues one Claude Code call for the desktop worker and waits for its answer. */
export async function enqueueClaude(args: string[], prompt: string, timeoutMs: number, title?: string): Promise<ClaudeResult> {
  if (!workerOnline()) throw new WorkerOfflineError();
  const { d, s } = open();
  const row = d.prepare("INSERT INTO worker_jobs (args, prompt, timeout_ms, title) VALUES (?, ?, ?, ?) RETURNING id")
    .get(JSON.stringify(args), prompt, timeoutMs, title ?? null) as { id: number };
  const id = Number(row.id);
  const answer = new Promise<ClaudeResult>((resolve, reject) => s.waiters.set(id, { resolve, reject }));
  // A job still in the queue when the computer drops off fails now instead of waiting for it.
  const watch = setInterval(() => {
    if (!workerOnline()) settle(d, s, id, { error: new WorkerOfflineError() }, ["queued"]);
  }, 30_000);
  watch.unref();
  bus.emit("queued");
  try {
    return await answer;
  } finally {
    clearInterval(watch);
  }
}

/** Hands the oldest queued job to the worker, waiting up to `waitMs` (at most 25 s) for one. */
export async function claimJob(waitMs = CLAIM_WAIT_MAX_MS, signal?: AbortSignal): Promise<ClaimedJob | null> {
  const deadline = Date.now() + Math.min(Math.max(0, waitMs || 0), CLAIM_WAIT_MAX_MS);
  for (;;) {
    kvSet("worker.lastSeen", nowIso());
    const job = takeNext();
    if (job || signal?.aborted) return job;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await waitForQueued(left, signal);
  }
}

function takeNext(): ClaimedJob | null {
  const { d, s } = open();
  const row = d.prepare(`UPDATE worker_jobs SET status = 'claimed', claimed_at = ?, attempts = attempts + 1
    WHERE id = (SELECT id FROM worker_jobs WHERE status = 'queued' ORDER BY id LIMIT 1)
    RETURNING id, args, prompt, timeout_ms, title`).get(nowIso()) as { id: number; args: string; prompt: string; timeout_ms: number; title: string | null } | undefined;
  if (!row) return null;
  const id = Number(row.id), timeoutMs = Number(row.timeout_ms);
  clearTimeout(s.timers.get(id));
  const timer = setTimeout(() => reclaim(d, s, id, timeoutMs), timeoutMs + graceMs());
  timer.unref();
  s.timers.set(id, timer);
  return { id, args: JSON.parse(row.args), prompt: row.prompt, timeoutMs, ...(row.title ? { title: row.title } : {}) };
}

/** A claim that didn't finish in time goes back in the queue once, then fails. */
function reclaim(d: DatabaseSync, s: State, id: number, timeoutMs: number) {
  s.timers.delete(id);
  const row = d.prepare("SELECT status, attempts FROM worker_jobs WHERE id = ?").get(id) as { status: string; attempts: number } | undefined;
  if (row?.status !== "claimed") return;
  if (Number(row.attempts) < MAX_ATTEMPTS) {
    d.prepare("UPDATE worker_jobs SET status = 'queued', claimed_at = NULL WHERE id = ? AND status = 'claimed'").run(id);
    bus.emit("queued");
    return;
  }
  settle(d, s, id, { error: new Error(`Claude Code on your computer didn't finish within ${Math.round(timeoutMs / 60000)} min, twice`) }, ["claimed"]);
}

/** Puts a claimed job back, for a worker that hung up before it received it. */
export function releaseJob(id: number) {
  const { d, s } = open();
  clearTimeout(s.timers.get(id));
  s.timers.delete(id);
  const changed = d.prepare("UPDATE worker_jobs SET status = 'queued', claimed_at = NULL, attempts = attempts - 1 WHERE id = ? AND status = 'claimed'").run(id).changes;
  if (changed) bus.emit("queued");
}

/** The worker's answer for a job it claimed. False when the job isn't claimed (any more). */
export function completeJob(id: number, c: Completion): boolean {
  const { d, s } = open();
  if ("result" in c) return settle(d, s, id, { result: c.result }, ["claimed"]);
  const msg = String(c.error || "error").slice(0, 1000);
  return settle(d, s, id, { error: c.planUnavailable ? new PlanUnavailableError(msg) : new Error(msg) }, ["claimed"]);
}

function settle(d: DatabaseSync, s: State, id: number, outcome: { result?: ClaudeResult; error?: Error }, from: string[]): boolean {
  const changed = d.prepare(`UPDATE worker_jobs SET status = ?, result = ?, error = ?, finished_at = ?
    WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`).run(
    outcome.error ? "failed" : "done",
    outcome.result ? JSON.stringify(outcome.result) : null,
    outcome.error?.message ?? null,
    nowIso(), id, ...from,
  ).changes;
  if (!changed) return false;
  clearTimeout(s.timers.get(id));
  s.timers.delete(id);
  const w = s.waiters.get(id);
  s.waiters.delete(id);
  if (outcome.error) w?.reject(outcome.error);
  else w?.resolve(outcome.result!);
  return true;
}

export function workerStatus(): { queued: number; claimed: number; lastSeen: string | null } {
  const { d } = open();
  const n = (status: string) => Number((d.prepare("SELECT count(*) n FROM worker_jobs WHERE status = ?").get(status) as { n: number }).n);
  return { queued: n("queued"), claimed: n("claimed"), lastSeen: workerLastSeen() };
}

function waitForQueued(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      bus.off("queued", done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    bus.on("queued", done);
    signal?.addEventListener("abort", done);
  });
}

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CLAIM_WAIT_MAX_MS, claimJob, completeJob, releaseJob, workerStatus } from "./queue.ts";

/**
 * The desktop worker's endpoints on the engine's dashboard server. Every request needs
 * `Authorization: Bearer <JH_WORKER_TOKEN>`.
 */

const MAX_BODY = 20 * 1024 * 1024;

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.JH_WORKER_TOKEN ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  if (!expected || !m) return false;
  // Hashing first makes both sides the same length, so the comparison takes the same time.
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(m[1]), hash(expected));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : {};
}

export async function handleWorker(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const json = (code: number, data: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  };
  if (!authorized(req)) return json(401, { error: "unauthorized" });

  if (req.method === "GET" && url.pathname === "/worker/status") return json(200, workerStatus());

  if (req.method === "POST" && url.pathname === "/worker/claim") {
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
    const hungUp = new AbortController();
    res.on("close", () => hungUp.abort());
    const waitMs = typeof body.waitMs === "number" ? body.waitMs : CLAIM_WAIT_MAX_MS;
    const job = await claimJob(waitMs, hungUp.signal);
    // The response hasn't been sent, so a close here means the worker hung up.
    if (job && hungUp.signal.aborted) return releaseJob(job.id);
    return json(200, { job });
  }

  if (req.method === "POST" && url.pathname === "/worker/complete") {
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch { return json(400, { error: "bad body" }); }
    const id = Number(body.id);
    if (!Number.isInteger(id)) return json(400, { error: "id missing" });
    const r = body.result as { is_error?: unknown } | undefined;
    if (r && typeof r === "object" && typeof r.is_error === "boolean") {
      return json(200, { ok: completeJob(id, { result: body.result as never }) });
    }
    if (typeof body.error === "string") {
      return json(200, { ok: completeJob(id, { error: body.error, planUnavailable: body.planUnavailable === true }) });
    }
    return json(400, { error: "needs a result or an error" });
  }

  json(404, { error: "not found" });
}

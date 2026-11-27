import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { adminPage, type PersonRow } from "./admin-page.ts";
import { addRequest, getRequest, listRequests, recordDecision, requestByEmail, setTelegramMessage, validateRequest, type AccessRequest } from "./early-access.ts";
import { loadPeople, type Person } from "./people.ts";
import { provision, type ProvisionDeps, type Step } from "./provision.ts";

/**
 * The router's early-access and admin routes:
 *   POST /early-access                     the landing page's form (public; CORS for the landing page)
 *   GET  /early-access/status              where a signed-in email's request stands (gateway only)
 *   POST /early-access/verified            a request from someone signed in (gateway only)
 *   GET  /admin                            the operator's page (only through the gateway, after sign-in)
 *   POST /admin/requests/<id>/approve      approve (or retry what failed)
 *   POST /admin/requests/<id>/decline
 * and the Approve / Decline buttons on the Telegram message each request sends the operator.
 */

export interface EarlyAccessContext {
  db: DatabaseSync;
  dir: string;
  log: (msg: string) => void;
  telegramJson: (method: string, body: Record<string, unknown>) => Promise<Response>;
  deps: ProvisionDeps;
  env?: NodeJS.ProcessEnv;
  /** Asks an engine for its worker status; null when it doesn't answer. Tests replace it. */
  engineStatus?: (p: Person) => Promise<PersonRow["app"]>;
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function readSmallBody(req: http.IncomingMessage, limit = 4096): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function earlyAccess(ctx: EarlyAccessContext) {
  const env = ctx.env ?? process.env;
  const admins = () => (env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const isAdmin = (email: string) => admins().includes(email.trim().toLowerCase());
  const adminChats = () => loadPeople(ctx.dir).filter((p) => isAdmin(p.email) && p.chatId !== null).map((p) => p.chatId!);
  const origins = () => (env.LANDING_ORIGIN ?? "https://kindahired.kindavishal.dev").split(",").map((o) => o.trim()).filter(Boolean);
  const approving = new Set<number>();

  const engineStatus = ctx.engineStatus ?? (async (p: Person) => {
    try {
      const res = await fetch(`http://127.0.0.1:${p.port}/worker/status`, {
        headers: { authorization: `Bearer ${p.workerToken}`, "x-kindahired-gateway": env.HUB_GATEWAY_SECRET ?? "" },
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return null;
      const s = (await res.json()) as { lastSeen?: string | null; queued?: number };
      return { lastSeen: s.lastSeen ?? null, queued: s.queued ?? 0 };
    } catch {
      return null;
    }
  });

  // ---------- Telegram ----------

  const requestText = (r: AccessRequest, outcome = "") =>
    `<b>Early access request</b>\n${esc(r.email)}${r.verified ? " (email confirmed)" : ""}\n${esc(r.linkedin)}${outcome ? `\n\n${outcome}` : ""}`;
  const stepsText = (steps: Step[]) => steps.map((s) => `${s.ok ? "✓" : "✕"} ${esc(s.name)}: ${esc(s.detail)}`).join("\n");

  async function notify(r: AccessRequest) {
    for (const chat of adminChats()) {
      try {
        const res = await ctx.telegramJson("sendMessage", {
          chat_id: chat, text: requestText(r), parse_mode: "HTML", disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `ea:approve:${r.id}` }, { text: "Decline", callback_data: `ea:decline:${r.id}` }]] },
        });
        const body = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
        if (body?.result?.message_id) setTelegramMessage(ctx.db, r.id, body.result.message_id);
      } catch (err) {
        ctx.log(`early access: couldn't tell chat ${chat}: ${err}`);
      }
    }
  }

  async function updateMessage(r: AccessRequest, outcome: string) {
    if (!r.telegram_message) return;
    for (const chat of adminChats()) {
      await ctx.telegramJson("editMessageText", {
        chat_id: chat, message_id: r.telegram_message, text: requestText(r, outcome), parse_mode: "HTML", disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => undefined);
    }
  }

  // ---------- Decisions ----------

  async function decide(id: number, verb: "approve" | "decline"): Promise<string> {
    const r = getRequest(ctx.db, id);
    if (!r) return "That request isn't there any more.";
    if (verb === "decline") {
      if (r.status === "approved") return `${r.email} is already approved.`;
      recordDecision(ctx.db, id, { status: "declined" });
      await updateMessage(r, "Declined.");
      return `Declined ${r.email}.`;
    }
    if (approving.has(id)) return `Already approving ${r.email}.`;
    approving.add(id);
    try {
      let previous: Step[] = [];
      try { previous = r.steps ? (JSON.parse(r.steps) as Step[]) : []; } catch { /* start over */ }
      const { person, steps } = await provision(r, ctx.deps, previous);
      recordDecision(ctx.db, id, { status: "approved", person, steps });
      const allOk = steps.every((s) => s.ok);
      ctx.log(`early access: approved ${r.email} as ${person}${allOk ? "" : " (some steps failed)"}`);
      await updateMessage(r, `${allOk ? "Approved." : "Approved, but some steps failed. Retry them from /admin."}\n${stepsText(steps)}`);
      return allOk ? `Approved ${r.email}. They have an account, can sign in, and got the invite.` : `Approved ${r.email}, but some steps failed: ${steps.filter((s) => !s.ok).map((s) => `${s.name} (${s.detail})`).join("; ")}`;
    } finally {
      approving.delete(id);
    }
  }

  /** An Approve / Decline tap from an operator's chat. Returns false for any other update. */
  async function onCallback(u: { callback_query?: { id?: string; data?: string; message?: { chat?: { id: number } } } }): Promise<boolean> {
    const q = u.callback_query;
    const m = q?.data?.match(/^ea:(approve|decline):(\d+)$/);
    if (!q || !m) return false;
    const chat = q.message?.chat?.id;
    const from = loadPeople(ctx.dir).find((p) => p.chatId !== null && String(p.chatId) === String(chat));
    if (!from || !isAdmin(from.email)) return false;
    await ctx.telegramJson("answerCallbackQuery", { callback_query_id: q.id, text: m[1] === "approve" ? "Approving…" : "Declining…" }).catch(() => undefined);
    const result = await decide(Number(m[2]), m[1] as "approve" | "decline");
    ctx.log(`early access: ${result}`);
    return true;
  }

  // ---------- HTTP ----------

  /** POST /early-access from the landing page. */
  async function publicRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = String(req.headers.origin ?? "");
    const cors: Record<string, string> = origins().includes(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", vary: "origin" }
      : {};
    const reply = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...cors });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return void res.end(); }
    if (req.method !== "POST") return reply(405, { ok: false });
    const raw = await readSmallBody(req);
    if (raw === null) return reply(413, { ok: false, error: "That's too long." });
    let fields: Record<string, unknown> = {};
    try {
      fields = String(req.headers["content-type"] ?? "").includes("json") ? (JSON.parse(raw) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
    } catch {
      return reply(400, { ok: false, error: "Something went wrong. Try again." });
    }
    // A field people never see: only bots fill it in. They get the same answer as everyone else.
    if (String(fields.website ?? "").trim()) return reply(200, { ok: true });
    const v = validateRequest(fields.email, fields.linkedin);
    if ("error" in v) return reply(400, { ok: false, error: v.error });
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
    const added = addRequest(ctx.db, { ...v, ip });
    if ("error" in added) return reply(429, { ok: false, error: "Too many requests from here. Try again in an hour." });
    if (added.created) {
      ctx.log(`early access: request from ${v.email}`);
      void notify(added.request);
    }
    reply(200, { ok: true });
  }

  /** Calls from the gateway about a signed-in email: where its request stands, or a new request. */
  async function internalRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const reply = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const secret = env.HUB_GATEWAY_SECRET ?? "";
    const email = String(req.headers["x-kindahired-email"] ?? "").trim().toLowerCase();
    if (!secret || !sameSecret(String(req.headers["x-kindahired-gateway"] ?? ""), secret) || !email) return reply(403, { ok: false });
    if (url.pathname === "/early-access/status" && req.method === "GET") {
      return reply(200, { status: requestByEmail(ctx.db, email)?.status ?? "none" });
    }
    if (url.pathname === "/early-access/verified" && req.method === "POST") {
      const raw = await readSmallBody(req);
      let linkedin: unknown = "";
      try { linkedin = (JSON.parse(raw ?? "{}") as { linkedin?: unknown }).linkedin; } catch { /* empty */ }
      const v = validateRequest(email, linkedin);
      if ("error" in v) return reply(400, { ok: false, error: v.error });
      const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
      const added = addRequest(ctx.db, { ...v, ip, verified: true });
      if ("error" in added) return reply(429, { ok: false, error: "Too many requests from here. Try again in an hour." });
      if (added.created) {
        ctx.log(`early access: request from ${v.email} (signed in)`);
        void notify(added.request);
      }
      return reply(200, { ok: true });
    }
    reply(404, { ok: false });
  }

  /** /admin and its actions. The gateway has checked the sign-in and passes the email along. */
  async function adminRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const secret = env.HUB_GATEWAY_SECRET ?? "";
    const email = String(req.headers["x-kindahired-email"] ?? "");
    if (!secret || !sameSecret(String(req.headers["x-kindahired-gateway"] ?? ""), secret) || !isAdmin(email)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("Not for you.");
    }
    const m = url.pathname.match(/^\/admin\/requests\/(\d+)\/(approve|decline)$/);
    if (m && req.method === "POST") {
      // A change must come from the admin page itself.
      const from = String(req.headers.origin ?? req.headers.referer ?? "");
      let ok = false;
      try { ok = new URL(from).host === String(req.headers["x-forwarded-host"] ?? req.headers.host ?? ""); } catch { /* no origin */ }
      if (!ok) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return void res.end("That request came from another site."); }
      const flash = await decide(Number(m[1]), m[2] as "approve" | "decline");
      res.writeHead(303, { location: `/admin?flash=${encodeURIComponent(flash)}` });
      return void res.end();
    }
    if (url.pathname !== "/admin" || req.method !== "GET") { res.writeHead(404); return void res.end(); }
    const people = await Promise.all(loadPeople(ctx.dir).map(async (p): Promise<PersonRow> => ({ id: p.id, email: p.email, telegram: p.chatId !== null, app: await engineStatus(p) })));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(adminPage({ requests: listRequests(ctx.db), people, flash: url.searchParams.get("flash") ?? undefined }));
  }

  return { publicRoute, internalRoute, adminRoute, onCallback, decide };
}

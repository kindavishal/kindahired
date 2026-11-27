import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { PersonRow } from "./admin-page.ts";
import { initRequests } from "./early-access.ts";
import { earlyAccess } from "./early-access-routes.ts";
import { findByChatId, findByRelaySecret, hubDir, loadPeople, savePeople, type Person } from "./people.ts";
import { realDeps, type ProvisionDeps } from "./provision.ts";

/**
 * The Telegram router. It owns the one real bot token on the hub. Telegram sends every update to
 * its webhook, and each update goes into the queue of the person whose chat it came from. Each
 * engine talks to the router as if it were api.telegram.org, with its own relay secret as the
 * bot token: getUpdates reads that person's queue, and sends are forwarded to the real Bot API
 * with chat_id set to that person's chat, so an engine can only ever reach its own person.
 *
 * Routes:
 *   POST /telegram/webhook                  Telegram's webhook (checks the secret header)
 *   POST /relay/bot<relaySecret>/<method>   the Bot API stand-in, for engines on this machine
 *   POST /relay/bot<relaySecret>/jhLinkCode a one-time code and t.me link for linking a chat
 *   POST /early-access, /admin...           early access and the operator's page (early-access-routes.ts)
 */

export interface RouterOptions {
  /** 0 picks a free port. */
  port?: number;
  host?: string;
  hubDir?: string;
  /** The real bot token. */
  botToken: string;
  webhookSecret: string;
  /** The real Bot API, without the /bot<token> part. Tests point this at a fake. */
  telegramBase?: string;
  /** Skips the getMe call that otherwise finds the bot's username for link URLs. */
  botUsername?: string;
  log?: (msg: string) => void;
  /** What approving an early-access request does. Tests replace it. */
  deps?: ProvisionDeps;
  env?: NodeJS.ProcessEnv;
  engineStatus?: (p: Person) => Promise<PersonRow["app"]>;
}

export interface Router {
  port: number;
  server: http.Server;
  close: () => Promise<void>;
}

/** Methods an engine may call through the router. Anything that changes the bot itself is left out. */
const FORWARDED = new Set([
  "sendMessage", "editMessageText", "editMessageReplyMarkup", "answerCallbackQuery", "sendDocument",
  "deleteMessage", "sendChatAction",
]);
const MAX_POLL_S = 50;
const LINK_CODE_MS = 30 * 60_000;
const KEEP_DELIVERED_MS = 24 * 3_600_000;
const MAX_BODY = 55 * 1024 * 1024; // Telegram's own upload limit is 50 MB

type Update = {
  update_id?: number;
  message?: { text?: string; chat?: { id: number } };
  callback_query?: { id?: string; data?: string; message?: { chat?: { id: number } } };
};
type Params = Record<string, unknown>;

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

function openQueue(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS updates (
  person TEXT NOT NULL, update_id INTEGER NOT NULL, body TEXT NOT NULL,
  created_at INTEGER NOT NULL, delivered_at INTEGER,
  PRIMARY KEY (person, update_id)
);
CREATE TABLE IF NOT EXISTS counters (person TEXT PRIMARY KEY, next INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS link_codes (code TEXT PRIMARY KEY, person TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS callbacks (id TEXT PRIMARY KEY, person TEXT NOT NULL, created_at INTEGER NOT NULL);
`);
  initRequests(db);
  return db;
}

export async function startRouter(o: RouterOptions): Promise<Router> {
  const dir = o.hubDir ?? hubDir();
  mkdirSync(dir, { recursive: true });
  const base = (o.telegramBase ?? "https://api.telegram.org").replace(/\/+$/, "");
  const log = o.log ?? ((msg: string) => console.log(`${new Date().toISOString()} ${msg}`));
  const db = openQueue(path.join(dir, "router.db"));
  const waiters = new Map<string, Set<() => void>>();
  let username = o.botUsername;

  const telegram = (method: string, init: RequestInit) => fetch(`${base}/bot${o.botToken}/${method}`, init);
  const telegramJson = (method: string, body: Params) =>
    telegram(method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const ea = earlyAccess({ db, dir, log, telegramJson, deps: o.deps ?? realDeps(), env: o.env, engineStatus: o.engineStatus });

  const wake = (person: string) => {
    const set = waiters.get(person);
    if (!set) return;
    waiters.delete(person);
    for (const fn of set) fn();
  };

  function enqueue(person: Person, update: Update) {
    const { next } = db.prepare(
      "INSERT INTO counters (person, next) VALUES (?, 1) ON CONFLICT(person) DO UPDATE SET next = next + 1 RETURNING next",
    ).get(person.id) as { next: number };
    db.prepare("INSERT INTO updates (person, update_id, body, created_at) VALUES (?, ?, ?, ?)")
      .run(person.id, next, JSON.stringify({ ...update, update_id: next }), Date.now());
    if (update.callback_query?.id) {
      db.prepare("INSERT OR REPLACE INTO callbacks (id, person, created_at) VALUES (?, ?, ?)").run(update.callback_query.id, person.id, Date.now());
    }
    wake(person.id);
  }

  async function onUpdate(u: Update) {
    // An operator's Approve / Decline tap is handled here, not passed to their engine.
    if (await ea.onCallback(u)) return;
    const chat = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
    if (chat === undefined) { log(`dropped update ${u.update_id} with no chat`); return; }
    const owner = findByChatId(chat, dir);
    if (owner) { enqueue(owner, u); return; }
    const code = u.message?.text?.match(/^\/start(?:@\w+)?\s+([\w-]+)/)?.[1];
    const claimed = code
      ? (db.prepare("DELETE FROM link_codes WHERE code = ? AND expires_at > ? RETURNING person").get(code, Date.now()) as { person: string } | undefined)
      : undefined;
    const people = claimed ? loadPeople(dir) : [];
    const person = people.find((p) => p.id === claimed?.person);
    if (!person) { log(`dropped update ${u.update_id} from unknown chat ${chat}`); return; }
    person.chatId = chat;
    savePeople(people, dir);
    log(`linked ${person.id} to chat ${chat}`);
    enqueue(person, u);
    await telegramJson("sendMessage", { chat_id: chat, text: "Linked." }).catch((err) => log(`"Linked." reply failed: ${err}`));
  }

  async function getUpdates(person: Person, p: Params, res: http.ServerResponse) {
    let offset = Number(p.offset ?? 0) || 0;
    // An engine that used to poll Telegram directly remembers Telegram's update ids, which are far
    // above the router's own. An offset past anything issued here can't be a confirmation, so it is
    // ignored rather than allowed to discard queued updates.
    const last = (db.prepare("SELECT next FROM counters WHERE person = ?").get(person.id) as { next: number } | undefined)?.next ?? 0;
    if (offset > last + 1) offset = 0;
    const limit = clamp(Number(p.limit ?? 100) || 100, 1, 100);
    const timeout = clamp(Number(p.timeout ?? 0) || 0, 0, MAX_POLL_S);
    // Bot API semantics: asking from an offset confirms everything before it.
    if (offset > 0) db.prepare("DELETE FROM updates WHERE person = ? AND update_id < ?").run(person.id, offset);
    const read = () => db.prepare("SELECT update_id, body FROM updates WHERE person = ? AND update_id >= ? ORDER BY update_id LIMIT ?")
      .all(person.id, offset, limit) as { update_id: number; body: string }[];
    let rows = read();
    if (!rows.length && timeout > 0) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); waiters.get(person.id)?.delete(done); resolve(); };
        const timer = setTimeout(done, timeout * 1000);
        if (!waiters.has(person.id)) waiters.set(person.id, new Set());
        waiters.get(person.id)!.add(done);
        res.on("close", done);
      });
      if (res.destroyed) return null;
      rows = read();
    }
    if (rows.length) {
      db.prepare(`UPDATE updates SET delivered_at = coalesce(delivered_at, ?) WHERE person = ? AND update_id IN (${rows.map(() => "?").join(",")})`)
        .run(Date.now(), person.id, ...rows.map((r) => r.update_id));
    }
    return rows.map((r) => JSON.parse(r.body) as unknown);
  }

  async function linkCode(person: Person) {
    if (!username) {
      const me = (await (await telegramJson("getMe", {})).json()) as { ok: boolean; result?: { username?: string } };
      username = me.result?.username;
      if (!username) throw new Error("getMe returned no username");
    }
    const code = randomBytes(12).toString("base64url");
    db.prepare("INSERT INTO link_codes (code, person, expires_at) VALUES (?, ?, ?)").run(code, person.id, Date.now() + LINK_CODE_MS);
    return { code, url: `https://t.me/${username}?start=${code}` };
  }

  async function relay(req: http.IncomingMessage, res: http.ServerResponse, url: URL, secret: string, method: string) {
    const out = (code: number, data: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const fail = (code: number, description: string) => out(code, { ok: false, error_code: code, description });
    // The gateway never sends /relay here; a forwarded request means it came from outside this machine.
    if (req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"]) return fail(403, "Forbidden");
    const person = findByRelaySecret(secret, dir);
    if (!person) return fail(401, "Unauthorized");

    const raw = await readBody(req);
    const type = String(req.headers["content-type"] ?? "");
    const form = /^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(type)
      ? await new Request("http://relay/", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(raw) }).formData()
      : null;
    const params: Params = Object.fromEntries(url.searchParams);
    if (form) { for (const [k, v] of form) if (typeof v === "string") params[k] = v; }
    else if (raw.length) {
      try { Object.assign(params, JSON.parse(raw.toString("utf8"))); } catch { return fail(400, "Bad Request: can't parse JSON"); }
    }

    if (method === "getUpdates") {
      const result = await getUpdates(person, params, res);
      return result && out(200, { ok: true, result });
    }
    if (method === "jhLinkCode") {
      try { return out(200, { ok: true, result: await linkCode(person) }); }
      catch (err) { log(`jhLinkCode failed: ${err}`); return fail(502, "Telegram is unreachable"); }
    }
    if (person.chatId === null) return fail(400, "Telegram not linked");
    if (!FORWARDED.has(method)) return fail(400, `Method ${method} isn't available through the hub`);

    let init: RequestInit;
    if (method === "answerCallbackQuery") {
      const id = String(params.callback_query_id ?? "");
      const row = db.prepare("SELECT person FROM callbacks WHERE id = ?").get(id) as { person: string } | undefined;
      if (row?.person !== person.id) return fail(400, "Bad Request: query not found");
      init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) };
    } else if (form) {
      form.set("chat_id", String(person.chatId));
      init = { method: "POST", body: form };
    } else {
      init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...params, chat_id: person.chatId }) };
    }
    let up: Response;
    try { up = await telegram(method, init); }
    catch (err) { log(`${person.id} ${method} failed: ${err}`); return fail(502, "Telegram is unreachable"); }
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await up.arrayBuffer()));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://router");
    try {
      if (url.pathname === "/telegram/webhook") {
        if (req.method !== "POST") { res.writeHead(405); return res.end(); }
        const got = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
        if (!o.webhookSecret || !sameSecret(got, o.webhookSecret)) { res.writeHead(401); return res.end("unauthorized"); }
        let update: Update;
        try { update = JSON.parse((await readBody(req)).toString("utf8")) as Update; }
        catch { res.writeHead(400); return res.end("bad update"); }
        await onUpdate(update);
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("ok");
      }
      const m = url.pathname.match(/^\/relay\/bot([^/]+)\/(\w+)$/);
      if (m) return await relay(req, res, url, decodeURIComponent(m[1]), m[2]);
      if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
      if (url.pathname === "/early-access") return await ea.publicRoute(req, res);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await ea.adminRoute(req, res, url);
      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      log(`router error on ${url.pathname.replace(/bot[^/]+/, "bot…")}: ${err}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error_code: 500, description: "Router error" }));
    }
  });

  const sweep = () => {
    const now = Date.now();
    db.prepare("DELETE FROM updates WHERE delivered_at IS NOT NULL AND delivered_at < ?").run(now - KEEP_DELIVERED_MS);
    db.prepare("DELETE FROM callbacks WHERE created_at < ?").run(now - KEEP_DELIVERED_MS);
    db.prepare("DELETE FROM link_codes WHERE expires_at < ?").run(now);
  };
  sweep();
  const sweeper = setInterval(sweep, 3_600_000);
  sweeper.unref();

  await new Promise<void>((resolve) => server.listen(o.port ?? 8090, o.host ?? "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    server,
    close: async () => {
      clearInterval(sweeper);
      for (const person of [...waiters.keys()]) wake(person);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

/**
 * Loads `<JH_HUB_DIR>/.env` and `<JH_HUB_DIR>/hub.env` when they exist, without overriding variables
 * already set. hub.env holds the early-access settings (ADMIN_EMAILS, Cloudflare, SMTP) and the
 * gateway secret the admin page checks.
 */
export function loadHubEnv() {
  for (const name of [".env", "hub.env"]) {
    const file = path.join(hubDir(), name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadHubEnv();
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!botToken || !webhookSecret) {
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (in the environment or <JH_HUB_DIR>/.env).");
    process.exit(1);
  }
  const r = await startRouter({
    port: Number(process.env.ROUTER_PORT ?? 8090),
    botToken,
    webhookSecret,
    telegramBase: process.env.TELEGRAM_UPSTREAM_API,
    botUsername: process.env.TELEGRAM_BOT_USERNAME,
  });
  console.log(`Telegram router on 127.0.0.1:${r.port}, hub folder ${hubDir()}`);
}

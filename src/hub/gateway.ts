import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GATEWAY_HEADER } from "./gateway-secret.ts";
import { codeMail, smtpSender, type SendMail } from "./mail.ts";
import { loadHubEnv } from "./router.ts";
import { codePage, emailPage, notInYetPage, problemPage, type RequestStatus } from "./signin-pages.ts";
import { clearedCookie, openSigninStore, safeNext, sessionCookie, sessionToken, validEmail, type SigninStore } from "./signin.ts";

/** The signed-in email, passed to the router for /admin. Never taken from the client. */
const EMAIL_HEADER = "x-kindahired-email";
import { hubDir, loadPeople, pick, type Person } from "./people.ts";

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;

export interface GatewayOptions {
  /** Cloudflare Access, still accepted while it's switched off: its token counts as signed in. */
  teamDomain?: string;
  aud?: string;
  routerUrl?: string;
  /** Sent to the engines as X-Kindahired-Gateway. Defaults to HUB_GATEWAY_SECRET; required. */
  gatewaySecret?: string;
  /** Override the certs URL (tests). */
  certsUrl?: string;
  /** Override how people are loaded (tests). Defaults to people.json in JH_HUB_DIR. */
  loadPeople?: () => Person[];
  now?: () => number;
  /** Codes and sessions. Defaults to <JH_HUB_DIR>/gateway.db. */
  signin?: SigninStore;
  /** How sign-in codes are emailed. Defaults to SMTP from hub.env. */
  sendMail?: SendMail;
}

interface Jwk { kid?: string; kty: string; [k: string]: unknown }

const b64 = (s: string) => Buffer.from(s, "base64url");

class JwtError extends Error {}

export function createGateway(opts: GatewayOptions): http.Server {
  const routerUrl = new URL(opts.routerUrl ?? "http://127.0.0.1:8090");
  const certsUrl = opts.certsUrl ?? `https://${opts.teamDomain}/cdn-cgi/access/certs`;
  const cloudflare = Boolean(opts.teamDomain && opts.aud);
  const people = opts.loadPeople ?? (() => loadPeople());
  const now = opts.now ?? Date.now;
  const secret = opts.gatewaySecret ?? process.env.HUB_GATEWAY_SECRET ?? "";
  if (!secret) throw new Error("HUB_GATEWAY_SECRET is not set");
  const store = opts.signin ?? openSigninStore(path.join(hubDir(), "gateway.db"), secret, now);
  const sendMail = opts.sendMail ?? smtpSender();
  const router = { host: routerUrl.hostname, port: Number(routerUrl.port || 80) };

  let keys: Jwk[] = [];
  let fetchedAt = 0;

  async function refreshKeys(): Promise<void> {
    const res = await fetch(certsUrl);
    if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    keys = body.keys ?? [];
    fetchedAt = now();
  }

  async function keyFor(kid: string | undefined): Promise<Jwk | undefined> {
    if (!keys.length || now() - fetchedAt > JWKS_TTL_MS) await refreshKeys();
    let key = keys.find((k) => k.kid === kid);
    // A rotated key: look again, but not more than once a minute.
    if (!key && now() - fetchedAt > JWKS_MIN_REFETCH_MS) {
      await refreshKeys();
      key = keys.find((k) => k.kid === kid);
    }
    return key;
  }

  /** Returns the email claim of a valid Access token. Throws JwtError otherwise. */
  async function verifyJwt(token: string): Promise<string> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new JwtError("malformed token");
    let header: { alg?: string; kid?: string };
    let claims: { exp?: number; nbf?: number; aud?: string | string[]; email?: string; iss?: string };
    try {
      header = JSON.parse(b64(parts[0]).toString("utf8"));
      claims = JSON.parse(b64(parts[1]).toString("utf8"));
    } catch {
      throw new JwtError("malformed token");
    }
    if (header.alg !== "RS256") throw new JwtError("unsupported alg");
    const jwk = await keyFor(header.kid);
    if (!jwk) throw new JwtError("unknown key");
    const publicKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKeyInput["key"] & object, format: "jwk" });
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, b64(parts[2]));
    if (!ok) throw new JwtError("bad signature");
    const nowSec = Math.floor(now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSec) throw new JwtError("expired");
    if (typeof claims.nbf === "number" && claims.nbf > nowSec) throw new JwtError("not yet valid");
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(opts.aud)) throw new JwtError("wrong audience");
    if (claims.iss && claims.iss !== `https://${opts.teamDomain}`) throw new JwtError("wrong issuer");
    if (typeof claims.email !== "string" || !claims.email) throw new JwtError("no email");
    return claims.email;
  }

  const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

  /** Passes the request on. `engine` adds the gateway secret; a client's own copy is always dropped. */
  function proxy(req: http.IncomingMessage, res: http.ServerResponse, target: { host: string; port: number; engine?: boolean; email?: string }): void {
    const headers: http.OutgoingHttpHeaders = {};
    if (target.engine) headers[GATEWAY_HEADER] = secret;
    for (const [name, value] of Object.entries(req.headers)) {
      const n = name.toLowerCase();
      if (HOP.has(n) || n === GATEWAY_HEADER || n === EMAIL_HEADER || n.startsWith("cf-access-") || n.startsWith("x-forwarded-") || n === "forwarded" || n === "x-real-ip") continue;
      headers[n] = value;
    }
    const clientIp = (req.headers["cf-connecting-ip"] as string | undefined) ?? req.socket.remoteAddress ?? "";
    headers["x-forwarded-for"] = clientIp;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-host"] = req.headers.host ?? "";
    if (target.email) headers[EMAIL_HEADER] = target.email;
    const upstream = http.request(
      { host: target.host, port: target.port, method: req.method, path: req.url, headers },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(up.headers)) if (!HOP.has(name.toLowerCase())) out[name] = value;
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) text(res, 502, "The dashboard is not running right now. Try again in a moment.");
      else res.destroy();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  const clientIp = (req: http.IncomingMessage) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "");

  /** A form post from one of our own pages: Origin (or Referer) on this host. */
  function sameOrigin(req: http.IncomingMessage): boolean {
    const from = req.headers.origin ?? req.headers.referer;
    if (!from || from === "null") return false;
    try { return new URL(from).host === req.headers.host; } catch { return false; }
  }

  async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 8192) break;
      chunks.push(c as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  /** The signed-in email: our session first, then a Cloudflare Access token. "" when signed out; undefined once it has answered. */
  async function signedInEmail(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | undefined> {
    const fromSession = store.sessionEmail(sessionToken(req.headers.cookie));
    if (fromSession) return fromSession;
    const token = req.headers["cf-access-jwt-assertion"];
    if (!cloudflare || typeof token !== "string" || !token) return "";
    try {
      return await verifyJwt(token);
    } catch (e) {
      if (e instanceof JwtError) { text(res, 403, "Sign-in could not be verified."); return undefined; }
      console.error("gateway: key fetch failed:", e);
      text(res, 503, "Sign-in check is unavailable. Try again shortly.");
      return undefined;
    }
  }

  async function signinRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET" && url.pathname === "/signin") {
      const next = safeNext(url.searchParams.get("next"));
      if (store.sessionEmail(sessionToken(req.headers.cookie))) return redirect(res, next);
      return html(res, 200, emailPage({ next }));
    }
    if (req.method !== "POST") return redirect(res, "/signin");
    if (!sameOrigin(req)) return html(res, 403, problemPage("Something went wrong", "That request came from another site. Open the sign-in page and try again."));
    const form = await readForm(req);
    const next = safeNext(form.get("next"));

    if (url.pathname === "/signout") {
      store.endSession(sessionToken(req.headers.cookie));
      res.writeHead(303, { location: "/signin", "set-cookie": clearedCookie() });
      return void res.end();
    }

    const email = validEmail(form.get("email"));
    if (!email) return html(res, 400, emailPage({ next, email: String(form.get("email") ?? ""), error: "Enter your email address." }));

    if (url.pathname === "/signin") {
      const made = store.newCode(email, clientIp(req));
      if ("error" in made) {
        return html(res, 429, made.error === "email-limit"
          ? codePage({ email, next, error: "That's a lot of codes. Use the last one we sent, or try again in an hour." })
          : emailPage({ next, email, error: "Too many sign-in attempts from here. Try again in an hour." }));
      }
      try {
        await sendMail(codeMail(email, made.code));
      } catch (err) {
        console.error("gateway: couldn't send a sign-in code:", err instanceof Error ? err.message : err);
        return html(res, 503, emailPage({ next, email, error: "We couldn't send the code just now. Try again in a minute." }));
      }
      return html(res, 200, codePage({ email, next }));
    }

    // /signin/code
    const result = store.checkCode(email, String(form.get("code") ?? ""));
    if (result.ok) {
      res.writeHead(303, { location: next, "set-cookie": sessionCookie(store.newSession(email)) });
      return void res.end();
    }
    const error = result.reason === "wrong"
      ? `That code isn't right. ${result.left} ${result.left === 1 ? "try" : "tries"} left.`
      : result.reason === "too-many" ? "Too many wrong codes. Send a new one." : "That code has expired. Send a new one.";
    return html(res, 400, codePage({ email, next, error }));
  }

  /** Asks the router where this email's early-access request stands. */
  async function requestStatus(email: string): Promise<RequestStatus> {
    try {
      const r = await fetch(`http://${router.host}:${router.port}/early-access/status`, { headers: { [GATEWAY_HEADER]: secret, [EMAIL_HEADER]: email }, signal: AbortSignal.timeout(3000) });
      const body = (await r.json()) as { status?: RequestStatus };
      return body.status ?? "none";
    } catch {
      return "none";
    }
  }

  async function requestAccess(req: http.IncomingMessage, res: http.ServerResponse, email: string): Promise<void> {
    if (!sameOrigin(req)) return html(res, 403, problemPage("Something went wrong", "That request came from another site. Try again from kindahired."));
    const linkedin = String((await readForm(req)).get("linkedin") ?? "");
    let error = "";
    try {
      const r = await fetch(`http://${router.host}:${router.port}/early-access/verified`, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { [GATEWAY_HEADER]: secret, [EMAIL_HEADER]: email, "content-type": "application/json", "x-forwarded-for": clientIp(req) },
        body: JSON.stringify({ linkedin }),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!body.ok) error = body.error ?? "Something went wrong. Try again in a minute.";
    } catch {
      error = "Something went wrong. Try again in a minute.";
    }
    if (error) return html(res, 400, notInYetPage({ email, status: "none", error, linkedin }));
    redirect(res, "/");
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    try {
      if (url.pathname === "/healthz") return text(res, 200, "ok");

      // The landing page's early-access form.
      if (url.pathname === "/early-access") {
        return proxy(req, res, router);
      }

      if (url.pathname === "/telegram/webhook") {
        return proxy(req, res, router);
      }

      if (url.pathname === "/worker" || url.pathname.startsWith("/worker/")) {
        const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
        const person = m ? pick.workerToken(people(), m[1]) : undefined;
        if (!person) return text(res, 401, "Unauthorized");
        return proxy(req, res, { host: "127.0.0.1", port: person.port, engine: true });
      }

      // ---------- Sign in ----------
      if (url.pathname === "/signin" || url.pathname === "/signin/code" || url.pathname === "/signout") return await signinRoute(req, res, url);

      const email = await signedInEmail(req, res);
      if (email === undefined) return; // answered already (a bad Cloudflare token)
      if (!email) {
        if (req.method === "GET" || req.method === "HEAD") return redirect(res, `/signin?next=${encodeURIComponent(safeNext(url.pathname + url.search))}`);
        return text(res, 401, "Sign in first.");
      }
      // The operator's page, served by the router. It checks the email against ADMIN_EMAILS itself.
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        return proxy(req, res, { ...router, engine: true, email });
      }
      const person = pick.email(people(), email);
      if (person) return proxy(req, res, { host: "127.0.0.1", port: person.port, engine: true });
      // Signed in, email proven, but no dashboard: early access.
      if (url.pathname === "/request-access" && req.method === "POST") return await requestAccess(req, res, email);
      if (req.method !== "GET" && req.method !== "HEAD") return redirect(res, "/");
      return html(res, 200, notInYetPage({ email, status: await requestStatus(email) }));
    } catch (e) {
      console.error("gateway error:", e);
      if (!res.headersSent) text(res, 500, "Something went wrong.");
    }
  });
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "same-origin" });
  res.end(body);
}

function redirect(res: http.ServerResponse, to: string): void {
  res.writeHead(303, { location: to, "cache-control": "no-store" });
  res.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // hub.env has the SMTP settings for sign-in codes.
  loadHubEnv();
  if (!process.env.HUB_GATEWAY_SECRET) {
    console.error("Set HUB_GATEWAY_SECRET in gateway.env, the same value as in hub.env (generate one with: openssl rand -hex 32).");
    process.exit(1);
  }
  const port = Number(process.env.GATEWAY_PORT ?? 8080);
  createGateway({ teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN, aud: process.env.CF_ACCESS_AUD, routerUrl: process.env.ROUTER_URL }).listen(port, "127.0.0.1", () =>
    console.log(`gateway listening on 127.0.0.1:${port}`));
}

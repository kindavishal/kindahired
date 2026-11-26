import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { findByEmail, findByWorkerToken, loadPeople, type Person } from "./registry.ts";

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;

export interface GatewayOptions {
  teamDomain: string;
  aud: string;
  routerUrl?: string;
  /** Override the certs URL (tests). */
  certsUrl?: string;
  /** Override how people are loaded (tests). Defaults to people.json in JH_HUB_DIR. */
  loadPeople?: () => Person[];
  now?: () => number;
}

interface Jwk { kid?: string; kty: string; [k: string]: unknown }

const b64 = (s: string) => Buffer.from(s, "base64url");

class JwtError extends Error {}

export function createGateway(opts: GatewayOptions): http.Server {
  const routerUrl = new URL(opts.routerUrl ?? "http://127.0.0.1:8090");
  const certsUrl = opts.certsUrl ?? `https://${opts.teamDomain}/cdn-cgi/access/certs`;
  const people = opts.loadPeople ?? (() => loadPeople());
  const now = opts.now ?? Date.now;

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

  function proxy(req: http.IncomingMessage, res: http.ServerResponse, target: { host: string; port: number }): void {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const n = name.toLowerCase();
      if (HOP.has(n) || n.startsWith("cf-access-") || n.startsWith("x-forwarded-") || n === "forwarded" || n === "x-real-ip") continue;
      headers[n] = value;
    }
    const clientIp = (req.headers["cf-connecting-ip"] as string | undefined) ?? req.socket.remoteAddress ?? "";
    headers["x-forwarded-for"] = clientIp;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-host"] = req.headers.host ?? "";
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

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    try {
      if (url.pathname === "/healthz") return text(res, 200, "ok");

      if (url.pathname === "/telegram/webhook") {
        return proxy(req, res, { host: routerUrl.hostname, port: Number(routerUrl.port || 80) });
      }

      if (url.pathname === "/worker" || url.pathname.startsWith("/worker/")) {
        const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
        const person = m ? findByWorkerToken(people(), m[1]) : undefined;
        if (!person) return text(res, 401, "Unauthorized");
        return proxy(req, res, { host: "127.0.0.1", port: person.port });
      }

      const token = req.headers["cf-access-jwt-assertion"];
      if (typeof token !== "string" || !token) return text(res, 401, "Sign-in required.");
      let email: string;
      try {
        email = await verifyJwt(token);
      } catch (e) {
        if (e instanceof JwtError) return text(res, 403, "Sign-in could not be verified.");
        console.error("gateway: key fetch failed:", e);
        return text(res, 503, "Sign-in check is unavailable. Try again shortly.");
      }
      const person = findByEmail(people(), email);
      if (!person) return forbiddenPage(res, email);
      proxy(req, res, { host: "127.0.0.1", port: person.port });
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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function forbiddenPage(res: http.ServerResponse, email: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>No dashboard yet</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>No dashboard yet</h1><p>You're signed in as ${esc(email)} but don't have a dashboard here yet.</p></body>`;
  res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const aud = process.env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) {
    console.error("Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.");
    process.exit(1);
  }
  const port = Number(process.env.GATEWAY_PORT ?? 8080);
  createGateway({ teamDomain, aud, routerUrl: process.env.ROUTER_URL }).listen(port, "127.0.0.1", () =>
    console.log(`gateway listening on 127.0.0.1:${port}`));
}

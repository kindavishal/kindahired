import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * The secret the gateway and the engines share on the hub. Engines listen on 127.0.0.1 with no
 * sign-in of their own, so in hub mode they answer only requests that carry this header, which the
 * gateway sets on every request it proxies (after removing any copy a client sent).
 */

export const GATEWAY_HEADER = "x-kindahired-gateway";

export const gatewaySecret = (): string => process.env.HUB_GATEWAY_SECRET ?? "";

/** True when the request carries the gateway header with the configured secret. */
export function fromGateway(req: IncomingMessage, secret = gatewaySecret()): boolean {
  const got = req.headers[GATEWAY_HEADER];
  if (!secret || typeof got !== "string" || !got) return false;
  // Hashing first makes both sides the same length, so the comparison takes the same time.
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(got), hash(secret));
}

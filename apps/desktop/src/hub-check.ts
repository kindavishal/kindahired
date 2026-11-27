/**
 * The "Check" button on the setup window: is the hub reachable, and does it accept this token?
 */

export interface HubCheck {
  hub: { ok: boolean; message: string };
  token: { ok: boolean; message: string } | null;
}

type Fetch = typeof fetch;

export async function checkHub(hubUrl: string, token: string, fetchImpl: Fetch = fetch, timeoutMs = 10_000): Promise<HubCheck> {
  const base = new URL(hubUrl);
  const reason = (err: unknown) => {
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    if (e?.name === "TimeoutError") return "it didn't answer within 10 seconds";
    return e?.cause?.code ?? e?.message ?? String(err);
  };

  try {
    const res = await fetchImpl(new URL("healthz", base), { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    if (!res.ok) {
      // Anything but 200 here usually means Cloudflare Access is asking for a login: /healthz
      // should be reachable without one.
      const access = res.status >= 300 && res.status < 400;
      return {
        hub: { ok: false, message: access ? "The hub asked for a login on /healthz. Check the address, or ask the hub's owner." : `The hub answered ${res.status}. Check the address.` },
        token: null,
      };
    }
  } catch (err) {
    return { hub: { ok: false, message: `Couldn't reach the hub: ${reason(err)}.` }, token: null };
  }

  const hub = { ok: true, message: "The hub is reachable." };
  if (!token) return { hub, token: { ok: false, message: "Enter your worker token." } };

  // GET /worker/status needs the same token as a claim. A claim with waitMs=0 would also check it,
  // but would take a waiting job off the queue that nothing here then runs (the hub only puts it
  // back after the job's timeout), so the check reads the status instead.
  try {
    const res = await fetchImpl(new URL("worker/status", base), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (res.status === 401) return { hub, token: { ok: false, message: "The hub didn't accept this token. Copy it again from your dashboard." } };
    if (!res.ok) return { hub, token: { ok: false, message: `The hub answered ${res.status} to the token check.` } };
    const body = (await res.json().catch(() => null)) as { queued?: unknown } | null;
    if (!body || typeof body.queued !== "number") return { hub, token: { ok: false, message: "The hub's answer didn't look like a worker endpoint." } };
    const waiting = body.queued ? ` ${body.queued} Claude ${body.queued === 1 ? "step is" : "steps are"} waiting for this computer.` : "";
    return { hub, token: { ok: true, message: `The token works.${waiting}` } };
  } catch (err) {
    return { hub, token: { ok: false, message: `Couldn't check the token: ${reason(err)}.` } };
  }
}

import { appendFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from "./config.ts";
import { logEvent, run } from "./db/index.ts";
import { addCompanies, addLink, calendarTick, companiesAutoTick, companiesTick, hiringTick, researchNow, scanCompanyNow, digestTick, gmailTick, kick, linkedinMessagesTick, linkedinTick, pingTick, postingsTick, readXLink, runPacks, runSummaries, scanNow, sheetTick, sourcesTick, watchPage, xTick } from "./jobs.ts";
import { handleIncoming } from "./notify/messages.ts";
import { poll, telegramReady } from "./notify/telegram.ts";
import { startServer } from "./web/server.ts";

/**
 * The always-on process. Every few minutes it checks Gmail, builds any queued packs and sends
 * them, and pings me about replies I owe. LinkedIn is read a few times a day, and watched pages
 * (job boards, careers pages) on their own timers. Telegram buttons
 * are handled as they come in.
 */

const MIN = 60_000;
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(path.join(PATHS.logs, "daemon.log"), line + "\n");
};

function every(name: string, ms: number, fn: () => Promise<unknown>, opts: { jitter?: number; startAfter?: number } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await fn();
      if (result) log(`${name}: ${JSON.stringify(result)}`);
    } catch (err) {
      log(`${name} failed: ${err instanceof Error ? err.stack : err}`);
      logEvent("daemon.error", name, String(err));
    } finally {
      running = false;
      setTimeout(tick, ms + Math.random() * (opts.jitter ?? 0));
    }
  };
  setTimeout(tick, opts.startAfter ?? 0);
}

async function telegramLoop() {
  for (;;) {
    try {
      for (const msg of await poll()) {
        await handleIncoming(msg, { addLink, kick, watchPage, scanNow, readXLink, addCompanies, scanCompany: scanCompanyNow }).catch((err) => log(`telegram handler failed: ${err}`));
      }
    } catch (err) {
      log(`telegram poll failed: ${err}`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

log("daemon starting");
// A pack that was mid-build when the daemon last stopped goes back in the queue.
const stuck = Number(run("UPDATE opportunities SET pack_status = 'approved' WHERE pack_status = 'building'").changes)
  + Number(run("UPDATE opportunities SET pack_status = 'queued' WHERE pack_status = 'summarizing'").changes);
if (stuck) log(`re-queued ${stuck} pack(s) interrupted by the last stop`);
run("UPDATE opportunities SET pack_status = 'queued' WHERE pack_status = 'held'");
startServer(undefined, { addLink, watchPage, scanNow, addCompanies, scanCompany: scanCompanyNow, research: researchNow });
every("gmail", 10 * MIN, gmailTick, { startAfter: 5_000 });
every("calendar", 30 * MIN, calendarTick, { startAfter: 45_000 });
every("summaries", 1 * MIN, () => runSummaries().then((n) => (n ? { summaries: n } : null)), { startAfter: 20_000 });
every("packs", 1 * MIN, () => runPacks().then((n) => (n ? { packs: n } : null)), { startAfter: 30_000 });
every("pings", 15 * MIN, pingTick, { startAfter: 30_000 });
// Who's hiring, for roles about to be applied to or applied to (uses the Claude plan, so slowly).
every("hiring", 30 * MIN, hiringTick, { startAfter: 5 * MIN });
every("sheet", 10 * MIN, async () => {
  const r = await sheetTick();
  return r && ("skipped" in r || r.roles.added || r.roles.updated || r.outreach.added || r.outreach.updated) ? r : null;
}, { startAfter: 90_000 });
every("digest", 5 * MIN, () => digestTick().then((sent) => (sent ? { digest: "sent" } : null)));
// Watched pages: each has its own interval; this just checks which are due.
every("sources", 10 * MIN, sourcesTick, { startAfter: 60_000 });
// Target companies' job boards: each on its own timer (3 hours unless changed).
every("companies", 10 * MIN, companiesTick, { startAfter: 75_000 });
// Companies from the roles I track are added as targets as they come in.
every("companies-auto", 6 * 60 * MIN, companiesAutoTick, { startAfter: 3 * MIN });
// Postings close after they're read: each role's links are re-checked about once a day.
every("postings", 60 * MIN, () => postingsTick({ limit: 15 }), { jitter: 10 * MIN, startAfter: 4 * MIN });
every("x", 4 * 60 * MIN, xTick, { jitter: 20 * MIN, startAfter: 3 * MIN });
// LinkedIn messages more often than jobs: a reply to a DM shouldn't wait six hours.
every("linkedin-messages", 90 * MIN, linkedinMessagesTick, { jitter: 20 * MIN, startAfter: 6 * MIN });
every("linkedin", 6 * 60 * MIN, linkedinTick, { jitter: 45 * MIN, startAfter: 2 * MIN });
if (telegramReady()) void telegramLoop();
else log("Telegram not linked yet; skipping bot. Run: npm run jh -- telegram:link");

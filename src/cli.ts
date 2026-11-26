import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { env, PATHS, ROOT } from "./config.ts";
import { all, get, kvGet } from "./db/index.ts";
import { findDuplicates, mergeOpportunities } from "./db/merge.ts";
import { AI_MODE, quickProvider } from "./llm/client.ts";
import { GEMINI_MODEL, geminiAvailable } from "./llm/providers.ts";
import { addCompanies, addLink, calendarTick, companiesAutoTick, companiesTick, researchNow, scanCompanyNow, gmailTick, linkedinMessagesTick, linkedinTick, postingsTick, runPackQueue, runSummaries, scanNow, watchPage } from "./jobs.ts";
import { addSource, describeResult, listSources, removeSource } from "./pipeline/sources.ts";
import { dueActions, reconcileActions } from "./loops/engine.ts";
import { digestText, sendDigest, sendPack } from "./notify/messages.ts";
import { linkChat, telegramReady } from "./notify/telegram.ts";
import { buildEvidence, crawlPortfolio } from "./pipeline/evidence.ts";
import { syncGmail } from "./pipeline/ingest.ts";
import { calendarReady } from "./pipeline/interviews.ts";
import { listCompanies } from "./pipeline/companies.ts";
import { reviewInFlight } from "./pipeline/review.ts";
import { buildPack } from "./pipeline/pack.ts";
import { interpretImported } from "./import/interpret.ts";
import { syncSheet } from "./import/mirror.ts";
import { fetchSheet, importSheetData, readSheetFiles } from "./import/sheet.ts";
import { connectGoogle, googleConnected } from "./sources/google-auth.ts";
import { linkedinLogin } from "./sources/linkedin.ts";
import { connectX, monthlyBudget, spentThisMonth, xConfigured, xUserConnected } from "./sources/x.ts";
import { creditsUsed, firecrawlAvailable, monthlyCredits } from "./sources/firecrawl.ts";
import { followAccount, readThreadLink, scanX, unfollowAccount, xStatus } from "./pipeline/x.ts";
import { startServer } from "./web/server.ts";

const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const commands: Record<string, [string, () => Promise<unknown>]> = {
  status: ["Show what's connected and what's waiting", async () => {
    const ok = (b: boolean) => (b ? "yes" : "no ");
    console.log(`AI mode           ${AI_MODE}`);
    console.log(`Quick steps       ${quickProvider()}`);
    console.log(`Gemini          ${ok(geminiAvailable())}  (${GEMINI_MODEL}; screening falls back to Claude Code without it)`);
    console.log(`Google (Gmail)    ${ok(googleConnected())}  last sync: ${kvGet("gmail.lastSync") ?? "never"}`);
    console.log(`Google Calendar   ${ok(calendarReady())}  ${calendarReady() ? "" : "(run auth:google to allow it)"}`);
    console.log(`LinkedIn messages ${ok(existsSync(PATHS.browserProfile))}  last read: ${kvGet("linkedin.inbox.lastSync") ?? "never"}`);
    console.log(`LinkedIn          ${ok(existsSync(PATHS.browserProfile))}  last sync: ${kvGet("linkedin.lastSync") ?? "never"}`);
    console.log(`Telegram          ${ok(telegramReady())}`);
    console.log(`Firecrawl search  ${ok(firecrawlAvailable())}  ${creditsUsed()} of ${monthlyCredits()} free credits used this month`);
    console.log(`X                 ${ok(xConfigured())}  bookmarks: ${xUserConnected() ? "yes" : "no"} · $${spentThisMonth().toFixed(2)} of $${monthlyBudget()} this month`);
    const ev = get<{ n: number; c: number }>("SELECT count(*) n, sum(conflict) c FROM evidence")!;
    console.log(`Evidence bank     ${ev.n} facts, ${ev.c ?? 0} to settle`);
    for (const r of all<{ status: string; n: number }>("SELECT status, count(*) n FROM opportunities GROUP BY status ORDER BY n DESC")) console.log(`  ${r.status.padEnd(14)} ${r.n}`);
    const q = get<{ n: number }>("SELECT count(*) n FROM opportunities WHERE pack_status = 'queued'")!.n;
    console.log(`Packs queued      ${q}`);
  }],
  "auth:google": ["Connect Gmail (read-only) and Sheets", connectGoogle],
  "linkedin:login": ["Log in to LinkedIn once in a browser window", linkedinLogin],
  "auth:x": ["Connect your X account (read-only: posts and bookmarks)", connectX],
  "x:scan": ["Check X now: bookmarks, watched threads and accounts, searches", async () => console.log(await scanX(new Date(), { force: true }))],
  "x:status": ["Show X spend, searches, watched accounts and threads", async () => {
    const st = xStatus();
    console.log(`Spent $${spentThisMonth().toFixed(2)} of $${monthlyBudget()} this month`);
    console.log("Searches:\n" + st.queries.map((q) => "  " + q).join("\n"));
    console.log("Accounts: " + (st.accounts.map((a) => "@" + a).join(", ") || "none"));
    console.log("Threads:\n" + (st.threads.map((t) => `  ${t.url} until ${t.watch_until.slice(0, 10)}`).join("\n") || "  none"));
  }],
  "x:follow": ["Watch X accounts' posts for roles: x:follow @handle [@handle...]", async () => {
    for (const h of args) console.log(`Watching @${followAccount(h)}`);
  }],
  "x:unfollow": ["Stop watching an X account: x:unfollow @handle", async () => { for (const h of args) unfollowAccount(h); }],
  "x:thread": ["Read an X post and its replies, and watch the thread: x:thread <url>", async () => console.log((await readThreadLink(args[0])).text)],
  "telegram:link": ["Link your Telegram chat to the bot", async () => console.log(`Linked chat ${await linkChat()}`)],
  import: ["Import the Google Sheet tracker (or --files roles.json outreach.json facts.json)", async () => {
    const data = flag("files")
      ? readSheetFiles({ roles: args[1], outreach: args[2], facts: args[3] })
      : await fetchSheet(env.trackerSheetId);
    const stats = importSheetData(data);
    console.log(stats);
    console.log(reconcileActions());
    if (!flag("no-ai")) console.log("Reading the notes column:", await interpretImported());
  }],
  dedupe: ["Merge roles tracked twice under different titles (--dry to preview)", async () => {
    const pairs = findDuplicates();
    for (const [keep, dup] of pairs) {
      console.log(`${dup.id} "${dup.role}" (${dup.company}, ${dup.status}) → ${keep.id} "${keep.role}" (${keep.company}, ${keep.status})`);
      if (!flag("dry")) mergeOpportunities(keep.id, dup.id);
    }
    console.log(`${pairs.length} duplicate${pairs.length === 1 ? "" : "s"}${flag("dry") ? " found" : " merged"}`);
    if (!flag("dry")) reconcileActions();
  }],
  "sheet:sync": ["Push new and changed roles and contacts to the Google Sheet (--dry to preview)", async () => {
    const r = await syncSheet({ dry: flag("dry") });
    if (r && "roles" in r) {
      for (const [tab, t] of [["Roles", r.roles], ["Outreach", r.outreach]] as const) {
        console.log(`${tab}: ${t.updated} cells to update, ${t.added} new rows`);
        for (const line of t.preview) console.log("  " + line);
      }
    } else console.log(r);
  }],
  "evidence:build": ["Read your portfolio site and build the evidence bank", async () => {
    console.log(`Crawled ${await crawlPortfolio()} pages`);
    console.log(await buildEvidence());
    for (const e of all<{ claim: string; note: string }>("SELECT claim, note FROM evidence WHERE conflict = 1")) console.log(`  settle: ${e.claim}\n          ${e.note}`);
  }],
  "sync:gmail": ["Pull job email (add --backfill for the last 90 days)", async () => console.log(flag("backfill") ? await syncGmail({ backfill: true }) : await gmailTick())],
  "sync:linkedin": ["Read saved and applied jobs on LinkedIn", async () => console.log(await linkedinTick())],
  companies: ["List target companies and their job boards", async () => {
    for (const c of listCompanies()) console.log(`${String(c.id).padStart(3)}  ${c.name.padEnd(28)} ${c.board_type ? `${c.board_type}/${c.board_slug}` : c.source_id ? "careers page" : "no board found"}  ${c.status}  last: ${c.last_scanned_at ?? "never"}${c.last_error ? `  ERROR ${c.last_error}` : ""}`);
  }],
  "companies:add": ["Watch target companies: companies:add \"Stripe\" \"Packt | https://apply.workable.com/packtpublishing\"", async () => {
    const r = await addCompanies(args.join("\n"), "cli");
    console.log(r.lines.join("\n"));
    await companiesTick();
  }],
  hiring: ["Research who's hiring for a role and print the brief: hiring <id>", async () => {
    const id = Number(args[0]);
    if (!id) throw new Error("Usage: hiring <id>");
    if (!(await researchNow(id))) throw new Error("The research didn't finish. See: npm run jh -- status, or the daemon log.");
    console.log(JSON.stringify(JSON.parse(get<{ hiring_brief: string }>("SELECT hiring_brief FROM opportunities WHERE id = $id", { id })!.hiring_brief), null, 2));
  }],
  "companies:auto": ["Add every company from your roles as a target company", async () => console.log(await companiesAutoTick() ?? "No new companies in your roles.")],
  "companies:scan": ["Check target companies' boards now: companies:scan [id...]", async () => {
    const ids = args.map(Number).filter(Boolean);
    if (!ids.length) return console.log(await companiesTick() ?? "Nothing due.");
    for (const id of ids) console.log(id, await scanCompanyNow(id));
  }],
  "sync:calendar": ["Read interviews from Google Calendar", async () => console.log(await calendarTick() ?? "No interview changes.")],
  "sync:linkedin-messages": ["Read LinkedIn messages and file the job conversations", async () => console.log(await linkedinMessagesTick() ?? "No new job conversations.")],
  review: ["Re-read the emails of every application in flight and correct its status: review [id...]", async () => {
    const changed = await reviewInFlight(args.map(Number).filter(Boolean));
    for (const c of changed) console.log(`${c.id}: ${c.from} → ${c.to}${c.reason ? ` (${c.reason})` : ""}`);
    console.log(`${changed.length} status${changed.length === 1 ? "" : "es"} corrected`);
  }],
  "postings:check": ["Re-check whether postings are still open (--all ignores the daily wait; ids to check just those)", async () => {
    const ids = args.map(Number).filter(Boolean);
    const r = await postingsTick({ ids, force: flag("all"), limit: flag("all") ? 500 : 50 });
    if (!r) return console.log("Nothing due for a check.");
    for (const c of r.closed) console.log(`${c.id}: ${c.role} at ${c.company} — closed${c.applied ? " (you applied; status left as is)" : ", skipped"}: ${c.reason}`);
    console.log(`${r.checked} checked, ${r.closed.length} closed`);
  }],
  add: ["Add a job link: add <url> [note]", async () => {
    if (!args[0]) throw new Error("Usage: add <url> [note]");
    console.log(await addLink(args[0], args.slice(1).join(" ") || undefined));
    await runPackQueue(1);
  }],
  pack: ["Build the pack for one role now: pack <id>", async () => {
    const r = await buildPack(Number(args[0]));
    console.log(r.skipped ? `Skipped: ${r.opportunity.skip_reason}` : `Ready. Resume: ${r.resumePath}`);
    if (r.resumeIssues.length) console.log("Check:", r.resumeIssues);
    if (r.fillIns.length) console.log("Fill in:", r.fillIns);
    if (telegramReady() && !flag("quiet")) await sendPack(r.opportunity.id);
  }],
  queue: ["Build all queued packs", async () => console.log(`Built ${await runPackQueue(20)}`)],
  today: ["Print what needs you today", async () => {
    reconcileActions();
    console.log(stripTags(digestText().text));
  }],
  digest: ["Send today's digest to Telegram", () => sendDigest()],
  loops: ["List every open loop, due or not", async () => {
    reconcileActions();
    const rows = all<{ id: number; title: string; due_at: string; urgent: number }>("SELECT * FROM actions WHERE status='open' ORDER BY due_at");
    for (const a of rows) console.log(`${String(a.id).padStart(4)}  ${a.due_at.slice(0, 10)}  ${a.urgent ? "!" : " "} ${a.title}`);
    console.log(`\n${rows.length} open, ${dueActions().length} due now`);
  }],
  list: ["List roles: list [status]", async () => {
    const rows = all<{ id: number; company: string; role: string; status: string; pack_status: string }>(
      args[0] ? "SELECT * FROM opportunities WHERE status = $s ORDER BY id" : "SELECT * FROM opportunities ORDER BY id",
      args[0] ? { s: args[0] } : {},
    );
    for (const o of rows) console.log(`${String(o.id).padStart(4)}  ${o.status.padEnd(12)} ${o.role} — ${o.company}${o.pack_status === "queued" ? "  (pack queued)" : ""}`);
  }],
  watch: ["Watch a job board or careers page: watch <url> [name] [--every 6]", async () => {
    if (!args[0]) throw new Error("Usage: watch <url> [name] [--every <hours>]");
    const every = args.indexOf("--every");
    const name = args.slice(1, every > 0 ? every : undefined).join(" ") || undefined;
    const { source, isNew } = addSource(args[0], { label: name, intervalHours: every > 0 ? Number(args[every + 1]) : undefined, via: "cli" });
    console.log(`${isNew ? "Watching" : "Already watching"} ${source.label} (id ${source.id}), every ${source.interval_hours} h. Scanning now…`);
    console.log(describeResult((await scanNow(source.id, { force: true }))!));
    await runSummaries();
  }],
  sources: ["List watched pages", async () => {
    for (const s of listSources()) {
      console.log(`${String(s.id).padStart(3)}  ${s.status.padEnd(7)} every ${String(s.interval_hours).padEnd(3)}h  ${s.label}  ${s.url}`);
      console.log(`       last scan ${s.last_scanned_at ?? "never"}${s.last_result ? `: ${describeResult(JSON.parse(s.last_result))}` : ""}${s.last_error ? `  ERROR ${s.last_error}` : ""}`);
    }
  }],
  "sources:scan": ["Scan a watched page now: sources:scan <id>", async () => {
    console.log(describeResult((await scanNow(Number(args[0]), { force: true }))!));
    await runSummaries();
  }],
  unwatch: ["Stop watching a page: unwatch <id>", async () => removeSource(Number(args[0]))],
  serve: ["Open the dashboard without the daemon", async () => {
    startServer(undefined, { addLink, watchPage, scanNow, addCompanies, scanCompany: scanCompanyNow, research: researchNow });
    await new Promise(() => {});
  }],
  "service:install": ["Write a login item that keeps the daemon running and the Mac awake on power", async () => {
    const plist = path.join(os.homedir(), "Library/LaunchAgents/local.jobhunt.daemon.plist");
    const npx = path.join(path.dirname(process.execPath), "npx");
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.jobhunt.daemon</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-s</string>
    <string>${npx}</string><string>tsx</string><string>src/daemon.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path.dirname(process.execPath)}:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(PATHS.logs, "launchd.out.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(PATHS.logs, "launchd.err.log")}</string>
</dict></plist>
`);
    console.log(`Wrote ${plist}\nStart it with:\n  launchctl load -w "${plist}"\nStop it with:\n  launchctl unload "${plist}"`);
  }],
};

if (cmd === "help" || !commands[cmd]) {
  console.log("Usage: npm run jh -- <command>\n");
  for (const [name, [desc]] of Object.entries(commands)) console.log(`  ${name.padEnd(18)} ${desc}`);
} else {
  try {
    await commands[cmd][1]();
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

import { spawn } from "node:child_process";
import type http from "node:http";
import path from "node:path";
import { DATA_DIR, PATHS } from "../config.ts";
import { backToSetup, hubMode, refuseCrossOrigin, sameOrigin, sendHtml } from "./forms.ts";
import { page, postButton } from "./ui.ts";

/**
 * Download my data, for hub mode (JH_HUB=1): the person's whole data folder as a .tar.gz, made by
 * the system tar (arguments as an array, no shell). The browser profile (LinkedIn's cookies and
 * cache) and half-written *.tmp files are left out.
 */

/** The tar arguments. The archive holds the folder's contents as ./… paths. */
export function tarArgs(dir = DATA_DIR): string[] {
  const profile = path.relative(dir, PATHS.browserProfile);
  const excludes = ["--exclude=*.tmp"];
  if (profile && !profile.startsWith("..")) excludes.push(`--exclude=./${profile}`);
  return ["-czf", "-", ...excludes, "-C", dir, "."];
}

function exportPage(): string {
  return page("Your data · kindahired", `<div class="stack setup">${backToSetup}
<div><h1>Download my data</h1><p class="lede">One .tar.gz file with everything the tool keeps for you: roles, people, tasks, resumes and packs, your profile and playbook, and your settings file with your keys. Keep it somewhere private.</p>
<p class="hint">Your LinkedIn browser session isn't included.</p></div>
<p>${postButton("/setup/export", "Download my data", { variant: "primary" })}</p>
<p class="muted">To delete your data from the hub, ask the hub owner. They remove your folder and your account.</p>
</div>`, { tab: "setup" });
}

/** Handles /setup/export. Returns false for any other path. */
export function setupExportRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (url.pathname !== "/setup/export" || !hubMode()) return false;
  if (req.method === "GET") {
    sendHtml(res, 200, exportPage());
    return true;
  }
  if (req.method !== "POST") return false;
  if (!sameOrigin(req)) { refuseCrossOrigin(res); return true; }
  req.resume();
  const tar = spawn("tar", tarArgs(), { stdio: ["ignore", "pipe", "pipe"] });
  tar.stderr.resume(); // tar warns about files that change while it reads them; the archive is still usable
  // A failed tar cuts the download short, so the browser shows it as failed rather than saving half a file.
  tar.on("error", (err) => { console.error(`Data export failed: ${err.message}`); res.destroy(); });
  tar.on("close", (code) => { if (code && code !== 1) { console.error(`Data export: tar exited with ${code}`); res.destroy(); } });
  res.on("close", () => { if (tar.exitCode === null) tar.kill(); });
  const day = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="kindahired-data-${day}.tar.gz"`,
    "cache-control": "no-store",
  });
  tar.stdout.pipe(res);
  return true;
}

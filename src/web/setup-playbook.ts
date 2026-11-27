import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { PATHS, ROOT } from "../config.ts";
import { backToSetup, errorBox, hubMode, readForm, refuseCrossOrigin, sameOrigin, sendHtml } from "./forms.ts";
import { esc, page } from "./ui.ts";

/** Playbook editor, for hub mode (JH_HUB=1). The text is saved exactly as typed. */

const EXAMPLE = path.join(ROOT, "context", "playbook.example.md");
const MAX = 200 * 1024;

const read = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return null; } };

/** Done once the playbook has text and isn't the untouched example. */
export function playbookDone(): boolean {
  const text = read(PATHS.playbook);
  return Boolean(text?.trim()) && text !== read(EXAMPLE);
}

function playbookPage(text: string, o: { errors?: string[]; flash?: string | null } = {}): string {
  return page("Playbook · Job hunt", `<div class="stack setup">${backToSetup}
<div><h1>Your playbook</h1><p class="lede">The playbook tells the tool how you judge a role and how you write: what you want, what you won't take, your strongest stories, and the tone of your notes. Every fit read, resume and note follows it.</p>
<p class="hint">Plain text or Markdown. Write it the way you would brief a friend helping with your search.</p></div>
${errorBox(o.errors ?? [])}
<form method="post" action="/setup/playbook" class="stack">
<div class="panel"><div class="form-row"><label for="pb-text">Playbook</label><textarea class="field tall" id="pb-text" name="playbook" spellcheck="true">${esc(text)}</textarea></div></div>
<div class="btn-row"><button class="btn primary">Save playbook</button></div></form>
</div>`, { tab: "setup", flash: o.flash });
}

/** Handles /setup/playbook. Returns false for any other path. */
export async function setupPlaybookRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/setup/playbook" || !hubMode()) return false;
  if (req.method === "GET") {
    sendHtml(res, 200, playbookPage(read(PATHS.playbook) ?? "", { flash: url.searchParams.get("flash") }));
    return true;
  }
  if (req.method !== "POST") return false;
  if (!sameOrigin(req)) { refuseCrossOrigin(res); return true; }
  const form = await readForm(req, MAX * 4);
  const text = form?.get("playbook");
  if (text == null || text.length > MAX) {
    sendHtml(res, 413, playbookPage(text?.slice(0, MAX) ?? read(PATHS.playbook) ?? "", { errors: ["The playbook is too long. Keep it under 200 KB."] }));
    return true;
  }
  mkdirSync(path.dirname(PATHS.playbook), { recursive: true });
  const tmp = `${PATHS.playbook}.${process.pid}.tmp`;
  // Browsers send textarea line breaks as CRLF; the file keeps plain LF.
  writeFileSync(tmp, text.replace(/\r\n/g, "\n"));
  renameSync(tmp, PATHS.playbook);
  res.writeHead(303, { location: "/setup/playbook?flash=" + encodeURIComponent("Playbook saved."), "cache-control": "no-store" });
  res.end();
  return true;
}

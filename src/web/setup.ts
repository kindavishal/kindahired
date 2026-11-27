import type http from "node:http";
import { googleConnected } from "../sources/google-auth.ts";
import { workerStatus } from "../worker/queue.ts";
import { hubMode, sendHtml } from "./forms.ts";
import { playbookDone } from "./setup-playbook.ts";
import { keysDone } from "./setup-keys.ts";
import { profileDone } from "./setup-profile.ts";
import { telegramLinked } from "./telegram-connect.ts";
import { badge, esc, icon, linkButton, page } from "./ui.ts";

/**
 * The setup checklist, for hub mode (JH_HUB=1): the six things a new person sets up, each with
 * its own page. Home shows one "Finish setup" callout until all six are done.
 */

type Step = { key: string; title: string; why: string; href: string; done: () => boolean };
const STEPS: Step[] = [
  { key: "profile", title: "Profile", why: "Your name, links and the roles you want.", href: "/setup/profile", done: profileDone },
  { key: "playbook", title: "Playbook", why: "How you judge a role and how you write.", href: "/setup/playbook", done: playbookDone },
  { key: "keys", title: "AI keys", why: "A Gemini or Anthropic key for the quick steps.", href: "/setup/keys", done: keysDone },
  { key: "google", title: "Google", why: "Job alerts and replies from Gmail, interviews from Calendar.", href: "/google", done: googleConnected },
  { key: "telegram", title: "Telegram", why: "New roles, packs and reminders on your phone.", href: "/telegram/connect", done: telegramLinked },
  { key: "desktop", title: "Install the app", why: "Packs and research are made by the app on your computer, with your own Claude plan.", href: "/app", done: () => Boolean(workerStatus().lastSeen) },
];

/** Each step and whether it is done. */
export function setupStatus(): { key: string; title: string; why: string; href: string; done: boolean }[] {
  return STEPS.map((s) => {
    let done = false;
    try { done = s.done(); } catch { /* a broken file counts as not done */ }
    return { key: s.key, title: s.title, why: s.why, href: s.href, done };
  });
}

/** The one Home callout while anything is missing, in hub mode. It names the next step. */
export function setupCallout(): string {
  if (!hubMode()) return "";
  const steps = setupStatus();
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return "";
  const next = steps.find((s) => !s.done)!;
  return `<div class="callout accent"><p><strong>Finish setup (${done} of ${steps.length}).</strong> Next: ${esc(next.title)}. ${esc(next.why)}</p>${linkButton("/setup", "Finish setup", "primary")}</div>`;
}

function setupPage(): string {
  const steps = setupStatus();
  const done = steps.filter((s) => s.done).length;
  const rows = steps.map((s) => `<div class="setup-row"><div><p class="card-title">${esc(s.title)}</p><p class="card-sub">${esc(s.why)}</p></div>
${s.done ? badge("Done", "ok") : badge("Not done", "warn")}${linkButton(s.href, s.done ? "Change" : "Set up", s.done ? "default" : "primary")}</div>`).join("");
  const lede = done === steps.length ? "Everything is set up. Change any of it here." : `${done} of ${steps.length} done. Each step takes a minute or two.`;
  return page("Setup · kindahired", `<div class="stack setup">
<div><h1>Setup</h1><p class="lede">${lede}</p></div>
<div class="panel">${rows}</div>
<div class="btn-row"><a class="icon-link" href="/setup/export">${icon("download")}Download my data</a><span style="flex:1"></span><form method="post" action="/signout"><button class="btn quiet">Sign out</button></form></div>
</div>`, { tab: "setup" });
}

/** Handles /setup. Returns false for any other path. */
export function setupRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (url.pathname !== "/setup" || !hubMode() || req.method !== "GET") return false;
  sendHtml(res, 200, setupPage());
  return true;
}

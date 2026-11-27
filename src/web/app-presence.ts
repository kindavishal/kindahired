import { AsyncLocalStorage } from "node:async_hooks";
import type http from "node:http";
import { workerStatus } from "../worker/queue.ts";
import { hubMode } from "./forms.ts";
import { icon, linkButton, postButton, type BtnOpts } from "./ui.ts";

/**
 * Whether this person's Claude steps need the desktop app, whether they have it, and whether the
 * page is being viewed inside it. Claude actions (build a pack, research) read these to show the
 * action itself, "Download the app", or "… in the app".
 */

/** In hub mode Claude Code runs in the person's desktop app, so packs and research need it. */
export const needsApp = () => hubMode() && process.env.JH_CLAUDE_VIA === "worker";

/** The app has connected to this person's hub at least once. */
export const hasApp = () => Boolean(workerStatus().lastSeen);

const viewer = new AsyncLocalStorage<{ inApp: boolean }>();

/** Runs a request's handler knowing whether it came from the desktop app's window. */
export function withViewer<T>(req: http.IncomingMessage, fn: () => T): T {
  return viewer.run({ inApp: /\bkindahired-app\//.test(String(req.headers["user-agent"] ?? "")) }, fn);
}

/** The page is open in the desktop app. */
export const inApp = () => viewer.getStore()?.inApp ?? false;

/** Where people get the app from inside the dashboard. */
export const APP_PAGE = "/app";

/** This page in the desktop app, as a kindahired:// link. */
export const openInAppUrl = (pagePath: string) => `kindahired://open${pagePath.startsWith("/") ? pagePath : `/${pagePath}`}`;

/** What a Claude action needs before it can run here: nothing, the app opened, or the app installed. */
export function claudeGate(): "run" | "open" | "download" {
  if (!needsApp() || inApp()) return "run";
  return hasApp() ? "open" : "download";
}

/**
 * A button for an action that runs Claude. In the app (or when Claude runs on the hub) it's the
 * action itself. In a browser it's "<label> in the app" when they have the app, and "Download the
 * app" when they don't.
 */
export function claudeButton(action: string, label: string, pagePath: string, o: BtnOpts = {}): string {
  switch (claudeGate()) {
    case "run": return postButton(action, label, o);
    case "open": return linkButton(openInAppUrl(pagePath), `${label} in the app${icon("external")}`, o.variant ?? "default");
    case "download": return linkButton(APP_PAGE, `${icon("download")}Download the app`, o.variant === "quiet" ? "default" : o.variant ?? "default");
  }
}

/** The one line next to a "Download the app" button, saying why, as "<subject> by the kindahired app…". Empty when it isn't needed. */
export function claudeHint(subject: string): string {
  return claudeGate() === "download" ? `<p class="small muted">${subject} by the kindahired app on your computer, with your own Claude plan.</p>` : "";
}

/** The app has been in touch in the last two minutes (it checks in about every 25 seconds while open). */
export function appOnline(now = Date.now()): boolean {
  const seen = workerStatus().lastSeen;
  return Boolean(seen) && now - Date.parse(seen!) < 2 * 60_000;
}

/** What to say about Claude work that is queued: running, waiting for the app to open, or for it to be installed. */
export function waitingFor(): "running" | "open" | "install" {
  if (!needsApp()) return "running";
  if (!hasApp()) return "install";
  return appOnline() ? "running" : "open";
}

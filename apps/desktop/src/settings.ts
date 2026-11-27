import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The app's settings file, settings.json in the app's data folder. The worker token is not in it:
 * it's kept apart, encrypted with the system keychain (see main.ts).
 */
export interface Settings {
  /** The person's hub, as https://<hub domain>/. Empty until set up. */
  hubUrl: string;
  /** Start the app when the person logs in. */
  openAtLogin: boolean;
  /** The worker was paused from the tray. */
  paused: boolean;
  /** Jobs done on `day` (local date, YYYY-MM-DD). */
  today: { day: string; done: number };
}

export const DEFAULT_SETTINGS: Settings = { hubUrl: "", openAtLogin: true, paused: false, today: { day: "", done: 0 } };

export const settingsFile = (dir: string) => path.join(dir, "settings.json");

/** Reads the settings, filling in anything missing or malformed with the defaults. */
export function loadSettings(dir: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(settingsFile(dir), "utf8"));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = (r.today && typeof r.today === "object" ? r.today : {}) as Record<string, unknown>;
  return {
    hubUrl: typeof r.hubUrl === "string" ? r.hubUrl : "",
    openAtLogin: typeof r.openAtLogin === "boolean" ? r.openAtLogin : DEFAULT_SETTINGS.openAtLogin,
    paused: r.paused === true,
    today: { day: typeof t.day === "string" ? t.day : "", done: Number.isInteger(t.done) ? (t.done as number) : 0 },
  };
}

/** Writes the settings atomically: a temp file, then a rename. */
export function saveSettings(dir: string, s: Settings): void {
  mkdirSync(dir, { recursive: true });
  const file = settingsFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * Cleans up a hub address typed by a person: adds https:// when there's no scheme, drops any path,
 * query or hash, and ends with a slash. http is only allowed for this computer (for testing).
 * Returns an error message instead when it can't be a hub address.
 */
export function normalizeHubUrl(input: string): { url: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "Enter your hub address." };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: "That isn't a web address." };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { error: "The hub address must start with https://." };
  if (u.username || u.password) return { error: "The hub address can't include a user name or password." };
  return { url: `${u.protocol}//${u.host}/` };
}

/** Today's local date as YYYY-MM-DD. */
export function localDay(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Jobs done today, starting from zero on a new day. */
export function doneToday(s: Settings, now = new Date()): number {
  return s.today.day === localDay(now) ? s.today.done : 0;
}

/** The settings with `count` more jobs done today. */
export function addDone(s: Settings, count: number, now = new Date()): Settings {
  const day = localDay(now);
  return { ...s, today: { day, done: doneToday(s, now) + count } };
}

/** Compares two versions like 1.2.3 (a leading "v" or "desktop-v" is ignored). Pre-release tags sort first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.replace(/^(desktop-)?v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The Linux autostart entry (~/.config/autostart/<name>.desktop) that opens the app at login. */
export function autostartDesktopEntry(name: string, exec: string): string {
  // The Exec value is quoted, with the characters the desktop entry spec says to escape.
  const quoted = `"${exec.replace(/([\\"`$])/g, "\\$1")}"`;
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${name}`,
    `Exec=${quoted}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyDb } from "./legacy-db.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");
const IS_HUB = process.env.JH_HUB === "1";
// On a hub the repo's own .env is the owner's personal one (bot token, keys): never load it into a
// person's engine. Hub processes read only hub-dir files.
if (!IS_HUB && existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));

export const DATA_DIR = process.env.JH_DATA_DIR ?? path.join(ROOT, "data");
// The person's own settings (on the hub, one folder per person). Variables already set win.
if (existsSync(path.join(DATA_DIR, ".env"))) process.loadEnvFile(path.join(DATA_DIR, ".env"));
// Hub-wide settings come last, so precedence is: process env > person .env > hub.env (as in systemd).
if (IS_HUB) {
  const root = process.env.JH_HUB_ROOT || process.env.JH_MAC_ROOT || (process.platform === "darwin" ? path.join(os.homedir(), "kindahired-hub") : "/srv/kindahired");
  const hubEnv = path.join(process.env.JH_HUB_DIR || path.join(root, "hub"), "hub.env");
  if (existsSync(hubEnv)) process.loadEnvFile(hubEnv);
}
// Databases created before the rename are moved to the new file name before anything opens them.
mkdirSync(DATA_DIR, { recursive: true });
migrateLegacyDb(DATA_DIR);
// On the hub each person's profile and playbook live in their own folder, never the shared repo's.
const CONTEXT_DIR = process.env.JH_HUB === "1" ? path.join(DATA_DIR, "context") : path.join(ROOT, "context");
export const PATHS = {
  db: path.join(DATA_DIR, "kindahired.db"),
  resumes: path.join(DATA_DIR, "resumes"),
  browserProfile: path.join(DATA_DIR, "browser-profile"),
  googleToken: path.join(DATA_DIR, "google-token.json"),
  xToken: path.join(DATA_DIR, "x-token.json"),
  logs: path.join(DATA_DIR, "logs"),
  playbook: process.env.JH_PLAYBOOK ?? path.join(CONTEXT_DIR, "playbook.md"),
  profile: process.env.JH_PROFILE ?? path.join(CONTEXT_DIR, "profile.json"),
};
for (const dir of [DATA_DIR, PATHS.resumes, PATHS.logs]) mkdirSync(dir, { recursive: true });

export const env = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  trackerSheetId: process.env.TRACKER_SHEET_ID ?? "",
  myEmails: (process.env.MY_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  port: Number(process.env.PORT ?? 4321),
};

/** The model used for every judgement step. */
export const MODEL = process.env.JH_MODEL ?? "claude-opus-5-5";

/** Your time zone: JH_TIMEZONE (an IANA name such as "Europe/London"), else this computer's own. */
export const TIMEZONE = process.env.JH_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The date ("2026-11-26") and minutes since midnight in your time zone. */
export function localClock(now = new Date()): { day: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// Lifecycle timers live in src/loops/timers.ts and are edited from the dashboard.

/** LinkedIn pacing. Keeps activity close to a person browsing. */
export const LINKEDIN_LIMITS = {
  profileVisitsPerPack: 6,
  profileVisitsPerDay: 40,
  minDelayMs: 2500,
  maxDelayMs: 7000,
};

export interface Profile {
  name: string;
  headline: string;
  location: string;
  email: string;
  phone: string;
  links: { label: string; url: string }[];
  portfolio: string;
  /** Role families I'm going for. Used to screen job alerts before any deep work. */
  targets: string[];
  /** Optional short search phrases ("developer relations", "devrel"). When empty they are split from targets. */
  keywords?: string[];
}

function readSetup(file: string, example: string): string {
  if (!existsSync(file)) throw new Error(`${path.relative(ROOT, file) || file} is missing. Copy context/${example} to ${path.relative(ROOT, file)} and fill it in (see README, "Your profile").`);
  return readFileSync(file, "utf8");
}

export function loadProfile(): Profile {
  return JSON.parse(readSetup(PATHS.profile, "profile.example.json"));
}

export function loadPlaybook(): string {
  return readSetup(PATHS.playbook, "playbook.example.md");
}

/** "Developer relations / developer advocacy" -> ["developer relations", "developer advocacy"]. */
export const targetTerms = (target: string) =>
  target.split(/\s*(?:\/|,|;|\band\b|\bor\b)\s*/i).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 2);

/** Short search phrases for your target roles, used in Gmail, X and LinkedIn searches. Empty without a profile. */
export function searchTerms(p?: Profile): string[] {
  try {
    const prof = p ?? loadProfile();
    const raw = prof.keywords?.length ? prof.keywords : prof.targets.flatMap(targetTerms);
    return [...new Set(raw.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  } catch { return []; }
}

/** Your name as a file-name part: "Sam Rivera" -> "Sam_Rivera". */
export const fileName = (name: string) => name.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_") || "Resume";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hubRoot, loadPeople } from "./people.ts";

/**
 * Running the hub on a Mac with launchd. `mac:install` writes one LaunchAgent plist per process
 * (gateway, router, an engine per person, one that keeps the Mac awake, and a watchdog) and prints
 * the launchctl commands; it never runs launchctl.
 *
 * macOS doesn't let background services touch an external drive unless the program itself has
 * Full Disk Access. So each service runs one dedicated node binary directly (no shell in between,
 * no working directory, no log files on the drive): grant Full Disk Access to that binary alone.
 * Settings files are loaded by node (--env-file) or by config.ts, never by a shell.
 */

export interface MacLayout {
  /** The hub's own app clone (branch hub), where tsx and the entry points live. */
  app: string;
  hub: string;
  people: string;
  /** launchd's own stdout/stderr files. Kept off the external drive, which launchd can't open. */
  logs: string;
  agents: string;
  /** The node binary the services run; it needs Full Disk Access when the hub is on an external drive. */
  node: string;
}

export function macLayout(): MacLayout {
  const root = hubRoot();
  return {
    app: process.env.JH_MAC_APP || path.join(root, "app"),
    hub: process.env.JH_HUB_DIR || path.join(root, "hub"),
    people: process.env.JH_PEOPLE_DIR || path.join(root, "people"),
    logs: process.env.JH_MAC_LOGS || path.join(os.homedir(), "Library", "Logs", "kindahired"),
    agents: process.env.JH_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents"),
    node: process.env.JH_HUB_NODE || (fs.existsSync(path.join(root, "bin", "node")) ? path.join(root, "bin", "node") : process.execPath),
  };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function plist(label: string, args: string[], env: Record<string, string>, logs: string, name: string, everySeconds?: number): string {
  const a = args.map((x) => `    <string>${xml(x)}</string>`).join("\n");
  const e = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${a}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${e}
  </dict>
  <key>RunAtLoad</key><true/>
${everySeconds ? `  <key>StartInterval</key><integer>${everySeconds}</integer>` : `  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>`}
  <key>StandardOutPath</key><string>${xml(path.join(logs, `${name}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, `${name}.log`))}</string>
</dict>
</plist>
`;
}

export interface PlistFile { label: string; file: string; xml: string }
type Target = "gateway" | "router" | "awake" | "watchdog" | { person: string };

/**
 * A shell script that restarts any service that stopped answering. When the external drive drops and
 * remounts (it can after the Mac sleeps), the running processes lose their own binaries and spin at
 * full CPU with their port still open, so launchd's KeepAlive never notices. Only a timeout counts:
 * a refused connection means the service is down or starting, which is launchd's job. It also kills
 * esbuild helpers orphaned by a dead tsx process. It never touches the drive, so it needs no permission.
 */
export function watchdogScript(layout: MacLayout): string {
  const checks = [
    ["dev.kindahired.gateway", `http://127.0.0.1:${process.env.GATEWAY_PORT ?? 8080}/healthz`],
    ["dev.kindahired.router", `http://127.0.0.1:${process.env.ROUTER_PORT ?? 8090}/healthz`],
    ...loadPeople(layout.hub).map((p) => [`dev.kindahired.engine.${p.id}`, `http://127.0.0.1:${p.port}/`]),
  ];
  return [
    `log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }`,
    `hung() { curl -s -o /dev/null --max-time 10 "$1"; [ $? -eq 28 ]; }`,
    `check() { hung "$2" || return 0; sleep 5; hung "$2" || return 0; log "$1 not answering at $2, restarting"; launchctl kickstart -k "gui/$(id -u)/$1"; }`,
    `pkill -P 1 -f ${sh(path.join(layout.app, "node_modules", "@esbuild") + "/")} && log "killed orphaned esbuild helpers"`,
    ...checks.map(([label, url]) => `check ${label} ${url}`),
    "exit 0",
  ].join("\n");
}

export function plistFor(layout: MacLayout, what: Target): PlistFile {
  const name = typeof what === "string" ? what : `engine.${what.person}`;
  const label = `dev.kindahired.${name}`;
  const file = path.join(layout.agents, `${label}.plist`);
  // tsx registered by absolute path, so nothing depends on a working directory.
  const tsx = path.join(layout.app, "node_modules", "tsx", "dist", "loader.mjs");
  const run = (entry: string, envFiles: string[] = []) =>
    [layout.node, ...envFiles.map((f) => `--env-file-if-exists=${f}`), "--import", pathToFileURL(tsx).href, path.join(layout.app, entry)];
  const env = { PATH: "/usr/bin:/bin", JH_HUB_ROOT: path.dirname(layout.hub), JH_HUB_DIR: layout.hub, JH_PEOPLE_DIR: layout.people };
  if (what === "awake") {
    // caffeinate keeps the Mac awake: -i idle sleep, -m disk sleep, -s system sleep on power. -s alone
    // still let the Mac idle-sleep, and the external drive can drop on wake. It touches no files.
    return { label, file, xml: plist(label, ["/usr/bin/caffeinate", "-ims"], { PATH: "/usr/bin:/bin" }, layout.logs, name) };
  }
  if (what === "watchdog") {
    return { label, file, xml: plist(label, ["/bin/sh", "-c", watchdogScript(layout)], { PATH: "/usr/bin:/bin" }, layout.logs, name, 60) };
  }
  if (what === "gateway") return { label, file, xml: plist(label, run("src/hub/gateway.ts", [path.join(layout.hub, "gateway.env")]), env, layout.logs, name) };
  if (what === "router") return { label, file, xml: plist(label, run("src/hub/router.ts", [path.join(layout.hub, "router.env")]), env, layout.logs, name) };
  // config.ts loads the person's .env and then hub.env itself (person settings win).
  const dataDir = path.join(layout.people, what.person);
  return { label, file, xml: plist(label, run("src/daemon.ts"), { ...env, JH_HUB: "1", JH_DATA_DIR: dataDir }, layout.logs, name) };
}

function targets(args: string[]): Target[] {
  const i = args.indexOf("--person");
  if (i >= 0) {
    const id = args[i + 1];
    if (!id) throw new Error("usage: --person <id>");
    if (!loadPeople(macLayout().hub).some((p) => p.id === id)) throw new Error(`No person "${id}" in people.json.`);
    return [{ person: id }];
  }
  return ["awake", "gateway", "router", ...loadPeople(macLayout().hub).map((p) => ({ person: p.id })), "watchdog"];
}

export function macInstall(args: string[], layout = macLayout()): string[] {
  const list = targets(args);
  fs.mkdirSync(layout.agents, { recursive: true });
  fs.mkdirSync(layout.logs, { recursive: true });
  const lines: string[] = [];
  const bootstrap: string[] = [];
  for (const what of list) {
    const p = plistFor(layout, what);
    fs.writeFileSync(p.file, p.xml);
    lines.push(`Wrote ${p.file}`);
    bootstrap.push(`launchctl bootstrap gui/$(id -u) ${sh(p.file)}`);
  }
  return [...lines, "", `Give Full Disk Access to ${layout.node} (System Settings → Privacy & Security) if the hub is on an external drive.`,
    "", "Start them (nothing has been started yet):", ...bootstrap.map((b) => `  ${b}`),
    "", "After a later change: launchctl kickstart -k gui/$(id -u)/<label>"];
}

export function macUninstall(args: string[], layout = macLayout()): string[] {
  const out: string[] = ["Stop and remove (nothing has been run):"];
  for (const what of targets(args)) {
    const p = plistFor(layout, what);
    out.push(`  launchctl bootout gui/$(id -u)/${p.label}`, `  rm ${sh(p.file)}`);
  }
  return out;
}

export const macCommands: Record<string, { usage: string; run: (args: string[]) => string[] }> = {
  "mac:install": { usage: "mac:install [--person <id>]    write launchd plists for the gateway, router and engines, print the bootstrap commands", run: (a) => macInstall(a) },
  "mac:uninstall": { usage: "mac:uninstall [--person <id>]  print the bootout and rm commands", run: (a) => macUninstall(a) },
};

type Launchctl = (args: string[]) => void;
const realLaunchctl: Launchctl = (args) => { execFileSync("/bin/launchctl", args, { stdio: "pipe" }); };

/**
 * Starts a newly added person's engine on this Mac: writes their plist and loads it, then reloads
 * the watchdog so it checks them too. Run by the router when the operator approves someone.
 */
export function startPersonEngine(id: string, layout = macLayout(), launchctl: Launchctl = realLaunchctl): string {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  fs.mkdirSync(layout.agents, { recursive: true });
  fs.mkdirSync(layout.logs, { recursive: true });
  const engine = plistFor(layout, { person: id });
  fs.writeFileSync(engine.file, engine.xml);
  launchctl(["bootstrap", domain, engine.file]);
  const watchdog = plistFor(layout, "watchdog");
  fs.writeFileSync(watchdog.file, watchdog.xml);
  try { launchctl(["bootout", `${domain}/${watchdog.label}`]); } catch { /* it wasn't loaded */ }
  launchctl(["bootstrap", domain, watchdog.file]);
  return `${engine.label} started`;
}

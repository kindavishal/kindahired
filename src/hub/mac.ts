import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hubDir, loadPeople } from "./people.ts";

/**
 * Running the hub on a Mac with launchd. `mac:install` writes one LaunchAgent plist per process
 * (gateway, router, an engine per person) and prints the launchctl commands; it never runs launchctl.
 * The plists source the same env files the systemd units use, in the same order.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const templateDir = path.join(repoRoot, "deploy", "mac");

export interface MacLayout {
  /** The hub's own app clone (branch hub), where tsx and the entry points live. */
  app: string;
  hub: string;
  people: string;
  logs: string;
  agents: string;
  node: string;
}

export function macLayout(): MacLayout {
  const root = process.env.JH_MAC_ROOT || path.join(os.homedir(), "kindahired-hub");
  return {
    app: process.env.JH_MAC_APP || path.join(root, "app"),
    hub: process.env.JH_HUB_DIR || path.join(root, "hub"),
    people: process.env.JH_PEOPLE_DIR || path.join(root, "people"),
    logs: path.join(root, "logs"),
    agents: process.env.JH_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents"),
    node: process.execPath,
  };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `set -a; . a; . b; set +a; exec <node> <app>/node_modules/.bin/tsx <entry>` */
function command(l: MacLayout, files: { path: string; optional?: boolean }[], entry: string, wrap = ""): string {
  const sources = files.map((f) => (f.optional ? `[ ! -f ${sh(f.path)} ] || . ${sh(f.path)}` : `. ${sh(f.path)}`));
  const run = `exec ${wrap}${sh(l.node)} ${sh(path.join(l.app, "node_modules", ".bin", "tsx"))} ${entry}`;
  return ["set -a", ...sources, "set +a", run].join("; ");
}

function render(kind: "gateway" | "router" | "engine", vars: Record<string, string>): string {
  const tpl = fs.readFileSync(path.join(templateDir, `${kind}.plist.template`), "utf8");
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => xml(vars[k] ?? ""));
}

export interface PlistFile { label: string; file: string; xml: string }

export function plistFor(layout: MacLayout, what: "gateway" | "router" | { person: string }): PlistFile {
  const name = typeof what === "string" ? what : `engine.${what.person}`;
  const label = `dev.kindahired.${name}`;
  const common = {
    LABEL: label, NAME: name, APP: layout.app, LOGS: layout.logs, HUB_DIR: layout.hub,
    PATH: `${path.dirname(layout.node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  };
  let body: string;
  if (what === "gateway") {
    // caffeinate -s keeps the Mac awake while it is on power.
    body = render("gateway", { ...common, COMMAND: command(layout, [{ path: path.join(layout.hub, "gateway.env") }], "src/hub/gateway.ts", "/usr/bin/caffeinate -s ") });
  } else if (what === "router") {
    body = render("router", { ...common, COMMAND: command(layout, [{ path: path.join(layout.hub, "router.env") }], "src/hub/router.ts") });
  } else {
    const dataDir = path.join(layout.people, what.person);
    body = render("engine", {
      ...common, PEOPLE_DIR: layout.people, DATA_DIR: dataDir,
      COMMAND: command(layout, [{ path: path.join(layout.hub, "hub.env"), optional: true }, { path: path.join(dataDir, ".env") }], "src/daemon.ts"),
    });
  }
  return { label, file: path.join(layout.agents, `${label}.plist`), xml: body };
}

function targets(args: string[]): ("gateway" | "router" | { person: string })[] {
  const i = args.indexOf("--person");
  if (i >= 0) {
    const id = args[i + 1];
    if (!id) throw new Error("usage: --person <id>");
    if (!loadPeople(macLayout().hub).some((p) => p.id === id)) throw new Error(`No person "${id}" in people.json.`);
    return [{ person: id }];
  }
  return ["gateway", "router", ...loadPeople(macLayout().hub).map((p) => ({ person: p.id }))];
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
  return [...lines, "", "Start them (nothing has been started yet):", ...bootstrap.map((b) => `  ${b}`),
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

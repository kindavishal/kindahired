import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { macInstall, macUninstall, plistFor, type MacLayout } from "../src/hub/mac.ts";
import { savePeople } from "../src/hub/people.ts";

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kh-mac-"));
  const layout: MacLayout = { app: `${root}/app`, hub: `${root}/hub`, people: `${root}/people`, logs: `${root}/logs`, agents: `${root}/agents`, node: `${root}/bin/node` };
  process.env.JH_HUB_DIR = layout.hub;
  savePeople([{ id: "sam", email: "s@x.io", port: 4401, relaySecret: "a", workerToken: "b", chatId: null }], layout.hub);
  return layout;
}

// Background services can't reach an external drive through a shell, so the dedicated node runs directly.
test("gateway runs the dedicated node directly, with gateway.env loaded by node", () => {
  const l = setup();
  const p = plistFor(l, "gateway");
  assert.equal(p.label, "dev.kindahired.gateway");
  const args = [...p.xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const i = args.indexOf(l.node);
  assert.ok(i > 0, "node is the program");
  assert.equal(args[i + 1], `--env-file-if-exists=${l.hub}/gateway.env`);
  assert.doesNotMatch(p.xml, /\/bin\/sh|caffeinate|WorkingDirectory/);
  assert.match(p.xml, /src\/hub\/gateway\.ts/);
  assert.match(p.xml, /<key>KeepAlive<\/key><true\/>/);
});

test("engine runs in hub mode with its own data folder", () => {
  const x = plistFor(setup(), { person: "sam" }).xml;
  assert.match(x, /<key>JH_HUB<\/key><string>1<\/string>/);
  assert.match(x, /<key>JH_DATA_DIR<\/key><string>[^<]*people\/sam<\/string>/);
  assert.match(x, /src\/daemon\.ts/);
});

test("staying awake is its own service, and the plists are valid", () => {
  const l = setup();
  assert.match(plistFor(l, "awake").xml, /\/usr\/bin\/caffeinate<\/string>\s*<string>-ims/);
  const out = macInstall([], l).join("\n");
  for (const n of ["awake", "gateway", "router", "engine.sam", "watchdog"]) {
    const file = path.join(l.agents, `dev.kindahired.${n}.plist`);
    assert.ok(existsSync(file));
    assert.match(out, new RegExp(`launchctl bootstrap gui/\\$\\(id -u\\) .*dev\\.kindahired\\.${n}\\.plist`));
    if (process.platform === "darwin") execFileSync("plutil", ["-lint", file]);
  }
  assert.match(readFileSync(path.join(l.agents, "dev.kindahired.router.plist"), "utf8"), /router\.env/);
  assert.match(out, /Full Disk Access/);
  assert.match(macUninstall(["--person", "sam"], l).join("\n"), /bootout gui\/\$\(id -u\)\/dev\.kindahired\.engine\.sam/);
});

// A drive that drops and remounts leaves services spinning with their port open, which KeepAlive can't see.
test("the watchdog runs every minute and restarts only a service that times out", () => {
  const l = setup();
  const x = plistFor(l, "watchdog").xml;
  assert.match(x, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.doesNotMatch(x, /KeepAlive/);
  assert.match(x, /<string>\/bin\/sh<\/string>\s*<string>-c<\/string>/);
  for (const [label, url] of [["gateway", ":8080/healthz"], ["router", ":8090/healthz"], ["engine.sam", ":4401/"]])
    assert.match(x, new RegExp(`check dev\\.kindahired\\.${label.replace(".", "\\.")} http://127\\.0\\.0\\.1${url}`));
  assert.match(x, /\$\? -eq 28/);
  assert.match(x, /launchctl kickstart -k/);
  assert.match(x, /pkill -P 1 -f/);
  assert.doesNotMatch(x, /\[ -d /, "never touches the drive");
});

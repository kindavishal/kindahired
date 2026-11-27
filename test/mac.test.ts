import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { macInstall, macUninstall, plistFor, type MacLayout } from "../src/hub/mac.ts";
import { savePeople } from "../src/hub/people.ts";

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kh-mac-"));
  const layout: MacLayout = { app: `${root}/app`, hub: `${root}/hub`, people: `${root}/people`, logs: `${root}/logs`, agents: `${root}/agents`, node: "/usr/local/bin/node" };
  process.env.JH_HUB_DIR = layout.hub;
  savePeople([{ id: "sam", email: "s@x.io", port: 4401, relaySecret: "a", workerToken: "b", chatId: null }], layout.hub);
  return layout;
}

test("gateway plist runs under caffeinate and sources gateway.env", () => {
  const p = plistFor(setup(), "gateway");
  assert.equal(p.label, "dev.kindahired.gateway");
  assert.match(p.xml, /exec \/usr\/bin\/caffeinate -s '\/usr\/local\/bin\/node'/);
  assert.match(p.xml, /\. '[^']*hub\/gateway\.env'/);
  assert.match(p.xml, /<key>KeepAlive<\/key><true\/>/);
});

test("engine plist sources hub.env then the person's .env", () => {
  const x = plistFor(setup(), { person: "sam" }).xml;
  assert.ok(x.indexOf("hub.env") < x.indexOf("people/sam/.env"));
  assert.match(x, /<key>JH_DATA_DIR<\/key><string>[^<]*people\/sam<\/string>/);
  assert.match(x, /src\/daemon\.ts/);
});

test("mac:install writes plists and prints bootstrap; uninstall prints bootout", () => {
  const l = setup();
  const out = macInstall([], l).join("\n");
  for (const n of ["gateway", "router", "engine.sam"]) {
    assert.ok(existsSync(path.join(l.agents, `dev.kindahired.${n}.plist`)));
    assert.match(out, new RegExp(`launchctl bootstrap gui/\\$\\(id -u\\) .*dev\\.kindahired\\.${n}\\.plist`));
  }
  assert.match(readFileSync(path.join(l.agents, "dev.kindahired.router.plist"), "utf8"), /router\.env/);
  assert.match(macUninstall(["--person", "sam"], l).join("\n"), /bootout gui\/\$\(id -u\)\/dev\.kindahired\.engine\.sam/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

// A private data folder, with its own profile and playbook, so nothing here touches the examples.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "jh-setup-"));
process.env.JH_DATA_DIR = dataDir;
process.env.JH_PROFILE = path.join(dataDir, "context", "profile.json");
process.env.JH_PLAYBOOK = path.join(dataDir, "context", "playbook.md");
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { useMemoryDb } = await import("../src/db/index.ts");
const { startServer } = await import("../src/web/server.ts");
const { setRestart, updateEnvText, envValues } = await import("../src/web/setup-keys.ts");
const { PATHS } = await import("../src/config.ts");
const { llm } = await import("../src/llm/client.ts");

let server: Server;
let base = "";
let restarts = 0;
const envPath = path.join(dataDir, ".env");
const GEMINI = "AIzaSyTESTKEY-0000000000abcd";

before(async () => {
  server = startServer(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setRestart(() => { restarts++; });
});
after(() => {
  setRestart();
  server.closeAllConnections();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  useMemoryDb();
  process.env.JH_HUB = "1";
  restarts = 0;
});

// Hub mode: every request comes through the gateway, which adds the shared secret.
process.env.HUB_GATEWAY_SECRET = "gw-test-secret";
const GW = { "x-kindahired-gateway": "gw-test-secret" };
const get = (p: string) => fetch(base + p, { redirect: "manual", headers: GW });
const post = (p: string, form: Record<string, string>, origin: string | null = base) =>
  fetch(base + p, {
    method: "POST", redirect: "manual",
    headers: { ...GW, "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    body: new URLSearchParams(form).toString(),
  });

const PROFILE = {
  name: "Asha Rao", headline: "Product Marketing Manager", location: "Bengaluru", email: "asha@example.com", phone: "+91 90000 00000",
  portfolio: "https://asha.example", links: "LinkedIn: https://www.linkedin.com/in/asha\nGitHub: https://github.com/asha",
  targets: "Product marketing / go-to-market\nGrowth marketing", keywords: "",
};

test("profile: saves every field as pretty JSON", async () => {
  const res = await post("/setup/profile", { intent: "save", ...PROFILE });
  assert.equal(res.status, 303);
  const raw = readFileSync(PATHS.profile, "utf8");
  assert.match(raw, /\n  "name": "Asha Rao"/);
  assert.deepEqual(JSON.parse(raw), {
    name: "Asha Rao", headline: "Product Marketing Manager", location: "Bengaluru", email: "asha@example.com", phone: "+91 90000 00000",
    portfolio: "https://asha.example",
    links: [{ label: "LinkedIn", url: "https://www.linkedin.com/in/asha" }, { label: "GitHub", url: "https://github.com/asha" }],
    targets: ["Product marketing / go-to-market", "Growth marketing"], keywords: [],
  });
  const page = await (await get("/setup/profile")).text();
  assert.match(page, /value="Asha Rao"/);
  assert.match(page, /LinkedIn: https:\/\/www.linkedin.com\/in\/asha/);
});

test("profile: refuses a missing name, a bad email, a bad link and no targets", async () => {
  const before = readFileSync(PATHS.profile, "utf8");
  const res = await post("/setup/profile", { intent: "save", ...PROFILE, name: " ", email: "not-an-email", links: "LinkedIn linkedin.com/in/x", targets: "" });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /Add your name/);
  assert.match(html, /doesn&#39;t look like an email|doesn't look like an email/);
  assert.match(html, /Label: https:/);
  assert.match(html, /at least one target role/);
  assert.equal(readFileSync(PATHS.profile, "utf8"), before);
});

test("profile: resume text fills the form through profile.parse without saving", async () => {
  const before = readFileSync(PATHS.profile, "utf8");
  const original = llm.structured;
  const labels: string[] = [];
  llm.structured = (async (label: string) => {
    labels.push(label);
    return { name: "Ravi Kumar", headline: "Engineer", location: "Pune", email: "ravi@example.com", phone: "", portfolio: "", links: [], targets: ["Developer relations"] };
  }) as typeof llm.structured;
  try {
    const res = await post("/setup/profile", { intent: "parse", resume: "Ravi Kumar, engineer in Pune. ".repeat(5) });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.deepEqual(labels, ["profile.parse"]);
    assert.match(html, /value="Ravi Kumar"/);
    assert.equal(readFileSync(PATHS.profile, "utf8"), before);
  } finally {
    llm.structured = original;
  }
});

test("playbook: saves the text as typed", async () => {
  const text = "# My playbook\n\nNo agencies.\n";
  assert.equal((await post("/setup/playbook", { playbook: text })).status, 303);
  assert.equal(readFileSync(PATHS.playbook, "utf8"), text);
});

const ENV_START = `# Set by the hub owner
JH_HUB=1
TELEGRAM_BOT_TOKEN=relay-secret-value

# Your keys
GEMINI_API_KEY=old-gemini-key-1111
PORT=4401
`;

test("keys: updates only its own keys, keeps the rest and the comments, mode 600", async () => {
  writeFileSync(envPath, ENV_START);
  const res = await post("/setup/keys", { MY_EMAILS: "asha@example.com", JH_TIMEZONE: "Asia/Kolkata", GEMINI_API_KEY: GEMINI, JH_QUICK: "gemini" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1>Saving…<\/h1>/);
  await new Promise((r) => setImmediate(r));
  assert.equal(restarts, 1);
  const out = readFileSync(envPath, "utf8");
  assert.equal(out, `# Set by the hub owner
JH_HUB=1
TELEGRAM_BOT_TOKEN=relay-secret-value

# Your keys
GEMINI_API_KEY=${GEMINI}
PORT=4401
MY_EMAILS=asha@example.com
JH_TIMEZONE=Asia/Kolkata
`);
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
});

test("keys: the page never shows a secret, only its last four characters", async () => {
  const html = await (await get("/setup/keys")).text();
  assert.ok(!html.includes(GEMINI));
  assert.ok(!html.includes("relay-secret-value"));
  assert.match(html, /set \(ends …abcd\)/);
  assert.match(html, /value="asha@example.com"/);
});

test("keys: an empty field keeps the key; nothing changed means no restart", async () => {
  const before = readFileSync(envPath, "utf8");
  const res = await post("/setup/keys", { MY_EMAILS: "asha@example.com", JH_TIMEZONE: "Asia/Kolkata", GEMINI_API_KEY: "", JH_QUICK: "gemini" });
  assert.equal(res.status, 303);
  assert.equal(readFileSync(envPath, "utf8"), before);
  assert.equal(restarts, 0);
});

test("keys: refuses values with line breaks or quotes, without echoing them", async () => {
  const before = readFileSync(envPath, "utf8");
  for (const bad of ["zq9bad\nJH_HUB=0", "zq9bad\"def", "zq9bad's"]) {
    const res = await post("/setup/keys", { MY_EMAILS: "asha@example.com", JH_TIMEZONE: "Asia/Kolkata", FIRECRAWL_API_KEY: bad });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /no quotes, # or line breaks/);
    assert.ok(!html.includes("zq9bad"));
  }
  assert.equal(readFileSync(envPath, "utf8"), before);
  assert.equal(restarts, 0);
});

test("keys: Remove deletes the line", async () => {
  const res = await post("/setup/keys", { MY_EMAILS: "asha@example.com", JH_TIMEZONE: "Asia/Kolkata", GEMINI_API_KEY__remove: "1" });
  assert.equal(res.status, 200);
  const out = readFileSync(envPath, "utf8");
  assert.ok(!out.includes("GEMINI_API_KEY"));
  assert.match(out, /^# Your keys\nPORT=4401$/m);
});

test("keys: Haiku is refused without an Anthropic key, allowed with one", async () => {
  const before = readFileSync(envPath, "utf8");
  const no = await post("/setup/keys", { MY_EMAILS: "asha@example.com", JH_TIMEZONE: "Asia/Kolkata", JH_QUICK: "haiku" });
  assert.equal(no.status, 400);
  assert.match(await no.text(), /only with an Anthropic API key/);
  assert.equal(readFileSync(envPath, "utf8"), before);

  const yes = await post("/setup/keys", { MY_EMAILS: "asha@example.com", JH_TIMEZONE: "Asia/Kolkata", JH_QUICK: "haiku", ANTHROPIC_API_KEY: "sk-ant-test-000000000wxyz" });
  assert.equal(yes.status, 200);
  const v = envValues(readFileSync(envPath, "utf8"));
  assert.equal(v.get("JH_QUICK"), "haiku");
  assert.equal(v.get("ANTHROPIC_API_KEY"), "sk-ant-test-000000000wxyz");
});

test("keys: a bad time zone or email is refused", async () => {
  const res = await post("/setup/keys", { MY_EMAILS: "asha", JH_TIMEZONE: "Mars/Olympus" });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /isn&#39;t an email address|isn't an email address/);
  assert.match(html, /isn&#39;t a time zone|isn't a time zone/);
});

test("updateEnvText keeps comments, removes duplicates of a changed key, and appends new keys", () => {
  const text = "# c\nA=1\nexport B='two'\nB=3\n\n# end";
  assert.equal(updateEnvText(text, { B: "4", C: "5", A: null }), "# c\nB=4\n\n# end\nC=5\n");
  assert.equal(envValues(text).get("B"), "3");
  assert.equal(updateEnvText("", { X: "1" }), "X=1\n");
});

test("export: a tar.gz of the data folder without the browser profile or temp files", async () => {
  mkdirSync(PATHS.browserProfile, { recursive: true });
  writeFileSync(path.join(PATHS.browserProfile, "Cookies"), "secret cookies");
  writeFileSync(path.join(dataDir, "half.tmp"), "x");
  mkdirSync(PATHS.resumes, { recursive: true });
  writeFileSync(path.join(PATHS.resumes, "cv.pdf"), "%PDF");
  const res = await post("/setup/export", {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.match(res.headers.get("content-disposition")!, /attachment; filename="kindahired-data-\d{4}-\d{2}-\d{2}\.tar\.gz"/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf[0], 0x1f);
  assert.equal(buf[1], 0x8b);
  const archive = path.join(os.tmpdir(), `jh-export-${process.pid}.tar.gz`);
  writeFileSync(archive, buf);
  try {
    const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.ok(names.some((n) => n.endsWith("resumes/cv.pdf")));
    assert.ok(names.some((n) => n.endsWith("context/profile.json")));
    assert.ok(names.some((n) => n.endsWith(".env")));
    assert.ok(!names.some((n) => n.includes("browser-profile")), names.join(", "));
    assert.ok(!names.some((n) => n.endsWith(".tmp")));
  } finally {
    rmSync(archive, { force: true });
  }
});

test("cross-origin and origin-less POSTs are refused on every setup route", async () => {
  const before = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const p of ["/setup/profile", "/setup/playbook", "/setup/keys", "/setup/export"]) {
    const evil = await post(p, { intent: "save", ...PROFILE, playbook: "x", MY_EMAILS: "evil@example.com" }, "https://evil.example");
    assert.equal(evil.status, 403, p);
    const none = await post(p, { playbook: "x" }, null);
    assert.equal(none.status, 403, p);
  }
  // A Referer from this host passes when Origin is missing.
  const ref = await fetch(base + "/setup/playbook", {
    method: "POST", redirect: "manual",
    headers: { ...GW, "content-type": "application/x-www-form-urlencoded", referer: base + "/setup/playbook" },
    body: "playbook=ok",
  });
  assert.equal(ref.status, 303);
  assert.equal(readFileSync(envPath, "utf8"), before);
});

test("setup checklist and the one Home callout", async () => {
  const html = await (await get("/setup")).text();
  for (const t of ["Profile", "Playbook", "AI keys", "Google", "Telegram", "Install the app"]) assert.match(html, new RegExp(`>${t}<`));
  const home = await (await get("/")).text();
  assert.match(home, /Finish setup \(\d of 6\)/);
  assert.ok(!home.includes("Connect Telegram"));
  assert.ok(!home.includes("Install the desktop app"));
});

test("setup routes don't exist outside hub mode", async () => {
  delete process.env.JH_HUB;
  for (const p of ["/setup", "/setup/profile", "/setup/playbook", "/setup/keys", "/setup/keys/ping", "/setup/export"]) {
    assert.equal((await get(p)).status, 404, p);
    assert.equal((await post(p, {})).status, 404, p);
  }
  assert.ok(!(await (await get("/")).text()).includes("Finish setup"));
});

test("desktop pairing: the signed-in app gets its worker token, nothing else does", async () => {
  process.env.JH_WORKER_TOKEN = "wt-test-token";
  try {
    const pairReq = (headers: Record<string, string>) => fetch(base + "/desktop/pair", { method: "POST", redirect: "manual", headers: { ...GW, ...headers } });
    const ok = await pairReq({ origin: base, "x-kindahired-app": "1" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, token: "wt-test-token" });
    assert.equal((await pairReq({ origin: "https://evil.example", "x-kindahired-app": "1" })).status, 403);
    assert.equal((await pairReq({ "x-kindahired-app": "1" })).status, 403);
    assert.equal((await pairReq({ origin: base })).status, 400);
    assert.equal((await fetch(base + "/desktop/pair", { headers: GW, redirect: "manual" })).status, 404);
  } finally {
    delete process.env.JH_WORKER_TOKEN;
  }
});

test("Claude actions: Download the app, then '… in the app' in a browser, the action itself in the app", async () => {
  const { upsertOpportunity } = await import("../src/db/opportunities.ts");
  const { kvSet } = await import("../src/db/index.ts");
  process.env.JH_CLAUDE_VIA = "worker";
  try {
    const o = upsertOpportunity("Acme", "Growth Lead", { status: "found" });
    const view = (ua = "Mozilla/5.0") => fetch(`${base}/o/${o.id}`, { headers: { ...GW, "user-agent": ua } }).then((r) => r.text());

    // No app yet: the browser offers the download, with one line saying why.
    let html = await view();
    assert.match(html, /href="\/app"[^>]*>.*Download the app/);
    assert.match(html, /Packs are built by the kindahired app on your computer/);
    assert.ok(!html.includes(`action="/o/${o.id}/build"`));

    // The app has connected: the browser sends them to it.
    kvSet("worker.lastSeen", new Date().toISOString());
    html = await view();
    assert.match(html, new RegExp(`href="kindahired://open/o/${o.id}"[^>]*>Build pack in the app`));
    assert.ok(!html.includes("Download the app"));

    // Inside the app, the action is the real button.
    html = await view("Mozilla/5.0 Electron kindahired-app/0.2.0");
    assert.ok(html.includes(`action="/o/${o.id}/build"`));
    assert.ok(!html.includes("kindahired://"));
  } finally {
    delete process.env.JH_CLAUDE_VIA;
  }
});

test("app page shows no token; /desktop sends everyone to it", async () => {
  process.env.JH_WORKER_TOKEN = "wt-secret";
  try {
    const app = await (await get("/app")).text();
    assert.match(app, /Get the kindahired app/);
    assert.ok(!app.includes("wt-secret"));
    const desk = await get("/desktop");
    assert.equal(desk.status, 303);
    assert.equal(desk.headers.get("location"), "/app");
  } finally {
    delete process.env.JH_WORKER_TOKEN;
  }
});

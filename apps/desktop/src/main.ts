import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, safeStorage, session, shell, Tray, type IpcMainInvokeEvent } from "electron";
import updaterPkg from "electron-updater";
import config from "../app.config.json" with { type: "json" };
import { startWorker, type WorkerStatus } from "../../../src/worker/client.ts";
import { checkClaude, CLAUDE_INSTALL_URL, findClaude, widenedPath, type ClaudeCheck } from "./claude.ts";
import { addDone, autostartDesktopEntry, compareVersions, deepLinkTarget, doneToday, LINK_SCHEME, loadSettings, normalizeHubUrl, saveSettings, type Settings } from "./settings.ts";

/**
 * The desktop app: a tray (menu bar) icon that runs the worker, which takes Claude Code steps from
 * the person's hub and runs them here, on their own Claude plan. It also opens the hub's dashboard
 * in a window and keeps itself up to date.
 *
 * Signing in happens in the dashboard window (the hub's own email-code login). Right after, the app
 * asks the hub for this person's worker token (POST /desktop/pair) and keeps it in the keychain, so
 * nobody copies a hub address or a token by hand.
 */

const { autoUpdater } = updaterPkg;

// ---------- Folders and environment, before anything else reads them ----------

app.setName(config.productName);
// --user-data-dir=<folder> runs a separate copy (handy for development).
if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", path.join(app.getPath("appData"), config.productName));
const DATA = app.getPath("userData");
mkdirSync(DATA, { recursive: true });
// The worker's Claude Code runs in <JH_DATA_DIR>/agent, an empty folder of the app's own.
process.env.JH_DATA_DIR = DATA;
const TOKEN_FILE = path.join(DATA, "worker-token.bin");
const HUB_PARTITION = "persist:hub";

// The hub is built in. --hub=<address> (or KH_HUB_URL) points a test copy at another one.
const HUB_URL = (() => {
  const override = app.commandLine.getSwitchValue("hub") || process.env.KH_HUB_URL || "";
  if (!override) return config.hubUrl;
  const n = normalizeHubUrl(override);
  if ("error" in n) {
    console.error(`Ignoring --hub: ${n.error}`);
    return config.hubUrl;
  }
  return n.url;
})();
const HUB_ORIGIN = new URL(HUB_URL).origin;
const signedIn = () => existsSync(TOKEN_FILE);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------- State ----------

let settings: Settings = loadSettings(DATA);
let claude: ClaudeCheck | null = null;
let checkingClaude = false;
let worker: ReturnType<typeof startWorker> | null = null;
let workerStatus: WorkerStatus | null = null;
let blocker: number | null = null;
let tray: Tray | null = null;
let setupWin: BrowserWindow | null = null;
let dashboardWin: BrowserWindow | null = null;
let updateReady = false;

function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  saveSettings(DATA, settings);
}

// ---------- The worker token, encrypted with the system keychain ----------

async function readToken(): Promise<string> {
  try {
    if (!existsSync(TOKEN_FILE) || !(await safeStorage.isAsyncEncryptionAvailable())) return "";
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(TOKEN_FILE));
    if (shouldReEncrypt) await writeToken(result);
    return result;
  } catch {
    return "";
  }
}

async function writeToken(token: string) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("This computer has no keychain the app can use to keep the token safe.");
  writeFileSync(TOKEN_FILE, await safeStorage.encryptStringAsync(token), { mode: 0o600 });
}

// ---------- Claude Code ----------

async function detectClaude(): Promise<ClaudeCheck> {
  checkingClaude = true;
  refreshTray();
  try {
    const home = os.homedir();
    const bin = findClaude({ home, pathEnv: process.env.PATH });
    // An app opened from Finder or a desktop menu has a short PATH; Claude Code (and the node a
    // wrapper script needs) usually live in these folders.
    process.env.PATH = widenedPath(process.env.PATH, home, bin);
    if (bin) process.env.JH_CLAUDE_BIN = bin;
    claude = await checkClaude(bin, { cwd: path.join(DATA, "agent"), env: process.env });
    return claude;
  } finally {
    checkingClaude = false;
    refreshTray();
  }
}

// Claude Code is usable for jobs. A usage limit or an odd answer still counts: the hub handles
// those per job. Missing or signed out doesn't, since every job would fail.
const claudeUsable = () => claude?.state === "ok" || claude?.state === "error";

// ---------- The worker ----------

async function stopWorker(waitMs = 5_000) {
  const w = worker;
  worker = null;
  workerStatus = null;
  if (w) await Promise.race([w.stop(), new Promise((r) => setTimeout(r, waitMs))]);
  setBlocker(false);
  refreshTray();
}

// Restarts run one after another, so two quick ones can't leave two workers running.
let restarting: Promise<void> = Promise.resolve();
function restartWorker(): Promise<void> {
  restarting = restarting.then(restartNow, restartNow);
  return restarting;
}

async function restartNow() {
  await stopWorker();
  const token = await readToken();
  if (!token || settings.paused || !claudeUsable()) return refreshTray();
  let seen = 0;
  const me: ReturnType<typeof startWorker> = startWorker({
    hub: HUB_URL,
    token,
    onStatus: (s) => {
      // A job that finishes after its worker was stopped still counts.
      if (s.done > seen) {
        updateSettings(addDone(settings, s.done - seen));
        seen = s.done;
      }
      if (worker !== me) return refreshTray();
      workerStatus = s;
      setBlocker(s.running > 0);
      refreshTray();
    },
  });
  worker = me;
  workerStatus = me.status();
  refreshTray();
}

// Keep the computer from suspending the app only while a job runs.
function setBlocker(on: boolean) {
  if (on && blocker === null) blocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!on && blocker !== null) {
    powerSaveBlocker.stop(blocker);
    blocker = null;
  }
}

// ---------- Tray ----------

type Shown = { label: string; live: boolean };

function shownStatus(): Shown {
  if (!signedIn()) return { label: "Not signed in", live: false };
  if (checkingClaude && !claude) return { label: "Checking Claude Code…", live: false };
  if (claude?.state === "missing") return { label: "Claude Code isn't installed", live: false };
  if (claude?.state === "signed-out") return { label: "Claude Code isn't signed in", live: false };
  if (settings.paused) return { label: "Paused", live: false };
  const s = workerStatus;
  if (!s) return { label: "Starting…", live: false };
  switch (s.state) {
    case "online": return { label: "Online, waiting for work", live: true };
    case "working": return { label: `Working on ${s.running} Claude step${s.running === 1 ? "" : "s"}`, live: true };
    case "connecting": return { label: "Connecting to the hub…", live: false };
    case "offline": return { label: "Can't reach the hub", live: false };
    case "unauthorized": return { label: "Signed out. Open kindahired to sign in again", live: false };
    case "stopped": return { label: "Stopped", live: false };
  }
}

function trayImage(live: boolean) {
  const dir = path.join(app.getAppPath(), "assets");
  if (process.platform === "darwin") {
    const img = nativeImage.createFromPath(path.join(dir, live ? "trayTemplate.png" : "trayTemplate-off.png"));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(dir, live ? "tray.png" : "tray-off.png"));
}

let lastLive: boolean | null = null;

function refreshTray() {
  if (!tray) return;
  const shown = shownStatus();
  if (shown.live !== lastLive) {
    tray.setImage(trayImage(shown.live));
    lastLive = shown.live;
  }
  const done = doneToday(settings);
  tray.setToolTip(`${config.productName}: ${shown.label}`);
  const configured = signedIn();
  const claudeNeedsHelp = claude?.state === "missing" || claude?.state === "signed-out";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: shown.label, enabled: false },
    { label: `${done} Claude step${done === 1 ? "" : "s"} done today`, enabled: false },
    ...(workerStatus?.error && !shown.live ? [{ label: workerStatus.error.slice(0, 80), enabled: false }] : []),
    { type: "separator" },
    { label: configured ? `Open ${config.productName}` : "Sign in…", click: () => openDashboard() },
    ...(claudeNeedsHelp ? [
      { label: "Get Claude Code…", click: () => void shell.openExternal(CLAUDE_INSTALL_URL) },
      { label: "Check Claude Code again", enabled: !checkingClaude, click: () => void detectClaude().then(restartWorker) },
    ] : []),
    {
      label: settings.paused ? "Resume worker" : "Pause worker",
      enabled: configured,
      click: () => { updateSettings({ paused: !settings.paused }); void restartWorker(); },
    },
    { label: "Settings…", click: openSetup },
    { type: "separator" },
    updateReady
      ? { label: "Restart to update", click: () => void installUpdate() }
      : { label: "Check for updates", click: () => void checkForUpdates(true) },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: `Quit ${config.productName}`, click: () => void quit() },
  ]));
}

// ---------- Windows ----------

function trackWindow(win: BrowserWindow) {
  app.dock?.show();
  win.on("closed", () => {
    if (BrowserWindow.getAllWindows().length === 0) app.dock?.hide();
  });
}

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) return setupWin.focus();
  setupWin = new BrowserWindow({
    width: 480,
    height: 460,
    resizable: false,
    title: `${config.productName} settings`,
    show: false,
    icon: path.join(app.getAppPath(), "assets", "icon.png"),
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWin.webContents.on("will-navigate", (e) => e.preventDefault());
  setupWin.once("ready-to-show", () => setupWin?.show());
  setupWin.on("closed", () => { setupWin = null; });
  trackWindow(setupWin);
  void setupWin.loadFile(path.join(app.getAppPath(), "renderer", "setup.html"));
}

function openDashboard(target?: string) {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    if (target) void dashboardWin.loadURL(target);
    dashboardWin.show();
    return dashboardWin.focus();
  }
  dashboardWin = new BrowserWindow({
    width: 1280,
    height: 860,
    title: config.productName,
    icon: path.join(app.getAppPath(), "assets", "icon.png"),
    // A persistent session, so the sign-in is remembered between launches.
    webPreferences: { partition: HUB_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Links to the hub open inside the app; anything else opens in the browser.
  dashboardWin.webContents.setWindowOpenHandler(({ url }) => {
    let origin = "";
    try { origin = new URL(url).origin; } catch { /* not a URL */ }
    if (origin === HUB_ORIGIN) {
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { partition: HUB_PARTITION, contextIsolation: true, sandbox: true } } };
    }
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const win = dashboardWin;
  win.webContents.on("did-finish-load", () => void pair(win));
  win.on("closed", () => { if (dashboardWin === win) dashboardWin = null; });
  trackWindow(win);
  void win.loadURL(target ?? HUB_URL);
}

// ---------- Getting the worker token after sign-in ----------

let pairing = false;

/** Once the dashboard has loaded (so the person is signed in), asks the hub for their worker token. */
async function pair(win: BrowserWindow) {
  if (pairing || win.isDestroyed()) return;
  let here: URL;
  try { here = new URL(win.webContents.getURL()); } catch { return; }
  // Still on the login pages.
  if (here.origin !== HUB_ORIGIN || here.pathname.startsWith("/cdn-cgi/")) return;
  pairing = true;
  try {
    // Run in the page, so it goes with the page's sign-in and from the hub's own origin.
    const answer = (await win.webContents.executeJavaScript(
      `fetch("/desktop/pair", { method: "POST", headers: { "x-kindahired-app": "1" }, credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)`,
    )) as { token?: unknown } | null;
    const token = typeof answer?.token === "string" ? answer.token : "";
    if (!token || token === (await readToken())) return;
    try {
      await writeToken(token);
    } catch (err) {
      void dialog.showMessageBox({ type: "warning", message: "Couldn't finish signing in.", detail: (err as Error).message });
      return;
    }
    applyLoginItem();
    if (!claude) await detectClaude();
    await restartWorker();
    if (!claudeUsable()) openSetup();
  } finally {
    pairing = false;
  }
}

async function signOut() {
  await stopWorker();
  rmSync(TOKEN_FILE, { force: true });
  await session.fromPartition(HUB_PARTITION).clearStorageData();
  applyLoginItem();
  setupWin?.close();
  dashboardWin?.close();
  refreshTray();
  openDashboard();
}

// ---------- kindahired:// links ----------

let pendingLink: string | null = null;

function openLink(link: string) {
  const target = deepLinkTarget(link, HUB_URL);
  if (!target) return;
  if (!app.isReady()) {
    pendingLink = target;
    return;
  }
  openDashboard(target);
}

// macOS hands links over with open-url, which can fire before the app is ready.
app.on("open-url", (e, url) => {
  e.preventDefault();
  openLink(url);
});
const linkInArgs = (argv: string[]) => argv.find((a) => a.startsWith(`${LINK_SCHEME}://`));

// ---------- The setup window's requests ----------

function fromSetup(e: IpcMainInvokeEvent) {
  if (!setupWin || e.sender !== setupWin.webContents) throw new Error("Not from the settings window.");
}

function claudeForWindow() {
  if (!claude) return { state: checkingClaude ? "checking" : "unknown" };
  return { ...claude, checking: checkingClaude };
}

ipcMain.handle("setup:state", async (e) => {
  fromSetup(e);
  return {
    signedIn: signedIn(),
    openAtLogin: settings.openAtLogin,
    claude: claudeForWindow(),
    version: app.getVersion(),
    productName: config.productName,
  };
});

ipcMain.handle("setup:login-item", (e, on: unknown) => {
  fromSetup(e);
  updateSettings({ openAtLogin: on !== false });
  applyLoginItem();
});

ipcMain.handle("setup:sign-out", async (e) => {
  fromSetup(e);
  await signOut();
});

ipcMain.handle("claude:check", async (e) => {
  fromSetup(e);
  await detectClaude();
  await restartWorker();
  return claudeForWindow();
});

ipcMain.handle("claude:install-page", (e) => { fromSetup(e); return shell.openExternal(CLAUDE_INSTALL_URL); });
ipcMain.handle("dashboard:open", (e) => { fromSetup(e); openDashboard(); });
ipcMain.handle("setup:close", (e) => { fromSetup(e); setupWin?.close(); });

// ---------- Open at login ----------

function applyLoginItem() {
  // A development run would register the bare Electron binary, and a separate copy
  // (--user-data-dir) shouldn't touch the real app's login item, so only the installed app does this.
  if (!app.isPackaged || app.commandLine.hasSwitch("user-data-dir")) return;
  // Not before the app is set up: there's nothing for it to do at login until then.
  const openAtLogin = settings.openAtLogin && signedIn();
  if (process.platform === "darwin") {
    app.setLoginItemSettings({ openAtLogin });
    return;
  }
  if (process.platform === "linux") {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart");
    const file = path.join(dir, `${config.productName}.desktop`);
    try {
      if (openAtLogin) {
        mkdirSync(dir, { recursive: true });
        // An AppImage moves the running binary to a temporary mount; APPIMAGE is the file itself.
        writeFileSync(file, autostartDesktopEntry(config.productName, process.env.APPIMAGE || process.execPath));
      } else {
        rmSync(file, { force: true });
      }
    } catch (err) {
      console.error(`Couldn't update the autostart entry: ${(err as Error).message}`);
    }
  }
}

// ---------- Updates ----------

const RELEASES_PAGE = `https://github.com/${config.github.owner}/${config.github.repo}/releases`;
// The .deb can't replace itself, so it only says when there's a newer version.
const noticeOnly = process.platform === "linux" && !process.env.APPIMAGE;
let noticeShownFor = "";

async function checkForUpdates(manual: boolean) {
  if (!app.isPackaged) {
    if (manual) void dialog.showMessageBox({ message: "Updates are checked in the installed app, not in a development run." });
    return;
  }
  if (noticeOnly) return checkReleaseNotice(manual);
  try {
    const r = await autoUpdater.checkForUpdates();
    const available = r?.updateInfo && compareVersions(r.updateInfo.version, app.getVersion()) > 0;
    if (manual && !available) void dialog.showMessageBox({ message: `You have the latest version (${app.getVersion()}).` });
    if (manual && available) void dialog.showMessageBox({ message: `Version ${r!.updateInfo.version} is downloading. You'll be asked to restart when it's ready.` });
  } catch (err) {
    if (manual) void dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates.", detail: String((err as Error)?.message ?? err) });
  }
}

async function checkReleaseNotice(manual: boolean) {
  try {
    const res = await fetch(`https://api.github.com/repos/${config.github.owner}/${config.github.repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `${config.productName}-desktop` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = (await res.json()) as { tag_name?: string; html_url?: string };
    const tag = release.tag_name ?? "";
    const newer = tag && compareVersions(tag, app.getVersion()) > 0;
    if (!newer) {
      if (manual) void dialog.showMessageBox({ message: `You have the latest version (${app.getVersion()}).` });
      return;
    }
    if (!manual && noticeShownFor === tag) return;
    noticeShownFor = tag;
    const { response } = await dialog.showMessageBox({
      message: `A new version of ${config.productName} is out (${tag.replace(/^desktop-v/, "")}).`,
      detail: "Download the new .deb and install it over this one. Your settings stay.",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) void shell.openExternal(release.html_url?.startsWith("https://github.com/") ? release.html_url : RELEASES_PAGE);
  } catch (err) {
    if (manual) void dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates.", detail: String((err as Error)?.message ?? err) });
  }
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  if (!noticeOnly) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("error", (err) => console.error(`Update error: ${err?.message ?? err}`));
    autoUpdater.on("update-downloaded", async (info) => {
      updateReady = true;
      refreshTray();
      // Restarting mid-job would lose that job's work, so only offer it.
      const { response } = await dialog.showMessageBox({
        message: `Version ${info.version} is ready.`,
        detail: workerStatus?.running ? "A Claude step is running now. Restart after it finishes, or it'll install when you quit." : "Restart now to use it, or it'll install the next time you quit.",
        buttons: ["Restart now", "Later"],
        defaultId: workerStatus?.running ? 1 : 0,
        cancelId: 1,
      });
      if (response === 0) void installUpdate();
    });
  }
  setTimeout(() => void checkForUpdates(false), 15_000);
  setInterval(() => void checkForUpdates(false), 6 * 60 * 60_000);
}

// ---------- Quit ----------

let quitting = false;

async function installUpdate() {
  quitting = true;
  await stopWorker(3_000);
  autoUpdater.quitAndInstall();
}

async function quit() {
  if (workerStatus?.running) {
    const { response } = await dialog.showMessageBox({
      message: "A Claude step is running.",
      detail: "If you quit now, the hub gives it to this computer again later.",
      buttons: ["Quit anyway", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  await shutdown();
}

app.on("before-quit", (e) => {
  // An update install or the system shutting down: stop the worker, briefly, then go.
  if (quitting) return;
  e.preventDefault();
  void shutdown();
});

// A signal (a logout, `kill`, Ctrl-C in a development run) quits too.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void shutdown());

let shuttingDown: Promise<void> | null = null;
function shutdown(): Promise<void> {
  quitting = true;
  shuttingDown ??= stopWorker(3_000).catch(() => {}).then(() => app.exit(0));
  return shuttingDown;
}

// Logging to a closed terminal or pipe must not turn into an error dialog.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

// ---------- Start ----------

// The app lives in the tray, so closing every window doesn't quit it.
app.on("window-all-closed", () => {});

app.on("second-instance", (_e, argv) => {
  const link = linkInArgs(argv);
  if (link) openLink(link);
  else openDashboard();
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) openDashboard(); });

app.whenReady().then(async () => {
  app.dock?.hide();
  // Only the installed app registers for links: a development run would register bare Electron.
  if (app.isPackaged) app.setAsDefaultProtocolClient(LINK_SCHEME);
  // The dashboard can tell it's open in the app rather than in a browser.
  const hub = session.fromPartition(HUB_PARTITION);
  hub.setUserAgent(`${hub.getUserAgent()} kindahired-app/${app.getVersion()}`);
  tray = new Tray(trayImage(false));
  lastLive = false;
  refreshTray();
  applyLoginItem();
  setupAutoUpdate();
  const firstLink = pendingLink ?? (linkInArgs(process.argv) ? deepLinkTarget(linkInArgs(process.argv)!, HUB_URL) : null);
  pendingLink = null;
  // Not signed in yet: the dashboard window is where that happens.
  if (!signedIn() || firstLink) openDashboard(firstLink ?? undefined);
  await detectClaude();
  if (signedIn() && !claudeUsable() && !setupWin) openSetup();
  await restartWorker();
  // Roll the "done today" count over at midnight even when nothing happens.
  setInterval(refreshTray, 60_000);
});

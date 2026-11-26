// The settings window. It talks to the main process only through window.kh (see src/preload.ts).
const $ = (id) => document.getElementById(id);
const hub = $("hub"), token = $("token"), login = $("login");
const results = $("hub-results");
let hasToken = false;

function show(list, items) {
  list.replaceChildren(...items.map(({ cls, text }) => {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = text;
    return li;
  }));
}

function busy(on, ...buttons) {
  for (const b of buttons) b.disabled = on;
}

function showClaude(c) {
  const status = $("claude-status"), detail = $("claude-detail");
  $("install").hidden = c.state !== "missing";
  $("claude-again").disabled = c.state === "checking" || !!c.checking;
  detail.textContent = "";
  switch (c.state) {
    case "ok":
      status.className = "status ok";
      status.textContent = "Installed and signed in.";
      detail.textContent = c.bin;
      break;
    case "missing":
      status.className = "status bad";
      status.textContent = "Not found on this computer.";
      detail.textContent = "Install Claude Code, sign in once in a terminal, then check again.";
      break;
    case "signed-out":
      status.className = "status bad";
      status.textContent = "Found, but not signed in.";
      detail.textContent = c.message;
      break;
    case "error":
      status.className = "status warn";
      status.textContent = "Found, but the test didn't go as expected.";
      detail.textContent = c.message;
      break;
    default:
      status.className = "status";
      status.textContent = "Checking…";
  }
}

async function load() {
  const s = await window.kh.state();
  hub.value = s.hubUrl;
  login.checked = s.openAtLogin;
  hasToken = s.hasToken;
  if (hasToken) {
    token.placeholder = "Saved. Paste a new one to replace it.";
  }
  if (!s.keychain) {
    $("token-hint").textContent = "This computer has no keychain the app can use, so the token can't be saved yet.";
    $("token-hint").className = "hint bad";
  } else if (s.weakKeychain) {
    $("token-hint").textContent = "No system keyring was found, so the token is only lightly scrambled on disk. Installing GNOME Keyring or KWallet keeps it safer.";
  }
  $("dashboard").hidden = !s.hubUrl;
  $("version").textContent = `${s.productName} ${s.version}`;
  if (s.hubUrl) {
    document.querySelector("h1").textContent = "Settings";
  }
  showClaude(s.claude);
  // The first check may still be running; ask again until it's done.
  if (s.claude.state === "checking" || s.claude.state === "unknown" || s.claude.checking) setTimeout(refreshClaude, 1500);
}

async function refreshClaude() {
  const s = await window.kh.state();
  showClaude(s.claude);
  if (s.claude.state === "checking" || s.claude.state === "unknown" || s.claude.checking) setTimeout(refreshClaude, 1500);
}

$("check").addEventListener("click", async () => {
  busy(true, $("check"), $("save"));
  show(results, [{ cls: "", text: "Checking…" }]);
  try {
    const r = await window.kh.check(hub.value, token.value);
    const items = [{ cls: r.hub.ok ? "ok" : "bad", text: r.hub.message }];
    if (r.token) items.push({ cls: r.token.ok ? "ok" : "bad", text: r.token.message });
    show(results, items);
  } catch (err) {
    show(results, [{ cls: "bad", text: String(err?.message ?? err) }]);
  } finally {
    busy(false, $("check"), $("save"));
  }
});

$("hub-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  busy(true, $("check"), $("save"));
  try {
    const r = await window.kh.save(hub.value, token.value, login.checked);
    show(results, [{ cls: r.ok ? "ok" : "bad", text: r.ok ? "Saved. The worker is starting; its status is in the menu bar." : r.message }]);
    if (r.ok) {
      token.value = "";
      hasToken = true;
      token.placeholder = "Saved. Paste a new one to replace it.";
      $("dashboard").hidden = false;
      refreshClaude();
    }
  } catch (err) {
    show(results, [{ cls: "bad", text: String(err?.message ?? err) }]);
  } finally {
    busy(false, $("check"), $("save"));
  }
});

$("claude-again").addEventListener("click", async () => {
  showClaude({ state: "checking" });
  showClaude(await window.kh.checkClaude());
});
$("install").addEventListener("click", () => window.kh.openInstallPage());
$("dashboard").addEventListener("click", () => window.kh.openDashboard());

load();

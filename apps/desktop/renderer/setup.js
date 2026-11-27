// The settings window. It talks to the main process only through window.kh (see src/preload.ts).
const $ = (id) => document.getElementById(id);

function showClaude(c) {
  const status = $("claude-status"), detail = $("claude-detail");
  $("install").hidden = c.state !== "missing";
  $("claude-again").disabled = c.state === "checking" || !!c.checking;
  detail.textContent = "";
  switch (c.state) {
    case "ok":
      status.className = "status ok";
      status.textContent = "Connected.";
      break;
    case "missing":
      status.className = "status bad";
      status.textContent = "Not installed on this computer.";
      detail.textContent = "Install Claude Code, run claude once in a terminal to sign in, then check again.";
      break;
    case "signed-out":
      status.className = "status bad";
      status.textContent = "Installed, but not signed in.";
      detail.textContent = "Run claude once in a terminal to sign in, then check again.";
      break;
    case "error":
      status.className = "status warn";
      status.textContent = "Installed, but it didn't answer as expected.";
      detail.textContent = c.message;
      break;
    default:
      status.className = "status";
      status.textContent = "Checking…";
  }
}

const stillChecking = (c) => c.state === "checking" || c.state === "unknown" || c.checking;

async function load() {
  const s = await window.kh.state();
  $("version").textContent = `${s.productName} ${s.version}`;
  $("account").hidden = !s.signedIn;
  $("login").checked = s.openAtLogin;
  if (s.signedIn && s.claude.state === "ok") {
    $("title").textContent = "Settings";
    $("lede").hidden = true;
  }
  showClaude(s.claude);
  if (stillChecking(s.claude)) setTimeout(refreshClaude, 1500);
}

async function refreshClaude() {
  const s = await window.kh.state();
  showClaude(s.claude);
  if (stillChecking(s.claude)) setTimeout(refreshClaude, 1500);
}

$("claude-again").addEventListener("click", async () => {
  showClaude({ state: "checking" });
  showClaude(await window.kh.checkClaude());
});
$("install").addEventListener("click", () => window.kh.openInstallPage());
$("dashboard").addEventListener("click", () => window.kh.openDashboard());
$("login").addEventListener("change", (e) => window.kh.setOpenAtLogin(e.target.checked));
$("sign-out").addEventListener("click", () => window.kh.signOut());

load();

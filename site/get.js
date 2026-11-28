// The "Get kindahired" section: the early-access form, and a download button for this computer.
(() => {
  // Where the form goes. ?hub=http://localhost:8080 points a local preview at a local hub.
  const hub = new URLSearchParams(location.search).get("hub") || "https://app-kindahired.kindavishal.dev";
  const repo = "kindavishal/kindahired";

  // ---------- Download ----------
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
  const isWindows = /^win/i.test(platform) || /windows/i.test(navigator.userAgent);
  const isLinux = !isWindows && /linux/i.test(platform) && !/android/i.test(navigator.userAgent);
  const main = document.getElementById("dl-main");
  const other = document.getElementById("dl-other");
  const link = (href, text) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    return a;
  };
  const list = (links) => links.flatMap((a, i) => (i === 0 ? [a] : i === links.length - 1 ? [" or ", a] : [", ", a]));
  fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      const asset = (re) => rel?.assets?.find((a) => re.test(a.name))?.browser_download_url;
      const dmg = asset(/\.dmg$/), appImage = asset(/\.AppImage$/), deb = asset(/\.deb$/), exe = asset(/Setup.*\.exe$/);
      const mac = dmg && link(dmg, "Mac"), win = exe && link(exe, "Windows");
      const linux = [appImage && link(appImage, "Linux (.AppImage)"), deb && link(deb, "Linux (.deb)")].filter(Boolean);
      let rest;
      if (isWindows && exe) {
        main.href = exe;
        main.textContent = "Download for Windows";
        rest = [mac, ...linux];
      } else if (isLinux && appImage) {
        main.href = appImage;
        main.textContent = "Download for Linux";
        rest = [deb && link(deb, "the .deb"), mac, win];
      } else if (dmg) {
        main.href = dmg;
        main.textContent = "Download for Mac";
        rest = [win, ...linux];
      } else return;
      rest = rest.filter(Boolean);
      const parts = rest.length ? ["Also for ", ...list(rest), "."] : [];
      if (main.href === exe) parts.push(...(parts.length ? [" "] : []), "Windows may warn the first time you open it: choose More info, then Run anyway.");
      other.replaceChildren(...parts);
    })
    .catch(() => { /* the button keeps pointing at the releases page */ });

  // ---------- Early access ----------
  const form = document.getElementById("ask");
  const note = form.querySelector(".form-note");
  const button = form.querySelector("button");
  const say = (text, bad = false) => {
    note.textContent = text;
    note.className = `form-note${bad ? " bad" : ""}`;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    for (const input of form.querySelectorAll("input[required]")) input.removeAttribute("aria-invalid");
    const missing = [...form.querySelectorAll("input[required]")].find((i) => !i.value.trim());
    if (missing) {
      missing.setAttribute("aria-invalid", "true");
      missing.focus();
      return say(missing.name === "email" ? "Enter your email address." : "Add your LinkedIn profile link.", true);
    }
    button.disabled = true;
    say("Sending…");
    try {
      const res = await fetch(`${hub}/early-access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || "Something went wrong. Try again in a minute.");
      const done = document.createElement("div");
      done.className = "get-done";
      const h = document.createElement("h3");
      h.textContent = "Thanks, you're on the list.";
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = `You'll get an email at ${data.email.trim()} when you're in.`;
      done.append(h, p);
      form.replaceChildren(done);
    } catch (err) {
      button.disabled = false;
      say(err instanceof TypeError ? "Couldn't reach kindahired. Check your connection and try again." : err.message, true);
    }
  });
})();

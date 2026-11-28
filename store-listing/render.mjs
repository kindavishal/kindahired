// Renders the Microsoft Store images into store-listing/out/ at the sizes Partner Center asks for.
//   1. npx tsx store-listing/demo-dashboard.ts   (the real dashboard on made-up data, port 4390)
//   2. node store-listing/render.mjs
// Screenshots are 2560×1440; poster art 1440×2160; box art 2160×2160; tile icons 300, 150 and 71.
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const here = import.meta.dirname;
const out = path.join(here, "out");
const shotsDir = path.join(out, "captures");
await mkdir(shotsDir, { recursive: true });
const DEMO = "http://127.0.0.1:4390";
const FONT = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap">`;

const browser = await chromium.launch();

// ---------- 1. Capture the real dashboard ----------

const app = await browser.newPage({ viewport: { width: 1120, height: 760 }, deviceScaleFactor: 2, colorScheme: "light" });
// The dashboard uses the platform sans, which stands in for Geist; the Store images use Geist itself.
const geist = async () => {
  await app.addStyleTag({ content: `*{font-family:Geist,ui-sans-serif,system-ui,sans-serif!important}` });
  await app.evaluate(() => document.fonts.ready);
};
async function capture(name, url, { scrollTo, clip } = {}) {
  await app.goto(DEMO + url, { waitUntil: "networkidle" });
  await app.addStyleTag({ url: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" });
  await geist();
  if (scrollTo) await app.evaluate((sel) => { const el = document.querySelector(sel); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 24); }, scrollTo);
  const file = path.join(shotsDir, `${name}.png`);
  await app.screenshot({ path: file, clip });
  return file;
}
const cap = {
  home: await capture("home", "/"),
  role: await capture("role", "/o/1"),
  people: await capture("people", "/o/1", { scrollTo: "#people" }),
  interview: await capture("interview", "/interviews/1"),
  fit: await capture("fit", "/o/1", { scrollTo: ".prose, section.block:nth-of-type(3)" }),
};
const settingsHtml = await readFile(path.join(here, "..", "apps", "desktop", "renderer", "setup.html"), "utf8");
const settingsCss = await readFile(path.join(here, "..", "apps", "desktop", "renderer", "setup.css"), "utf8");
const settingsPage = await browser.newPage({ viewport: { width: 480, height: 430 }, deviceScaleFactor: 2, colorScheme: "light" });
await settingsPage.setContent(
  settingsHtml
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace(/<link[^>]+setup\.css[^>]*>/, `<style>${settingsCss}</style>${FONT}<style>*{font-family:Geist,sans-serif!important}</style>`)
    .replace(/<script[^>]*src="setup\.js"[^>]*><\/script>/, ""),
  { waitUntil: "networkidle" },
);
await settingsPage.evaluate(() => {
  const $ = (id) => document.getElementById(id);
  const set = (id, prop, v) => { const el = $(id); if (el) el[prop] = v; };
  set("title", "textContent", "Settings");
  set("lede", "hidden", true);
  set("account", "hidden", false);
  set("login", "checked", true);
  const st = document.querySelector("#claude-status, .status");
  if (st) { st.className = "status ok"; st.textContent = "Connected."; }
  set("claude-detail", "textContent", "Claude Code is signed in. Steps run on your own Claude plan.");
  set("install", "hidden", true);
  set("version", "textContent", "kindahired 0.4.0");
  return document.fonts.ready;
});
cap.settings = path.join(shotsDir, "settings.png");
await settingsPage.screenshot({ path: cap.settings });
await settingsPage.close();

const dataUrl = async (file) => `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
const img = {};
for (const [k, f] of Object.entries(cap)) img[k] = await dataUrl(f);

// ---------- 2. The design pieces ----------

const C = { ink: "#0a0a0a", ink2: "#525252", ink3: "#6b6b6b", paper: "#fafafa", line: "#e5e5e5", green: "#15803d", greenBright: "#4ade80" };
const mark = (ring, tick, size, sw = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 9.5A9 9 0 1 1 15 3.5" stroke="${ring}"/><path d="M7.5 12.5l3.5 3.5L19.5 6" stroke="${tick}"/></svg>`;
const icon = (size, radius = 7) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="${radius}" fill="${C.ink}"/><g transform="translate(4 4)" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 9.5A9 9 0 1 1 15 3.5" stroke="${C.paper}"/><path d="M7.5 12.5l3.5 3.5L19.5 6" stroke="${C.greenBright}"/></g></svg>`;
const lockup = (dark, h) => {
  const [ring, tick, kinda, hired] = dark ? [C.paper, C.greenBright, "#a3a3a3", C.paper] : [C.ink, C.green, C.ink3, C.ink];
  return `<span class="lockup" style="gap:${h * 0.3}px;font-size:${h * 0.72}px">${mark(ring, tick, h)}<span><span style="color:${kinda};font-weight:400">kinda</span><span style="color:${hired};font-weight:700">hired</span></span></span>`;
};

// A Windows 11 window around a capture. `w` is its width in CSS px; the capture keeps its ratio.
const win = (src, { w, title = "kindahired", dark = false, crop } = {}) => `
<div class="win${dark ? " win-dark" : ""}" style="width:${w}px">
  <div class="win-bar">${icon(16, 5)}<span>${title}</span><span class="win-ctl"><i>&#xE921;</i><i>&#xE922;</i><i>&#xE8BB;</i></span>
    <svg class="ctl" width="104" height="14" viewBox="0 0 104 14"><path d="M4 7h10" stroke="currentColor"/><rect x="45" y="2" width="10" height="10" rx="2" fill="none" stroke="currentColor"/><path d="M86 2l10 10M96 2L86 12" stroke="currentColor"/></svg></div>
  <div class="win-body"${crop ? ` style="height:${crop}px"` : ""}><img src="${src}" style="width:100%"></div>
</div>`;

const base = `
${FONT}
<style>
  *{box-sizing:border-box;margin:0}
  html,body{width:var(--w);height:var(--h);overflow:hidden}
  body{font-family:Geist,sans-serif;-webkit-font-smoothing:antialiased;background:${C.paper};color:${C.ink};position:relative}
  .lockup{display:inline-flex;align-items:center;letter-spacing:-0.02em;line-height:1}
  .lockup svg{display:block}
  .kicker{display:inline-flex;align-items:center;gap:10px;font-size:15px;font-weight:500;color:${C.ink3};letter-spacing:.01em}
  .kicker b{width:6px;height:6px;border-radius:99px;background:${C.green}}
  h1{font-size:58px;line-height:1.02;letter-spacing:-0.035em;font-weight:700;text-wrap:balance}
  h1 em{font-style:normal;color:${C.green}}
  .sub{font-size:19px;line-height:1.5;color:${C.ink2};text-wrap:pretty}
  .dark{background:${C.ink};color:${C.paper}}
  .dark .sub{color:#a3a3a3}
  .dark .kicker{color:#a3a3a3}
  .dark h1 em{color:${C.greenBright}}
  .win{border-radius:12px;overflow:hidden;background:#fff;border:1px solid rgb(0 0 0 / .12);
       box-shadow:0 1px 2px rgb(0 0 0 / .06),0 24px 48px -12px rgb(0 0 0 / .22),0 60px 120px -40px rgb(0 0 0 / .25)}
  .win-dark{border-color:rgb(255 255 255 / .14);box-shadow:0 0 0 1px rgb(0 0 0 / .6),0 40px 100px -20px rgb(0 0 0 / .8)}
  .win-bar{height:34px;display:flex;align-items:center;gap:10px;padding:0 0 0 12px;background:#f3f3f3;border-bottom:1px solid ${C.line};font-size:12.5px;color:#1f1f1f}
  .win-bar .win-ctl{display:none}
  .win-bar .ctl{margin-left:auto;margin-right:14px;color:#1f1f1f;stroke-width:1}
  .win-body{overflow:hidden;background:#fafafa}
  .win-body img{display:block}
  .chip{position:absolute;background:#fff;border:1px solid ${C.line};border-radius:14px;padding:16px 18px;
        box-shadow:0 2px 4px rgb(0 0 0 / .04),0 20px 40px -12px rgb(0 0 0 / .25)}
  .chip .label{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.ink3};margin-bottom:8px}
  .badge{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:8px;font-size:14px;font-weight:600}
  .b-ok{background:#f0fdf4;color:${C.green};box-shadow:inset 0 0 0 1px #bbf7d0}
  .b-acc{background:${C.ink};color:${C.paper}}
  .b-warn{background:#fef3c7;color:#92400e;box-shadow:inset 0 0 0 1px #fde68a}
  .glow{position:absolute;border-radius:50%;filter:blur(80px);pointer-events:none}
</style>`;

// Screenshot layout: words on the left, the window bleeding off the right and bottom edges.
const shot = ({ dark = false, title, sub, windowHtml, extra = "" }) => `<!doctype html><html><head>${base}
<style>:root{--w:1280px;--h:720px}
  .copy{position:absolute;left:72px;top:0;bottom:0;width:430px;display:flex;flex-direction:column;justify-content:center;gap:22px}
  .stage{position:absolute;left:560px;top:96px}
  .foot{position:absolute;left:72px;bottom:44px}
</style></head>
<body class="${dark ? "dark" : ""}">
<div class="copy"><h1>${title}</h1><p class="sub">${sub}</p></div>
<div class="stage">${windowHtml}</div>
${extra}
<div class="foot">${lockup(dark, 26)}</div>
</body></html>`;

const scenes = {
  "screenshot-1-pack": shot({
    dark: true,
    title: "Every posting, turned into a pack <em>you can act on.</em>",
    sub: "An honest fit read, the real apply link, a tailored resume, a cover note and the right people to contact.",
    windowHtml: win(img.role, { w: 860, dark: true }),
    extra: `<div class="chip" style="left:432px;top:530px;width:300px">
      <div class="label">The fit read</div>
      <div style="display:flex;gap:8px;margin-bottom:10px"><span class="badge b-ok">Strong fit</span><span class="badge b-warn">Closes in 3 days</span></div>
      <p style="font-size:14px;line-height:1.5;color:#404040">You grew Quarry's community from 1,500 to 18,000: the closest thing on your record to what they want.</p></div>`,
  }),
  "screenshot-2-today": shot({
    title: "One next move, <em>first thing.</em>",
    sub: "Today's list puts what matters first: interviews, then people waiting on you, then roles closing soon. Clear one and the next moves up.",
    windowHtml: win(img.home, { w: 860 }),
  }),
  "screenshot-3-interview": shot({
    title: "Walk into every interview <em>ready.</em>",
    sub: "Who you're meeting, their last message, your notes on the role and a checklist, gathered on one page with a countdown.",
    windowHtml: win(img.interview, { w: 860 }),
  }),
  "screenshot-4-people": shot({
    title: "Reach the right people, <em>note already written.</em>",
    sub: "Each pack finds who's hiring and drafts a short note in your voice. You copy it, open LinkedIn and send it yourself.",
    windowHtml: win(img.people, { w: 860 }),
  }),
  "screenshot-5-tray": `<!doctype html><html><head>${base}
<style>:root{--w:1280px;--h:720px}
  .copy{position:absolute;left:72px;top:0;bottom:0;width:430px;display:flex;flex-direction:column;justify-content:center;gap:22px}
  .desk{position:absolute;left:540px;top:64px;right:0;bottom:-1px;border-radius:16px 0 0 0;overflow:hidden;
        background:radial-gradient(120% 90% at 85% 0%,#dff3e6 0%,#eef3f0 40%,#e9ecef 100%);border:1px solid rgb(0 0 0 / .08)}
  .task{position:absolute;left:0;right:0;bottom:0;height:48px;background:rgb(243 243 243 / .92);backdrop-filter:blur(20px);border-top:1px solid rgb(0 0 0 / .08);display:flex;align-items:center;justify-content:flex-end;gap:16px;padding:0 20px;font-size:12px;color:#1f1f1f}
  .tray-ic{width:34px;height:34px;border-radius:6px;display:grid;place-items:center;background:rgb(0 0 0 / .06)}
  .menu{position:absolute;right:52px;bottom:58px;width:256px;background:#f9f9f9;border:1px solid rgb(0 0 0 / .1);border-radius:8px;padding:4px;
        box-shadow:0 8px 16px rgb(0 0 0 / .14),0 24px 60px -10px rgb(0 0 0 / .25);font-size:13px;color:#1a1a1a}
  .menu div{padding:7px 12px;border-radius:4px}
  .menu .dim{color:#7a7a7a}
  .menu .hi{background:rgb(0 0 0 / .05)}
  .menu hr{border:0;border-top:1px solid rgb(0 0 0 / .08);margin:4px 2px}
  .live{display:inline-block;width:8px;height:8px;border-radius:99px;background:${C.green};margin-right:8px;box-shadow:0 0 0 3px rgb(21 128 61 / .15)}
</style></head><body>
<div class="copy"><h1>Works quietly <em>from your tray.</em></h1>
<p class="sub">The app runs the Claude Code steps on your computer, with your own Claude plan. It prepares everything and never applies or sends anything for you.</p></div>
<div class="desk">
  <div style="position:absolute;left:32px;top:40px">${win(img.settings, { w: 360, title: "kindahired settings" })}</div>
  <div class="menu">
    <div><span class="live"></span>Online, waiting for work</div>
    <div class="dim">3 Claude steps done today</div>
    <hr>
    <div class="hi">Open kindahired</div>
    <div>Pause worker</div>
    <div>Settings…</div>
    <hr>
    <div class="dim">Version 0.4.0</div>
    <hr>
    <div>Quit kindahired</div>
  </div>
  <div class="task"><span>ENG</span><div class="tray-ic">${icon(20, 5)}</div><span style="text-align:right;line-height:1.3">10:42 AM<br>28-11-2026</span></div>
</div>
<div style="position:absolute;left:72px;bottom:44px">${lockup(false, 26)}</div>
</body></html>`,
};

// Poster art (9:16): the promise, with real pieces of the product falling down the page.
scenes["poster-art"] = `<!doctype html><html><head>${base}
<style>:root{--w:720px;--h:1080px}
  .top{position:absolute;left:64px;right:64px;top:84px;display:flex;flex-direction:column;gap:26px}
  h1{font-size:72px}
  .stack{position:absolute;left:64px;top:490px;width:820px}
  .stack .win{position:absolute}
</style></head><body class="dark">
<div class="top">${lockup(true, 40)}
<h1>Prepares everything. <em>Sends nothing.</em></h1>
<p class="sub" style="font-size:22px;max-width:520px">Every job posting, turned into a pack you can act on.</p></div>
<div class="stack">
  ${win(img.home, { w: 760, dark: true })}
</div>
</body></html>`;

// Box art (1:1): the mark, large, on ink.
scenes["box-art"] = `<!doctype html><html><head>${base}
<style>:root{--w:1080px;--h:1080px} body{display:grid;place-items:center}</style></head><body class="dark">
<div style="position:relative">${mark(C.paper, C.greenBright, 560, 2.1)}</div>
</body></html>`;

// ---------- 3. Render ----------

async function render(name, html, w, h, scale) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await p.setContent(html, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: path.join(out, `${name}.png`) });
  await p.close();
}
for (const [name, html] of Object.entries(scenes)) {
  if (name === "poster-art") await render(name, html, 720, 1080, 2);
  else if (name === "box-art") await render(name, html, 1080, 1080, 2);
  else await render(name, html, 1280, 720, 2);
}
// App tile icons: the brand icon, transparent outside its rounded tile.
for (const size of [300, 150, 71]) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(`<style>*{margin:0}body{background:transparent}svg{display:block}</style>${icon(size)}`);
  await p.screenshot({ path: path.join(out, `app-tile-${size}.png`), omitBackground: true });
  await p.close();
}
await browser.close();
console.log("Store images written to store-listing/out/");

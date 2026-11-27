// Exports the kindahired logo as PNGs into site/brand/ with the Playwright already in the project.
// Rebuild: node site/build-logos.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "brand");
await mkdir(out, { recursive: true });

const ink = "#0a0a0a", paper = "#fafafa", quiet = "#6b6b6b", green = "#15803d", greenDark = "#4ade80";
const mark = (ring, tick, size, sw = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 9.5A9 9 0 1 1 15 3.5" stroke="${ring}"/><path d="M7.5 12.5l3.5 3.5L19.5 6" stroke="${tick}"/></svg>`;
const icon = (size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${ink}"/><g transform="translate(4 4)" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 9.5A9 9 0 1 1 15 3.5" stroke="${paper}"/><path d="M7.5 12.5l3.5 3.5L19.5 6" stroke="${greenDark}"/></g></svg>`;
// Lockup: mark plus wordmark, sized by the mark's height. Padding keeps round caps from clipping.
const lockup = (dark, h) => {
  const [ring, tick, kinda, hired] = dark ? [paper, greenDark, "#a3a3a3", paper] : [ink, green, quiet, ink];
  return `<div style="display:inline-flex;align-items:center;gap:${h * 0.3}px;padding:${h * 0.1}px;font-family:Geist,sans-serif;font-size:${h * 0.72}px;letter-spacing:-0.02em;line-height:1">${mark(ring, tick, h)}<span><span style="color:${kinda};font-weight:400">kinda</span><span style="color:${hired};font-weight:700">hired</span></span></div>`;
};

const jobs = [];
for (const s of [64, 128, 256, 512, 1024]) {
  jobs.push([`mark-light-${s}.png`, mark(ink, green, s)]);
  jobs.push([`mark-dark-${s}.png`, mark(paper, greenDark, s)]);
}
for (const s of [16, 32, 48, 180, 192, 512, 1024]) jobs.push([`icon-${s}.png`, icon(s)]);
for (const h of [48, 96, 192]) {
  jobs.push([`lockup-light-${h}.png`, lockup(false, h)]);
  jobs.push([`lockup-dark-${h}.png`, lockup(true, h)]);
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, html] of jobs) {
  await page.setContent(
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;700&display=swap"><style>body{margin:0;background:transparent}#a{display:inline-block}#a>svg{display:block}</style><div id="a">${html}</div>`,
    { waitUntil: "networkidle" },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#a").screenshot({ path: path.join(out, name), omitBackground: true });
}
await browser.close();
console.log(`Wrote ${jobs.length} PNGs to site/brand/`);

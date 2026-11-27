// Draws the placeholder icons as PNGs, with no image tools needed:
//   build/icon.png               1024 px app icon (electron-builder makes the .icns and Linux sizes)
//   assets/trayTemplate.png      16 px macOS menu bar icon (a template: black with alpha), and @2x
//   assets/trayTemplate-off.png  the same, faded, for offline or paused, and @2x
//   assets/tray.png              24 px Linux tray icon, and tray-off.png
// They're placeholders: replace build/icon.png with a real icon before a public release.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size, (y + 0.5) / size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Coverage of a shape at (x, y) in 0..1, softened over `edge` for anti-aliasing.
const smooth = (d, edge) => Math.max(0, Math.min(1, 0.5 - d / edge));
const roundedSquare = (x, y, inset, radius) => {
  const qx = Math.abs(x - 0.5) - (0.5 - inset - radius);
  const qy = Math.abs(y - 0.5) - (0.5 - inset - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
};
// A tick: two thick segments.
const segment = (x, y, ax, ay, bx, by) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - t * dx, py - t * dy);
};
const tick = (x, y, w) => Math.min(segment(x, y, 0.3, 0.52, 0.44, 0.66), segment(x, y, 0.44, 0.66, 0.72, 0.36)) - w;

function appIcon(size) {
  const edge = 1.5 / size;
  return png(size, (x, y) => {
    const body = smooth(roundedSquare(x, y, 0.09, 0.18), edge);
    const mark = smooth(tick(x, y, 0.055), edge);
    // #171717 square (the dashboard's accent) with a white tick.
    const v = Math.round(23 + (255 - 23) * mark);
    return [v, v, v, Math.round(255 * body)];
  });
}

function trayIcon(size, { template, faded }) {
  const edge = 1.2 / size;
  return png(size, (x, y) => {
    const ring = smooth(Math.abs(roundedSquare(x, y, 0.08, 0.22) + 0.06) - 0.06, edge);
    const mark = smooth(tick(x, y, 0.075), edge);
    const a = Math.max(ring, mark) * (faded ? 0.45 : 1);
    return template ? [0, 0, 0, Math.round(255 * a)] : [235, 235, 235, Math.round(255 * a)];
  });
}

mkdirSync(path.join(root, "build"), { recursive: true });
mkdirSync(path.join(root, "assets"), { recursive: true });
writeFileSync(path.join(root, "build", "icon.png"), appIcon(1024));
for (const faded of [false, true]) {
  const suffix = faded ? "-off" : "";
  writeFileSync(path.join(root, "assets", `trayTemplate${suffix}.png`), trayIcon(16, { template: true, faded }));
  writeFileSync(path.join(root, "assets", `trayTemplate${suffix}@2x.png`), trayIcon(32, { template: true, faded }));
  writeFileSync(path.join(root, "assets", `tray${suffix}.png`), trayIcon(24, { template: false, faded }));
}
// The app icon also ships in the app, for the Linux window icon.
writeFileSync(path.join(root, "assets", "icon.png"), appIcon(256));
console.log("Icons written to build/ and assets/.");

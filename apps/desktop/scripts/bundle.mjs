// Bundles the main process (with the worker from ../../src/worker/client.ts) and the preload script.
import { build } from "esbuild";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const main = await build({
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(root, "dist", "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  // Loaded at run time from the app's own node_modules (electron is built in).
  external: ["electron", "electron-updater"],
  metafile: true,
  logLevel: "warning",
});

// The worker must not pull in the engine's config, which loads the repo .env and makes data
// folders next to the code.
const inputs = Object.keys(main.metafile.inputs);
const leaked = inputs.filter((f) => /(^|\/)src\/(config|daemon|db\/)/.test(f) && !f.includes("apps/desktop"));
if (leaked.length) {
  console.error(`The main bundle includes engine modules it must not: ${leaked.join(", ")}`);
  process.exit(1);
}

await build({
  entryPoints: [path.join(root, "src", "preload.ts")],
  outfile: path.join(root, "dist", "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});

console.log(`Bundled dist/main.js (${inputs.length} inputs) and dist/preload.cjs.`);

// Local preview of the landing page: node site/serve.mjs, then open http://localhost:4400
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".js": "text/javascript", ".mjs": "text/javascript" };
const port = Number(process.env.PORT ?? 4400);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const file = path.normalize(path.join(root, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => console.log(`Landing page at http://localhost:${port}`));

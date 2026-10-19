// ci-cd/02: the committed dev server. `npm run dev -- <port>` serves the repo so agents and
// the smoke check share one server that gets MIME types and caching right -- ticket 07's
// designer hit Python's http.server serving .mjs as text/plain on Windows, and a reused port
// serving a stale module graph.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

// The browser requests this on its own for every page load, whether or not the page references
// one. None of the dev pages/fixtures ship a favicon, so both this server and smoke.mjs treat it
// as browser housekeeping rather than a real asset the page asked for.
export const FAVICON_PATH = "/favicon.ico";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

export function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Creates (but does not start) a dev server that serves `root` over plain HTTP,
 * mapping `.mjs`/`.js` to `text/javascript` and sending `Cache-Control: no-store`
 * on every response so a reused port never serves a stale module graph.
 */
export function createDevServer(root = REPO_ROOT) {
  return createServer(async (req, res) => {
    let pathname = "/";
    try {
      const url = new URL(req.url, "http://localhost");
      pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";

      const filePath = path.normalize(path.join(root, pathname));
      const normalizedRoot = path.normalize(root + path.sep);
      if (filePath !== path.normalize(root) && !filePath.startsWith(normalizedRoot)) {
        res.writeHead(403, { "Cache-Control": "no-store" });
        res.end("Forbidden");
        return;
      }

      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        res.writeHead(404, { "Cache-Control": "no-store" });
        res.end("Not found");
        return;
      }

      const body = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Cache-Control": "no-store",
        "Content-Length": body.length,
      });
      res.end(body);
    } catch {
      if (pathname === FAVICON_PATH) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end("Not found");
    }
  });
}

function main() {
  const port = Number(process.argv[2]) || 8124;
  const server = createDevServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`dev server listening on http://localhost:${port}`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}

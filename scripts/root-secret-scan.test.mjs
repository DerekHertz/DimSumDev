// organism-infra/166: guard for the dispatch-context root scan (ADR 0014 decision 5). One tracked text file that matches a
// secret pattern makes every dispatch fall back with secret-in-root and no agent gets Start-here context. Ticket 96 fixed this
// once and it came back, so this fails with the offending path(s) the moment a file would trip the scan.
// Same file set as scripts/dispatch-context.mjs: tracked, outside .scratch/ and .claude/, not binary.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasSecret } from "./exposure.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BOARD_DIRS = [".scratch/", ".claude/"];
const BINARY_EXTS = new Set([
  ".blend", ".blend1", ".glb", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bin", ".zip", ".gz", ".woff", ".woff2",
  ".ttf", ".otf", ".pdf", ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".exr", ".hdr", ".ktx2", ".basis",
]);

function hasNul(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(8192);
    return buf.subarray(0, readSync(fd, buf, 0, 8192, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}

test("no tracked text file outside the board trips the root secret scan", () => {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f && !BOARD_DIRS.some((d) => f.startsWith(d)));
  const offenders = [];
  for (const rel of listed) {
    if (BINARY_EXTS.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(ROOT, rel);
    let body;
    try {
      if (hasNul(abs)) continue;
      body = readFileSync(abs, "utf8");
    } catch {
      continue; // deleted, a symlink to nowhere, a directory (submodule)
    }
    if (hasSecret(body)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `these tracked files trip hasSecret (build fake secrets at runtime instead): ${offenders.join(", ")}`);
});

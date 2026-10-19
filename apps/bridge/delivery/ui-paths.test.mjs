// The tripwire for delivery/plan.mjs UI_PATHS (security review of den-mvp outcome 5, finding 1). The UI build bundles
// every file the UI imports, wherever it lives. A change to such a file that is not counted as UI would merge with no
// security review, no preview and no verdict, and then ship inside the next UI build, in the page that holds the
// user's session. So: every repository file the UI imports is either under UI_PATHS, or a path only the user merges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UI_PATHS, isUiPath, isUserMergePath } from "./plan.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE = /\.(?:mjs|js|jsx|ts|tsx|css)$/;
const SCRIPT = /\.(?:mjs|js|jsx|ts|tsx)$/;
// The ways a file reaches another: import/export ... from, import(), CSS @import and url(), new URL(..., import.meta.url),
// and import.meta.glob (one pattern, or an array of them). Only relative specifiers are followed; a bare one is a package.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']?(\.{1,2}\/[^"')\s;]+)/g;
const CSS_URL = /url\(\s*["']?(\.{1,2}\/[^"')\s]+)/g;
const NEW_URL = /new\s+URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g;
const GLOB = /import\.meta\.glob(?:Eager)?\s*(?:<[^>]*>)?\(\s*(\[[^\]]*\]|["'][^"']*["'])/g;

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const file = path.join(dir, name);
  if (name === "node_modules" || name === "dist") return [];
  return statSync(file).isDirectory() ? walk(file) : [file];
});
const isTest = (file) => /\.test\.mjs$/.test(file);

// A glob as a matcher over files below `dir`: * (one name part), ** (any depth), ? and a literal rest. Negated patterns are skipped.
function globFiles(dir, pattern) {
  if (pattern.startsWith("!")) return [];
  const base = path.resolve(dir, pattern.split(/[*?{[]/)[0].replace(/[^/]*$/, ""));
  const re = new RegExp(`^${path.resolve(dir, pattern).replace(/[.+^$()|\\]/g, "\\$&").replace(/\*\*\//g, "@@DEEP@@").replace(/\*\*/g, "@@ANY@@").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/@@DEEP@@/g, "(?:.*/)?").replace(/@@ANY@@/g, ".*")}$`);
  if (!existsSync(base) || !statSync(base).isDirectory()) return [];
  return walk(base).filter((file) => re.test(file));
}

// Every file under `repo` reachable from the files in `start`, by any of the forms above (tests left out: they are not bundled).
export function bundled(repo, start) {
  const seen = new Set();
  const todo = start.filter((f) => SOURCE.test(f) && !isTest(f));
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!SOURCE.test(file)) continue;
    const text = readFileSync(file, "utf8");
    const here = path.dirname(file);
    const specs = [IMPORT, NEW_URL, ...(file.endsWith(".css") ? [CSS_IMPORT, CSS_URL] : [])].flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));
    if (SCRIPT.test(file)) {
      for (const [, arg] of text.matchAll(GLOB)) for (const [, pattern] of arg.matchAll(/["']([^"']*)["']/g)) todo.push(...globFiles(here, pattern));
    }
    for (const spec of specs) {
      const target = path.resolve(here, spec.split(/[?#]/)[0]);
      // An extensionless import of a TypeScript file resolves the way the bundler does.
      const found = [target, ...[".ts", ".tsx", ".mjs", ".js", ".jsx"].map((ext) => target + ext)].find((f) => existsSync(f) && statSync(f).isFile());
      if (found) todo.push(found);
    }
  }
  return [...seen].map((file) => path.relative(repo, file).split(path.sep).join("/"));
}

const uiFiles = () => bundled(REPO, walk(path.join(REPO, "apps/ui/src")));

test("every file the UI bundles is a UI path or one only the user merges", () => {
  const files = uiFiles();
  assert.ok(files.length > 50 && files.some((f) => f.startsWith("apps/ui/src/")), "the walk found the UI's sources");
  const outside = files.filter((f) => !f.startsWith("apps/ui/"));
  assert.ok(outside.some((f) => f.startsWith("packages/")), "the UI does import shared packages (the reason for this test)");
  const uncovered = files.filter((f) => !isUiPath(f) && !isUserMergePath(f));
  assert.deepEqual(uncovered, [], `add the folder of each to UI_PATHS in delivery/plan.mjs (now ${JSON.stringify(UI_PATHS)}), so a change to it is reviewed and previewed`);
});

test("what counts as a UI path", () => {
  for (const file of ["apps/ui/src/App.jsx", "apps/ui/vite.config.mjs", "apps/ui/index.html", "packages/board-refs/src/compare-refs.mjs"]) assert.equal(isUiPath(file), true, file);
  for (const file of ["apps/bridge/server.mjs", "apps/uix/a.mjs", "docs/apps/ui/a.md", "packages", "README.md", undefined, 7]) assert.equal(isUiPath(file), false, String(file));
});

test("the walk follows every import form to a file outside the UI paths", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "ui-paths-"));
  try {
    const put = (rel, text = "export const x = 1;\n") => {
      mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      writeFileSync(path.join(repo, rel), text);
      return path.join(repo, rel);
    };
    const entry = put("apps/ui/src/main.jsx", [
      'import "./style.css";',
      'import "./typed";',
      'const mods = import.meta.glob("./plugins/*.js");',
      'const eager = import.meta.glob(["./more/**/*.mjs", "!./more/skip.mjs"], { eager: true });',
      'export const logo = new URL("../../../outside/logo.svg", import.meta.url);',
      "",
    ].join("\n"));
    put("apps/ui/src/style.css", '@import "../../../outside/base.css";\n.a { background: url("../../../outside/pic.png"); }\n');
    put("apps/ui/src/typed.tsx", 'import { y } from "../../../outside/typed-dep.ts";\nexport { y };\n');
    put("apps/ui/src/plugins/p.js", 'import "../../../../outside/from-glob.mjs";\n');
    put("apps/ui/src/more/deep/q.mjs");
    put("outside/logo.svg", "<svg/>");
    put("outside/base.css", '.b { background: url("./nested.woff"); }\n');
    put("outside/nested.woff", "w");
    put("outside/pic.png", "p");
    put("outside/typed-dep.ts", "export const y = 2;\n");
    put("outside/from-glob.mjs");
    const files = bundled(repo, [entry]);
    const outside = files.filter((f) => !f.startsWith("apps/ui/")).sort();
    assert.deepEqual(outside, ["outside/base.css", "outside/from-glob.mjs", "outside/logo.svg", "outside/nested.woff", "outside/pic.png", "outside/typed-dep.ts"]);
    assert.ok(files.includes("apps/ui/src/more/deep/q.mjs"), "a glob with ** reaches a nested file");
    assert.ok(outside.every((f) => !isUiPath(f) && !isUserMergePath(f)), "the tripwire's own check would fail on each of them");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

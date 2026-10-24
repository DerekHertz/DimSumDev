// den-v1/08: the UI ships only what main.jsx reaches. After the market scene is
// removed, every file under apps/ui/src and apps/ui/public is either reachable
// from the entry, or is a test (or a helper only tests use) of a reachable module.
// The import graph is built from the sources, never from file names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const UI = dirname(fileURLToPath(import.meta.url));
const SRC = join(UI, "src");
const PUBLIC = join(UI, "public");
const ROOT = resolve(UI, "..", "..");
const ENTRY = join(SRC, "main.jsx");
const CODE_EXT = new Set([".js", ".jsx", ".mjs", ".css", ".json"]);
const isTest = (f) => /\.test\.mjs$/.test(f);

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).split("\\").join("/");

// Resolve a relative specifier found in `from` to an existing file, trying
// the usual extensions and index files.
function resolveSpec(from, spec) {
  const base = resolve(dirname(from), spec.split("?")[0].split("#")[0]);
  const tries = [base, ...[".mjs", ".js", ".jsx", ".css"].map((e) => base + e)];
  for (const t of tries) if (existsSync(t) && statSync(t).isFile()) return t;
  return null;
}

// Every file a source file names: static and dynamic imports, CSS @import and
// url(), and any "./x" or "../x" string literal (covers readFileSync(new URL(...))
// and fetch of public assets). Root-absolute "/models/..." strings map to public/.
function referencedFiles(file) {
  if (!CODE_EXT.has(extname(file))) return [];
  const text = readFileSync(file, "utf8");
  const found = new Set();
  const rels = text.matchAll(/["'`(](\.{1,2}\/[^"'`)\s]+)["'`)]/g);
  for (const m of rels) {
    const r = resolveSpec(file, m[1]);
    if (r) found.add(r);
  }
  const abs = text.matchAll(/["'`(](\/(?:den|models|textures|assets|fonts)\/[^"'`)\s]+)["'`)]/g);
  for (const m of abs) {
    const p = join(PUBLIC, m[1]);
    if (existsSync(p) && statSync(p).isFile()) found.add(p);
  }
  return [...found];
}

// A browser test that serves the UI with apps/ui/vite.config.mjs (dev or production)
// and drives the mounted App in Chromium tests reachable code through the entry,
// even though it imports no UI module. Such a test is always kept.
function mountsLiveApp(file) {
  if (!isTest(file)) return false;
  const text = readFileSync(file, "utf8");
  if (!/apps\/ui\/vite\.config\.mjs/.test(text) || !/\.goto\s*\(/.test(text)) return false;
  if (/createServer\s*\(/.test(text)) return true;
  return /\bbuild\s*\(/.test(text) && /\bpreview\s*\(/.test(text)
    && /\bchromium\.launch\s*\(/.test(text) && /\.newContext\s*\(/.test(text) && /\.newPage\s*\(/.test(text);
}

test("live-App recognition accepts UI dev and production browser sources and rejects incomplete lookalikes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "live-app-recognition-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const browserSetup = `
    import { chromium } from 'playwright';
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
  `;
  const production = `
    import { build, preview } from 'vite';
    const config = { configFile: 'apps/ui/vite.config.mjs', configLoader: 'native' };
    await build(config);
    const server = await preview({ ...config, preview: { port: 0 } });
    ${browserSetup}
    await page.goto(server.resolvedUrls.local[0]);
  `;
  const development = `
    import { createServer } from 'vite';
    const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native' });
    await server.listen();
    ${browserSetup}
    await page.goto(server.resolvedUrls.local[0]);
  `;
  const cases = [
    ["existing createServer browser route", development, true],
    ["production build plus preview browser route", production, true],
    ["build only without preview", production.replace("const server = await preview({ ...config, preview: { port: 0 } });", ""), false],
    ["preview server without navigation", production.replace("await page.goto(server.resolvedUrls.local[0]);", ""), false],
    ["development server without navigation", development.replace("await page.goto(server.resolvedUrls.local[0]);", ""), false],
    ["preview with a different Vite config", production.replace("apps/ui/vite.config.mjs", "apps/other/vite.config.mjs"), false],
    ["generic preview without the UI config", production.replace("configFile: 'apps/ui/vite.config.mjs', ", ""), false],
    ["preview and navigation without browser page setup", production.replace(browserSetup, ""), false],
  ];
  for (const [name, source, expected] of cases) {
    await t.test(name, () => {
      const file = join(dir, `${name.replaceAll(/[^a-z]+/gi, "-")}.test.mjs`);
      writeFileSync(file, source);
      assert.equal(mountsLiveApp(file), expected, name);
    });
  }
});

function reachableFromEntry() {
  const seen = new Set();
  const queue = [ENTRY];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const n of referencedFiles(f)) if (!seen.has(n)) queue.push(n);
  }
  return seen;
}

// den-layout/02: PR #162's restaurant scene replaces the procedural Den.jsx. The ported scene and review
// modules are reached from main.jsx (whatever component hosts them), and the old den renderer is not.
test("the live frontend reaches the native Meshy world and its local model manifest", () => {
  const reach = reachableFromEntry();
  const names = [...reach].map(rel);
  assert.ok(names.includes("apps/ui/src/App.jsx"), "App.jsx is reachable");
  assert.ok(names.includes("apps/ui/src/scene/scene-from-state.mjs"), "scene-from-state is reachable");
  const ported = [
    "apps/ui/src/scene/meshy/MeshyDen.jsx",
    "apps/ui/src/scene/meshy/world.mjs",
    "apps/ui/src/scene/meshy/actors.mjs",
    "apps/ui/src/scene/meshy/approved-navigation.mjs",
    "apps/ui/public/den/manifest.json",
  ];
  const unreached = ported.filter((p) => !names.includes(p));
  assert.deepEqual(unreached, [], "ported modules main.jsx does not reach");
  // den-mvp/25: the village replaces the old den; its scene code and dressing are deleted.
  const goneWithTheOldDen = ["layout", "leisure", "construction-pads", "landscape", "walking-panda", "dining-table", "dragon-dance"]
    .map((n) => `apps/ui/src/review/${n}.mjs`).filter((p) => existsSync(join(ROOT, p)));
  assert.deepEqual(goneWithTheOldDen, [], "old den modules are removed");
  assert.ok(!names.includes("apps/ui/src/scene/procedural/Den.jsx"), "the old procedural Den.jsx must not be reachable (no path renders the old den)");
  assert.ok(!names.includes("apps/ui/src/scene/procedural/RestaurantDen.jsx"), "the replaced scene is not bundled");
});

test("no file under apps/ui/src or apps/ui/public is unreachable from main.jsx, except tests of reachable modules", () => {
  const reach = reachableFromEntry();
  const all = [...walk(SRC), ...walk(PUBLIC)];
  const tests = all.filter((f) => isTest(f));

  // A fixture or helper is test support; any other unreachable module is dead code.

  // A test is kept when it names at least one reachable module, or when it mounts
  // the live App through the vite config. (A test that still names a deleted
  // module fails on its own when it runs.)
  const keptTests = new Set(
    tests.filter((t) => {
      const seen = new Set(), queue = referencedFiles(t);
      while(queue.length){
        const file=queue.pop();
        if(reach.has(file))return true;
        if(seen.has(file))continue;
        seen.add(file);
        if(/(?:test-fixture|test-support)/.test(file))queue.push(...referencedFiles(file));
      }
      return mountsLiveApp(t);
    }),
  );

  // Tests may retain reference scene implementations for regression comparisons.
  // Follow their dependency graph too; none of these modules enters the UI bundle.
  const keptHelpers = new Set();
  const queue = [...keptTests];
  while (queue.length) {
    for (const r of referencedFiles(queue.pop())) if (!reach.has(r) && !keptHelpers.has(r)) {
      keptHelpers.add(r); queue.push(r);
    }
  }

  const orphans = all
    .filter((f) => !/\/(OFL|LICENSE)[^/]*$/.test(f))
    .filter((f) => rel(f) !== "apps/ui/src/demo/README.md") // den-v1/09: the note on how to re-record the Demo mode fixture
    .filter((f) => !reach.has(f) && !keptTests.has(f) && !keptHelpers.has(f))
    .map(rel)
    .sort();
  assert.deepEqual(orphans, [], `unreachable from apps/ui/src/main.jsx:\n  ${orphans.join("\n  ")}`);
});

test("browser tests that mount the live App survive the removal (they test reachable code)", () => {
  // Literal list from the pre-removal tree: each drives the mounted App in
  // Chromium (Cards.jsx approve/deny keys, tally expand) and passes without the market scene.
  const mustRemain = [
    "src/overlay/floating-cards.test.mjs",
    "src/scene/tally-expand.test.mjs",
  ];
  const missing = mustRemain.filter((p) => !existsSync(join(UI, p)));
  assert.deepEqual(missing, [], "restore these live-App browser tests (do not delete them with the market scene)");
  for (const p of mustRemain) {
    if (existsSync(join(UI, p))) assert.ok(mountsLiveApp(join(UI, p)), `${p} is recognised as mounting the live App`);
  }
});

test("the market scene modules are gone", () => {
  const gone = [
    "src/scene/Den.jsx",
    "src/scene/Market.jsx",
    "src/scene/Backdrop.jsx",
    "src/scene/CameraRig.jsx",
    "src/scene/dev-scene.mjs",
    "src/scene/dev-scene.html",
    "src/scene/headgear.mjs",
    "src/scene/bao-rig.fixture.mjs",
    "src/assets/panda-contract.mjs",
    "src/assets/prop-placement.mjs",
  ];
  const present = gone.filter((p) => existsSync(join(UI, p)));
  assert.deepEqual(present, []);
});

test("all shipped model files belong to the audited Den manifest", () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .filter((p) => existsSync(join(ROOT, p)));
  const manifest = JSON.parse(readFileSync(join(PUBLIC, 'den/manifest.json'), 'utf8'));
  const declared = new Set(Object.values(manifest.assets).map(a => `apps/ui/public${a.url}`));
  const glbs = tracked.filter((p) => /\.glb(?:\.gz)?$/i.test(p) && !p.startsWith(".scratch/"));
  assert.deepEqual(glbs.filter(p => !declared.has(p)), []);
  assert.equal(declared.size, 38);
  assert.ok(!Object.keys(manifest.assets).some(key=>key.startsWith('scenery.')), 'structures are authored as lightweight Three.js geometry');
  for (const p of declared) assert.ok(existsSync(join(ROOT, p)), `packaged asset exists: ${p}`);
});

test("apps/ui/public/models holds no glbs or textures", () => {
  const left = walk(join(PUBLIC, "models")).map(rel);
  assert.deepEqual(left, []);
});

test("live docs name no file that no longer exists (README, docs/agents, the panda sources README)", () => {
  const docs = [
    join(ROOT, "README.md"),
    join(UI, "assets-src", "panda", "README.md"),
    ...walk(join(ROOT, "docs", "agents")).filter((f) => f.endsWith(".md")),
  ].filter((f) => existsSync(f));
  const missing = [];
  for (const doc of docs) {
    const text = readFileSync(doc, "utf8");
    for (const m of text.matchAll(/`((?:apps|packages|scripts)\/[A-Za-z0-9_./*-]+\.(?:mjs|jsx|js|html|glb))`/g)) {
      const p = m[1];
      if (p.includes("*")) continue; // globs name a family, not one file
      if (!existsSync(join(ROOT, p))) missing.push(`${rel(doc)}: ${p}`);
    }
  }
  assert.deepEqual(missing, []);
});

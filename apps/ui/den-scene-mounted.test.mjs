// The full-window shell mounts its live rail, sheets, native Meshy scene and local model package.
// Retain the previous standalone-build removal checks and legacy pure scene regressions.
// Browser checks use real compressed models; only bridge responses and WebGL drawing are stubbed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { buildLaunchOptions } from "../ci-cd/launch-options.mjs";
import { lightenScene } from "../ci-cd/light-scene.mjs";
import { cameraConfig } from "./src/scene/procedural/camera.mjs";
import { DEN_TARGET } from "./src/scene/procedural/bindings.mjs";

const UI = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(UI, "..", "..");

// ---------------------------------------------------------------- criterion 2: the standalone review build is gone

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("review:dev and review:build scripts are gone", () => {
  assert.equal(pkg.scripts["review:dev"], undefined);
  assert.equal(pkg.scripts["review:build"], undefined);
});

test("the standalone review build's files are gone: vite config, html entry, build script, entry module", () => {
  const present = [
    "apps/ui/review.vite.config.mjs",
    "apps/ui/review/index.html",
    "scripts/build-den-review.mjs",
    "apps/ui/src/review/main.jsx",
  ].filter((p) => existsSync(join(ROOT, p)));
  assert.deepEqual(present, []);
});

test("every file path a package.json script names exists (no script references a removed file)", () => {
  const missing = [];
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const m of command.matchAll(/(?:^|[\s"'=])((?:apps|packages|scripts)\/[A-Za-z0-9_./-]+\.(?:mjs|js|jsx|json|html))(?=$|[\s"'])/g)) {
      if (!existsSync(join(ROOT, m[1]))) missing.push(`${name}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("live docs do not tell anyone to run the removed review scripts", () => {
  const walk = (dir) =>
    !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const docs = [join(ROOT, "README.md"), ...walk(join(ROOT, "docs", "agents")), ...walk(join(UI, "assets-src"))].filter((f) => f.endsWith(".md") && existsSync(f));
  const stale = docs.filter((f) => /review:(dev|build)\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(ROOT.length + 1));
  assert.deepEqual(stale, []);
});

// ---------------------------------------------------------------- criterion 4: PR #162's three tests pass on main in time

test("PR #162's agents, review and restaurant test files pass on main, in one process under 90 s", () => {
  const files = [
    "apps/ui/src/review/agents.test.mjs",
    "apps/ui/src/review/review.test.mjs",
    "apps/ui/src/scene/procedural/restaurant.test.mjs",
  ];
  for (const f of files) assert.ok(existsSync(join(ROOT, f)), `${f} exists`);
  // A nested node --test must not inherit the outer runner's context, or it prints no TAP summary.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--test", ...files], { cwd: ROOT, env, encoding: "utf8", timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
  const seconds = (Date.now() - started) / 1000;
  assert.equal(run.error, undefined, `the run did not time out (took ${seconds}s)`);
  assert.equal(run.status, 0, `exit ${run.status}\n${(run.stdout || "").split("\n").filter((l) => /^(not ok|# (pass|fail))/.test(l)).join("\n")}`);
  assert.match(run.stdout, /# fail 0\b/);
  assert.match(run.stdout, /# skipped 0\b/);
  assert.match(run.stdout, /# tests 16\b/, "all 16 tests of the three files run");
});

// ---------------------------------------------------------------- criterion 1: the live app mounts the ported scene

let server;
let browser;
let base;

before(async () => {
  server = await createServer({ configFile: "apps/ui/vite.config.mjs", configLoader: "native", server: { port: 0, host: "127.0.0.1" }, logLevel: "silent" });
  await server.listen();
  base = server.resolvedUrls.local[0];
  browser = await chromium.launch(buildLaunchOptions());
}, { timeout: 120000 });

after(async () => {
  await browser?.close();
  await server?.close();
});

const snapshot = { schema: 1, seq: 1, tickets: [], agents: [], frontier: [], usage: null, requests: [] };
const assets = JSON.parse(readFileSync(join(UI, 'public/den/manifest.json'), 'utf8')).assets;

async function openGarden({ viewport = { width: 1440, height: 900 }, failModels = false, snapshot: initialSnapshot = snapshot, signedIn = false, frameDelayMs = 100, snapshotDelayMs = 0 } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await lightenScene(context, { frameDelayMs });
  if (signedIn) await context.addInitScript(() => sessionStorage.setItem('den.session-token', 'tok-garden-profile-qa'));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [], loaded = [], modelResponses = [], mutations = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { loaded.push(new URL(request.url()).pathname); if (!["GET", "HEAD"].includes(request.method())) mutations.push({ path: new URL(request.url()).pathname, method: request.method() }); });
  page.on("response", response => { if (new URL(response.url()).pathname.startsWith('/den/models/')) modelResponses.push(response); });
  await page.addInitScript(({snap, snapshotDelayMs}) => {
    window.__eventStreams = 0;
    class FakeEventSource {
      constructor() {
        window.__eventStreams++;
        this.l = {};
        window.__pushGardenSnapshot = next => {
          const deliver = () => { for (const listener of this.l.snapshot ?? []) listener({ data: JSON.stringify(next) }); };
          if (snapshotDelayMs) setTimeout(deliver, snapshotDelayMs); else deliver();
        };
        setTimeout(() => {
          this.onopen?.();
          for (const f of this.l.snapshot ?? []) f({ data: JSON.stringify(snap) });
        }, 0);
      }
      addEventListener(type, fn) { (this.l[type] ??= []).push(fn); }
      close() {}
    }
    window.EventSource = FakeEventSource;
  }, {snap:initialSnapshot, snapshotDelayMs});
  await page.route(url => url.pathname === '/state', route => route.fulfill({ json: initialSnapshot }));
  await page.route(url => url.pathname === '/metrics', route => route.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  await page.route(url => url.pathname === '/requests', route => route.fulfill({ json: [] }));
  await page.route(url => url.pathname === '/session', route => route.fulfill({ status: 404, json: {} }));
  await page.route(url => url.pathname.startsWith('/conversations/'), route => route.fulfill({ json: { entries: [], more: false } }));
  await page.route(url => url.pathname === '/tasks' || /^\/agents\//.test(url.pathname), route => route.fulfill({ status: 503, json: { error: 'No task may start in this test.' } }));
  await page.route(url => url.pathname === '/library', route => route.fulfill({ json: { connections: [], skills: [{ kind: 'skill', name: 'garden-qa-marker', description: 'The live Library response.', roles: ['qa'] }] } }));
  if (failModels) await page.route(url => failModels === true ? url.pathname.startsWith('/den/models/') : url.pathname === failModels, route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto(base);
  return { context, page, errors, loaded, modelResponses, mutations };
}

const ready = page => page.waitForFunction(() => document.querySelector('.den-entry button') && document.querySelector('.den-entry button').getAttribute('aria-disabled') !== 'true', null, { timeout: 60000 });

test("the native plush garden loads Balanced Bao and the shared role wardrobe without an iframe or page error", { timeout: 90000 }, async () => {
  const { context, page, errors, loaded, modelResponses } = await openGarden();
  try {
    await ready(page);
    const native = ['/src/scene/meshy/MeshyDen.jsx', '/src/scene/meshy/world.mjs', '/src/scene/meshy/actors.mjs', '/src/scene/meshy/plush/assembly.mjs', '/src/scene/meshy/role-outfits.mjs', '/src/scene/meshy/role-headwear.mjs'];
    assert.deepEqual(native.filter(path => !loaded.includes(path)), [], 'the native Meshy world is loaded');
    assert.ok(!loaded.includes('/src/scene/procedural/RestaurantDen.jsx'), 'old procedural scene is not mounted');
    assert.equal(await page.locator('iframe').count(), 0, 'no embedded preview server');
    assert.equal(await page.locator('.forest-canvas canvas').count(), 1);
    assert.equal(Object.keys(assets).length, 24, 'only retained character, prop, wardrobe and vegetation models are shipped (team-and-den-ux/23 adds two species)');
    assert.deepEqual(Object.keys(assets).filter(key => key.startsWith('scenery.')), [], 'buildings and furniture use procedural geometry');
    assert.equal(loaded.some(path => path.startsWith('/den/models/scenery/')), false, 'no removed scenery download');
    const required = ['bao','wardrobe.developer-vest','wardrobe.qa-scarf','wardrobe.developer-headphones'];
    assert.deepEqual(required.filter(id=>!loaded.includes(assets[id].url)), [], 'the approved body and shared wardrobe load locally');
    assert.equal(modelResponses.length, 6, 'authored scenery and tools need only the four shared models plus the two species (team-and-den-ux/23)');
    assert.deepEqual(['characters.developer','characters.technical-writer'].filter(id=>!loaded.includes(assets[id].url)), [], 'both species load locally');
    const scene = await page.evaluate(async()=>{
      const url=performance.getEntriesByType('resource').find(e=>e.name.includes('react-three_fiber.js')).name;
      const {_roots}=await import(url);
      const {createGardenNavigation}=await import('/src/scene/meshy/garden-navigation.mjs');
      const {gardenRoute}=await import('/src/scene/meshy/garden-route.mjs');
      const world=_roots.get(document.querySelector('canvas')).store.getState().scene.getObjectByName('Dim Sum Dev · plush bamboo garden');
      const roles=[],actorKeys=[],skeletons=new Set(),tools=[],claudeTools=[],assets={};let landscape;
      world.traverse(n=>{
        if(n.userData.actorKey){roles.push(n);actorKeys.push(n.userData.actorKey);if(n.userData.runtime==='claude'){const tools=[];n.traverse(child=>{if(child.userData.tool)tools.push(child.userData.tool);});claudeTools.push({role:n.userData.roleId,species:n.userData.species||null,tools});}}
        if(n.isSkinnedMesh)skeletons.add(n.skeleton);
        if(n.userData.tool)tools.push(n.userData.tool);
        if(n.userData.placeId==='grove')landscape={root:n};else if(n.userData.placeId)assets[n.userData.placeId]={root:n};
      });
      const nav=createGardenNavigation({root:world,assets,landscape});
      const coordinatorTools=Object.fromEntries(roles.filter(n=>n.userData.roleId==='orchestrator').map(n=>{const tools=new Set();n.traverse(child=>{if(child.userData.tool)tools.add(child.userData.tool);});return [n.userData.actorKey,[...tools]];}));
      const routes=roles.map(n=>({role:n.userData.roleId,out:gardenRoute(nav,n.position,{x:-3.5,z:3.15}).length,home:gardenRoute(nav,{x:-3.5,y:.26,z:3.15},n.position).length}));
      const table=world.getObjectByName('Round table and legs');let bounds;table.traverse(n=>{if(!n.isMesh)return;n.geometry.computeBoundingBox();const b=n.geometry.boundingBox.clone().applyMatrix4(n.matrixWorld);if(bounds)bounds.union(b);else bounds=b;});const tableSize=bounds.getSize(table.position.clone()).toArray();
      return {roles:roles.map(n=>n.userData.roleId),actorKeys,tools,claudeTools,coordinatorTools,skeletons:skeletons.size,routes,tableSize,susan:!!world.getObjectByName('Lazy susan'),places:world.userData.presentationLayout.structurePositions};
    });
    assert.equal(new Set(scene.roles).size,18);
    assert.equal(new Set(scene.actorKeys).size,32,'each permanent runtime resident has a distinct actor key');
    // team-and-den-ux/23: a species carries its props in its mesh (the pouch, the book and brush) instead of a paw tool.
    assert.deepEqual(scene.claudeTools.filter(t=>t.species).map(t=>[t.role,t.species,t.tools.length]).toSorted(),[['developer','red-panda',0],['technical-writer','cloud-dragon',0]]);
    const pandas=scene.claudeTools.filter(t=>!t.species);
    // A placeholder kit nests the borrowed kit's name, so compare each role's own (root) tool.
    assert.ok(pandas.every(t=>t.tools.length>0),'every other Claude permanent role holds a paw tool');
    assert.equal(new Set(pandas.map(t=>t.tools[0])).size,pandas.length,'each other Claude permanent role has a distinct paw tool');
    // 19 before team-and-den-ux/23: the writer's own scroll left with the cloud dragon; the developer's tablet stays in the code reviewer's placeholder kit.
    assert.equal(new Set(scene.tools).size,18,'Jiao adds her distinct approved coordinator tool');
    assert.ok(scene.tools.includes('Order notebook'));
    assert.deepEqual(scene.coordinatorTools,{orchestrator:['Bamboo fan'],'codex:orchestrator':['Order notebook']},'Bao and Jiao keep their distinct approved tools');
    assert.equal(scene.skeletons,47,'32 residents and 15 scenery pandas have independent skeletons');
    assert.equal(scene.places.length,10);
    assert.deepEqual(scene.routes.filter(r=>!r.out||!r.home),[],'every workstation connects to the meeting and back over actual walking surfaces');
    assert.ok(scene.tableSize[0]>=4&&scene.tableSize[1]>=1&&scene.tableSize[2]>=2.3,'the batched meeting table and legs remain visible');
    assert.equal(scene.susan,true,'the tea tray still turns toward the meeting speaker');
    for (const response of modelResponses) assert.equal(response.status(), 200, response.url());
    const bytes = await modelResponses.find(response => new URL(response.url()).pathname === assets.bao.url).body();
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'glTF', 'Chromium exposes the real decoded GLB model bytes');
    const packaged = readFileSync(join(UI, 'public', assets.bao.url));
    assert.equal(packaged[0], 0x1f, 'the checked-in model is gzip compressed');
    assert.equal(packaged[1], 0x8b);
    assert.equal(await page.evaluate(() => window.__eventStreams), 1, 'one shared live stream');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("phone shell keeps the scene and Team sheet within the viewport and lists all thirty-two charter roles", { timeout: 90000 }, async () => {
  const { context, page, errors } = await openGarden({ viewport: { width: 390, height: 844 } });
  try {
    await ready(page);
    await page.locator('[data-rail="team"]').click();
    const residents = page.getByRole('list', { name: 'Residents and visitors' });
    await residents.waitFor({ state: 'visible' });
    assert.equal(await residents.getByRole('button').count(), 32, 'all seated charter roles');
    for (const role of ['The Code Reviewer', 'The Release Manager', 'The SRE', 'The Technical Writer']) {
      assert.equal(await residents.getByRole('button', { name: new RegExp(`^${role}`) }).count(), 2, `${role} is listed for both runtimes`);
    }
    const layout = await page.evaluate(() => {
      const scene = document.querySelector('main[aria-label="Den scene"]').getBoundingClientRect();
      const sheet = document.querySelector('[data-sheet="topic"]').getBoundingClientRect();
      const rail = document.querySelector('.den-rail').getBoundingClientRect();
      return { scene: { left: scene.left, right: scene.right }, sheet: { left: sheet.left, right: sheet.right }, rail: { left: rail.left, right: rail.right }, viewport: innerWidth, bodyWidth: document.body.scrollWidth, shellWidth: document.querySelector('.forest-shell').scrollWidth };
    });
    assert.ok(layout.sheet.left >= layout.rail.right, 'topic sheet starts after the rail');
    assert.ok(layout.scene.left >= layout.rail.right && layout.scene.right <= layout.viewport);
    assert.ok(layout.sheet.right <= layout.viewport);
    assert.ok(layout.bodyWidth <= layout.viewport && layout.shellWidth <= layout.viewport, JSON.stringify(layout));
    assert.equal(await page.evaluate(() => window.__eventStreams), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a failed model load explains the garden failure and leaves the Team rail entry available", { timeout: 60000 }, async () => {
  const { context, page, errors } = await openGarden({ failModels: true });
  try {
    const alert = page.getByRole('alert').filter({ hasText: 'garden models could not load' });
    await alert.waitFor({ state: 'visible' });
    assert.match(await alert.innerText(), /Your board controls are still available on the rail/);
    assert.equal(await page.locator('.den-entry button').getAttribute('aria-disabled'), 'true');
    await page.locator('[data-rail="team"]').click();
    assert.equal(await page.getByRole('list', { name: 'Residents and visitors' }).getByRole('button').count(), 32);
    assert.equal(await page.evaluate(() => window.__eventStreams), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

function screenPoint(box, x, y, z) {
  const camera = cameraConfig({ width: box.width, height: box.height });
  const scale = box.height / (camera.top - camera.bottom), pitch = Math.atan(1 / Math.SQRT2);
  return { x: box.x + box.width / 2 + scale * (x - DEN_TARGET[0]), y: box.y + box.height / 2 + scale * ((z - DEN_TARGET[2]) * Math.sin(pitch) - (y - DEN_TARGET[1]) * Math.cos(pitch)) };
}

test("opening Work from walk mode keeps walk mode active", { timeout: 90000 }, async () => {
  const { context, page, errors } = await openGarden({ frameDelayMs: 500 });
  try {
    await ready(page);
    const enter = page.locator('.den-entry button').first();
    await enter.click();
    await page.waitForFunction(() => document.querySelector('.den-entry button').getAttribute('aria-pressed') === 'true');
    await page.keyboard.press('Tab'); // free the cursor while staying in walk mode so the rail can be used
    await page.locator('[data-rail="work"]').click();
    const work = page.locator('[data-sheet="topic"]');
    await work.getByRole('heading', { name: 'Work', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await enter.getAttribute('aria-pressed'), 'true', 'opening a sheet does not leave walk mode');
    assert.equal(await page.locator('.den-shell').evaluate(el => el.classList.contains('den-visiting')), true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await work.isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("the physical Library opens its sheet and preserves Bao's side conversation", { timeout: 90000 }, async () => {
  const { context, page, errors } = await openGarden();
  try {
    await ready(page);
    await page.locator('[data-rail="team"]').click();
    await page.getByRole('list', { name: 'Residents and visitors' }).getByRole('button', { name: /^The Maker, developer, Claude, .*current project identity unavailable, At home$/ }).click();
    await page.getByRole('region', { name: 'Panda profiles' }).getByRole('heading', { name: 'The Maker', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('region', { name: 'Selected panda' }).count(), 0, 'portrait selection stays in its profile');
    await page.locator('.den-bar').getByRole('button', { name: /Talk to Bao/ }).click();
    await page.locator('[data-sheet="side"]').waitFor({ state: 'visible' });
    await page.locator('[data-rail="team"]').click(); // uncover the Library roof before clicking it
    // Click the actual roof at the authored Library position, using the same camera projection as the garden.
    const box = await page.locator('.forest-canvas').boundingBox();
    const roof = screenPoint(box, -21, 5.5, 6);
    await page.mouse.click(roof.x, roof.y);
    const library = page.locator('[data-sheet="topic"]');
    await library.getByText('garden-qa-marker', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await library.getAttribute('aria-modal'), 'false');
    assert.equal(await library.getByRole('heading', { name: 'Library', exact: true }).count(), 1);
    assert.equal(await page.locator('[data-sheet="side"]').count(), 1, 'Bao conversation stays open');
    assert.equal(await page.locator('[data-sheet="side"]').getAttribute('aria-modal'), 'false');
    assert.equal(await page.locator('[data-rail="library"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-rail="team"]').getAttribute('aria-expanded'), 'false', 'Library replaces Team in the topic slot');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a failed required wardrobe cannot report the garden ready with incomplete role attire", { timeout: 90000 }, async () => {
  const { context, page, errors } = await openGarden({ failModels: assets['wardrobe.developer-vest'].url });
  try {
    const alert = page.getByRole('alert').filter({ hasText: 'garden models could not load' });
    await alert.waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await page.locator('.den-entry button').getAttribute('aria-disabled'), 'true', 'an incomplete required model set cannot enable walking');
    assert.match(await alert.innerText(), /board controls are still available/);
    await page.locator('[data-rail="team"]').click();
    assert.equal(await page.getByRole('list', { name: 'Residents and visitors' }).getByRole('button').count(), 32);
    assert.equal(await page.evaluate(() => window.__eventStreams), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

const PROFILE_WALL = { developer: { runs: ['Read project files'], asks: ['Any host', 'Any path outside'], takesGrants: true } };
const quietProfiles = () => ({ ...snapshot, wall: PROFILE_WALL, seq: 1, approvals: [], transcripts: {} });
const profileLive = (seq = 2, ended = false) => {
  const at = new Date().toISOString();
  const rows = ended ? [['work/02-maker', 'c-maker-past', 'done']] : [['work/02-maker', 'c-maker-current', 'working'], ['work/03-visitor', 'c-maker-visitor', 'working']];
  return {
    ...quietProfiles(), seq,
    tickets: rows.map(([ref]) => ({ ref, feature: 'work', title: ref === 'work/03-visitor' ? 'Visitor-specific task' : 'Maker-specific task', type: 'task', status: 'claimed', ready: false, holder: ended ? null : { role: 'developer', since: at }, gate: null, blockedBy: [] })),
    agents: rows.map(([ref, id, state]) => ({ id, ref, role: 'developer', state, runtime: 'claude', mode: 'direct', startedAt: at, lastEventAt: at, tool: { name: 'Read', summary: ref + ' tool details' }, capabilities: { send: true, stop: true, approve: true }, followUp: ended })),
    transcripts: Object.fromEntries(rows.map(([, id]) => [id, { dropped: 0, entries: [{ id: 1, kind: 'message', role: 'agent', at, text: 'Conversation for ' + id }] }])),
  };
};
const openProfiles = async page => {
  const entry = page.locator('[data-rail="team"]');
  if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click();
  const profiles = page.getByRole('region', { name: 'Panda profiles' });
  await profiles.waitFor({ state: 'visible' });
  return profiles;
};

test("portrait profiles keep real work and visitor identities, and route explicit Talk actions to idle, current and past conversations", { timeout: 90000 }, async () => {
  const { context, page, errors, mutations } = await openGarden({ snapshot: quietProfiles(), signedIn: true, frameDelayMs: 500, snapshotDelayMs: 2000 });
  try {
    let profiles = await openProfiles(page);
    const portraits = profiles.getByRole('list', { name: 'Residents and visitors' });
    assert.equal(await portraits.getByRole('button').count(), 32, 'all seated charter roles');
    assert.equal(await portraits.locator('img').count(), 32, 'each resident has a portrait image');
    for (const name of ['Code Reviewer', 'Release Manager', 'SRE', 'Technical Writer']) {
      assert.equal(await portraits.getByRole('button', { name: new RegExp(`^The ${name},`) }).count(), 2, `${name} appears for both runtimes in the charter roster`);
    }
    await page.waitForFunction(() => [...document.querySelectorAll('.forest-portrait-choice img')].every(image => image.complete && image.naturalWidth > 0));
    const roleIds = ['orchestrator', 'product', 'architect', 'developer', 'scout', 'debugger', 'qa', 'security', 'designer', 'herald', 'release-manager', 'code-reviewer', 'sre', 'technical-writer', 'knowledge-keeper', 'docs-writer', 'stem-cub'];
    const codexPortraitPaths = ['/den/portraits/codex-orchestrator.webp', '/den/portraits/codex-product.webp', '/den/portraits/codex-architect.webp', '/den/portraits/codex-developer.webp', '/den/portraits/codex-scout.webp', '/den/portraits/codex-runner.webp', '/den/portraits/codex-qa.webp', '/den/portraits/codex-security.webp', '/den/portraits/codex-designer.webp', '/den/portraits/codex-herald.webp', '/den/portraits/codex-code-reviewer.webp', '/den/portraits/codex-release-manager.webp', '/den/portraits/codex-sre.webp', '/den/portraits/codex-technical-writer.webp'];
    const portraitPaths = await portraits.locator('img').evaluateAll(images => images.map(image => new URL(image.currentSrc).pathname));
    // team-and-den-ux/23: a species keeps one body for both runtimes, so its two residents share one portrait.
    const species = { developer: '/den/portraits/developer-red-panda.webp', 'technical-writer': '/den/portraits/technical-writer-cloud-dragon.webp' };
    assert.equal(new Set(portraitPaths).size, 32 - Object.keys(species).length, 'each runtime resident uses its own cached portrait, except a species shared by both runtimes');
    const expected = [...roleIds.map(role => species[role] || `/den/portraits/${role}.webp`), '/den/portraits/runner.webp', ...codexPortraitPaths.map(path => Object.entries(species).find(([role]) => path === `/den/portraits/codex-${role}.webp`)?.[1] || path)];
    assert.deepEqual(portraitPaths.toSorted(), expected.toSorted());
    assert.ok(portraitPaths.includes('/den/portraits/release-manager.webp'), 'the corrected Release Manager wrap has its own portrait');
    await portraits.getByRole('button', { name: /^The Maker, developer, Claude, .*current project identity unavailable, At home$/ }).click();
    assert.equal(await profiles.getByRole('heading', { name: 'The Maker', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('region', { name: 'Selected panda' }).count(), 0, 'portrait selection does not open the scene card');
    assert.equal(await profiles.getByRole('button', { name: /View work/ }).isDisabled(), true);
    await profiles.getByRole('button', { name: 'Talk to Maker', exact: true }).click();
    const composer = page.getByRole('group', { name: 'New task for The Maker', exact: true });
    await composer.waitFor({ state: 'visible' });
    const wall = composer.getByRole('group', { name: 'What this agent may do' });
    assert.match(await wall.innerText(), /Read project files[\s\S]*Any host[\s\S]*Any path outside/);
    assert.equal(await wall.getByRole('button', { name: 'Add a grant', exact: true }).count(), 1);
    const draft = composer.getByRole('textbox', { name: 'New task for The Maker', exact: true });
    assert.equal(await draft.isEditable(), true);
    assert.equal(await draft.inputValue(), '', 'opening an idle task leaves an empty draft');
    await page.keyboard.press('Escape');
    await composer.waitFor({ state: 'hidden' });
    profiles = await openProfiles(page);
    await profiles.getByRole('list', { name: 'Residents and visitors' }).getByRole('button', { name: /^Bao, orchestrator, Claude, .*current project identity unavailable, At home$/ }).click();
    await profiles.getByRole('button', { name: 'Talk to Bao', exact: true }).click();
    await page.locator('.transcript-meta code').filter({ hasText: /^desk$/ }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Close conversation' }).click();

    profiles = await openProfiles(page);
    await page.evaluate(next => window.__pushGardenSnapshot(next), profileLive());
    await profiles.getByRole('list', { name: 'Residents and visitors' }).getByRole('button', { name: /^The Maker, developer, Claude, current project identity unavailable, Working$/ }).click();
    await profiles.getByText(/Read: work\/02-maker tool details/).waitFor({ state: 'visible' });
    assert.match(await profiles.locator('.forest-profile-task').innerText(), /work\/02-maker[\s\S]*Maker-specific task/);
    assert.equal(await profiles.getByRole('list', { name: 'Residents and visitors' }).getByRole('button').count(), 33, 'a second live role gets a distinct visitor portrait');
    await profiles.getByRole('button', { name: 'Talk to Maker', exact: true }).click();
    await page.locator('.transcript-meta code').filter({ hasText: /^c-maker-current$/ }).waitFor({ state: 'visible' });
    assert.match(await page.locator('.transcript-log').innerText(), /Conversation for c-maker-current/);
    await page.getByRole('button', { name: 'Close conversation' }).click();
    profiles = await openProfiles(page);
    await profiles.getByRole('list', { name: 'Residents and visitors' }).getByRole('button', { name: /^The Maker, developer, Claude, .*visitor on work\/03-visitor, Working$/ }).click();
    await profiles.getByRole('button', { name: /View work/ }).click();
    const ticket = page.getByRole('dialog', { name: 'Ticket details' });
    await ticket.waitFor({ state: 'visible' });
    assert.match(await ticket.innerText(), /work\/03-visitor/);
    assert.match(await ticket.innerText(), /Visitor-specific task/);
    assert.equal(await ticket.getByText('work/02-maker', { exact: true }).count(), 0, 'visitor work never reuses the permanent resident ticket');
    await ticket.getByRole('button', { name: 'Close ticket details' }).click();
    profiles = await openProfiles(page);
    await page.evaluate(next => window.__pushGardenSnapshot(next), profileLive(3, true));
    const endedResidents = profiles.getByRole('list', { name: 'Residents and visitors' });
    await endedResidents.getByRole('button', { name: /^The Maker, developer, Claude, .*visitor on work\/03-visitor, Working$/ }).waitFor({ state: 'hidden' });
    await endedResidents.getByRole('button', { name: /^The Maker, developer, Claude, .*current project identity unavailable, At home$/ }).click();
    assert.equal(await endedResidents.getByRole('button').count(), 32, 'the ended visitor is removed before opening the resident’s past conversation');
    await profiles.getByRole('button', { name: 'Talk to Maker', exact: true }).click();
    await page.locator('.transcript-meta code').filter({ hasText: /^c-maker-past$/ }).waitFor({ state: 'visible' });
    assert.match(await page.locator('.transcript-log').innerText(), /Conversation for c-maker-past/);
    assert.deepEqual(mutations, [], 'profile visits and explicit view/talk actions never dispatch or approve work');
    assert.equal(await page.evaluate(() => window.__eventStreams), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("read-only and scenery-role profiles explain disabled Talk and work actions honestly", { timeout: 60000 }, async () => {
  const { context, page, errors, mutations } = await openGarden({ snapshot: quietProfiles() });
  try {
    const profiles = await openProfiles(page);
    const portraits = profiles.getByRole('list', { name: 'Residents and visitors' });
    await portraits.getByRole('button', { name: /^The Maker, developer, Claude, .*current project identity unavailable, At home$/ }).click();
    const talk = profiles.getByRole('button', { name: 'Talk to Maker', exact: true });
    assert.equal(await talk.isDisabled(), true);
    assert.match(await profiles.innerText(), /read-only[\s\S]*Sign in to start/);
    assert.ok(await talk.getAttribute('aria-describedby'), 'disabled action has an accessible reason');
    assert.equal(await profiles.getByRole('button', { name: /View work/ }).isDisabled(), true);
    await portraits.getByRole('button', { name: /^The Debugger,/ }).click();
    assert.equal(await profiles.getByRole('button', { name: 'Talk to Debugger', exact: true }).isDisabled(), true);
    assert.match(await profiles.innerText(), /does not have an agent runtime yet/);
    assert.deepEqual(mutations, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

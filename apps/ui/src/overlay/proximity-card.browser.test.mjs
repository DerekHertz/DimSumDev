import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

test('walking up to a resident shows its nearby card; moving away and leaving hides it', { timeout: 60000 }, async () => {
  let server, browser;
  try {
    server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
    await server.listen();
    browser = await chromium.launch(buildLaunchOptions());
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    await lightenScene(context, { frameDelayMs: 16 });
    const page = await context.newPage();
    const errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() === 'POST') writes.push(r.url()); });
    const snapshot = { schema: 1, seq: 1, tickets: [], frontier: [], usage: null, requests: [], agents: [] };
    await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` }));
    await page.route('**/state', r => r.fulfill({ json: snapshot }));
    await page.route('**/metrics', r => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
    await page.route('**/session', r => r.fulfill({ status: 404, json: {} }));
    await page.goto(server.resolvedUrls.local[0]);
    const enter = page.getByRole('button', { name: 'Enter the den', exact: true });
    await page.waitForFunction(() => {
      const button = document.querySelector('.den-entry button');
      return button && button.getAttribute('aria-disabled') !== 'true';
    });
    await enter.click();
    const leave = page.getByRole('button', { name: 'Back to the diorama · Esc', exact: true });
    await page.waitForFunction(() => document.pointerLockElement?.tagName === 'CANVAS');
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.pointerLockElement === null);
    assert.equal(await leave.isVisible(), true, 'Tab releases the native cursor without leaving walking mode');
    await page.getByRole('button', { name: 'Look around', exact: true }).click();
    await page.waitForFunction(() => document.pointerLockElement?.tagName === 'CANVAS');
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.pointerLockElement === null);
    await page.keyboard.press('Escape');
    await enter.waitFor();
    // Native capture/release is verified above. Use the supported drag-to-look
    // fallback for the physical route: headless capture may emit OS recentering
    // deltas. Re-entering resets the pose to the authored gate entry.
    await page.evaluate(() => { HTMLCanvasElement.prototype.requestPointerLock = undefined; });
    await enter.click();
    await leave.waitFor();
    const card = page.getByRole('region', { name: 'Nearby panda' });
    assert.equal(await card.count(), 0, 'the current gate spawn starts away from every resident');
    // The approved Codex Designer route is validated by the production navigation probe:
    // gate → (0,35) → (22,35) → (22,30.5) → resident at (22,28.5).
    const target = await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').find(e => e.name.includes('react-three_fiber.js')).name;
      const { _roots } = await import(url);
      const state = _roots.get(document.querySelector('canvas')).store.getState();
      const world = state.scene.getObjectByName('Dim Sum Dev · plush bamboo garden');
      let resident; world.traverse(node => { if (node.userData.actorKey === 'codex:designer') resident = node; });
      return { x: resident.position.x, z: resident.position.z, role: resident.userData.roleId, runtime: resident.userData.runtime };
    });
    assert.deepEqual(target, { x: 22, z: 28.5, role: 'designer', runtime: 'codex' }, 'the active Codex Designer matches the native approved route');
    const position = () => page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').find(e => e.name.includes('react-three_fiber.js')).name;
      const { _roots } = await import(url); return _roots.get(document.querySelector('canvas')).store.getState().camera.position.toArray();
    });
    const canvas = await page.locator('.forest-canvas canvas').boundingBox();
    const x = canvas.x + canvas.width / 2, y = canvas.y + canvas.height / 2;
    const moveTo = async (axis, target, positiveKey, negativeKey) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const gap = target - (await position())[axis];
        if (Math.abs(gap) <= .15) return;
        await page.keyboard.press(gap > 0 ? positiveKey : negativeKey, { delay: Math.min(200, Math.abs(gap) * 1000 / 5) });
      }
      throw new Error('walk did not reach waypoint '+axis+':'+target+' from '+JSON.stringify(await position()));
    };
    // The walker starts at (0,42): follow the unit-probed route and stop two metres from the resident.
    await page.locator('main[aria-label="Den scene"]').focus();
    await moveTo(2, 35, 'KeyS', 'KeyW');
    await moveTo(0, target.x, 'KeyD', 'KeyA');
    await moveTo(2, 30.5, 'KeyS', 'KeyW');
    await card.waitFor({ timeout: 15000 });
    assert.match(await card.textContent(), /The Stylist/);
    assert.match(await card.textContent(), /Resident · no agent running/);
    assert.equal(await card.locator('button:disabled').count(), 4);
    await page.keyboard.press('Tab');
    assert.equal(await leave.count(), 1);
    assert.equal(await card.count(), 1, 'using the cursor keeps the nearby card visible');
    assert.equal(await card.isVisible(), true, 'the nearby card stays anchored in the scene while the cursor is free');
    await page.getByRole('button', { name: 'Look around', exact: true }).click();
    assert.equal(await leave.count(), 1, 'the free cursor can resume looking without leaving the den');
    await page.keyboard.press('KeyT');
    await page.keyboard.press('KeyR');
    await page.keyboard.press('KeyE');
    await page.keyboard.press('KeyQ');
    assert.deepEqual(writes, [], 'the card and its advertised shortcuts are read-only');
    // Keyboard walking ignores focused buttons; click empty garden to resume.
    await page.mouse.click(x, y);
    await page.keyboard.down('KeyS');
    try { await card.waitFor({ state: 'hidden', timeout: 10000 }); }
    finally { await page.keyboard.up('KeyS'); }
    assert.equal(await leave.count(), 1, 'moving out of range hides the card while walking remains active');
    await page.keyboard.down('KeyW');
    try { await card.waitFor({ state: 'visible', timeout: 10000 }); }
    finally { await page.keyboard.up('KeyW'); }
    assert.match(await card.textContent(), /The Stylist/, 'the same active resident reappears when approached again');
    await page.keyboard.press('Escape');
    await enter.waitFor();
    assert.equal(await card.count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server?.close();
  }
});

// den-mvp outcome 4, in a real page: the Library card opens from the keyboard, loads GET /library, and says for each
// connection how it stood, which roles get it, why one cannot use it yet, and what each tool does; skills are listed
// as their own kind. A bridge that cannot answer shows a reason. The bridge is stubbed at the network.
// DEN_SHOTS=<dir> also saves screenshots of the card (wide and 375px) for the user's visual check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

const snapshot = {
  schema: 1, seq: 1, frontier: [], usage: null, requests: [], sessions: [], agents: [], approvals: [], transcripts: {}, tickets: [], deliveries: [],
  capacity: { max: 2, cap: 8, load: 0, live: 0, room: 2, refs: [], reserved: { bao: { max: 1, refs: [] }, scout: { max: 1, refs: [] } } },
};
const library = {
  connections: [
    {
      kind: 'connection', name: 'context7', title: 'Docs lookup', purpose: 'Current documentation and code examples for a named library, from the public Context7 service.',
      where: { kind: 'remote', host: 'mcp.context7.com' }, credential: 'none',
      roles: [{ role: 'scout', usable: true }, { role: 'developer', usable: true }, { role: 'architect', usable: false, reason: 'The role file .claude/agents/architect.md does not name it, so the architect cannot see its tools.' }],
      tools: [{ name: 'resolve-library-id', capability: 'read' }, { name: 'query-docs', capability: 'read' }],
      status: { state: 'connected', at: new Date(Date.now() - 4 * 60_000).toISOString(), role: 'scout' },
      uses: { count: 3, refused: 1, lastAt: new Date().toISOString(), lastRole: 'scout', lastTool: 'query-docs' },
    },
    {
      kind: 'connection', name: 'notes', title: 'Team notes', purpose: 'Read and add notes.', where: { kind: 'local' }, credential: 'none',
      roles: [{ role: 'architect', usable: true }], tools: [{ name: 'find', capability: 'read' }, { name: 'add', capability: 'change' }],
      status: { state: 'failed', at: new Date().toISOString(), role: 'architect', reason: 'It could not be started or reached when the architect last started.' },
      uses: { count: 0, refused: 0, lastAt: null, lastRole: null, lastTool: null },
    },
  ],
  skills: [
    { kind: 'skill', name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', roles: ['developer', 'qa'] },
    { kind: 'skill', name: 'handoff', description: 'Write the handoff a placement leaves for the next one.', roles: ['developer', 'qa', 'security'] },
  ],
};

async function open({ width = 1280, answer = () => ({ json: library }) } = {}) {
  const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch(buildLaunchOptions());
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width, height: 900 } });
  await lightenScene(context);
  const page = await context.newPage();
  const errors = [];
  let reads = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  // ci-cd/08: the page stays offline. A live bridge makes the archive scene read GET /library itself (App.jsx useArchiveLibrary), and
  // a one-shot event-stream answer made the page live for an instant under load, so that read counted as the card's (1 !== 0).
  await page.route('**/events', (r) => r.abort());
  await page.route('**/state', (r) => r.fulfill({ json: snapshot }));
  await page.route('**/metrics', (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  await page.route('**/library', (r) => { reads += 1; return r.fulfill(answer()); });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => document.querySelector('.den-entry button')?.getAttribute('aria-disabled') !== 'true');
  const close = async () => { await browser.close(); await server.close(); };
  return { page, errors, reads: () => reads, close };
}
const shot = async (page, name) => { if (process.env.DEN_SHOTS) await page.locator('[data-overlay=library]').screenshot({ path: path.join(process.env.DEN_SHOTS, name) }); };

test('the library card: opened from the keyboard, it shows each connection and each skill with the bridge\'s own facts', { timeout: 90000 }, async () => {
  const t = await open();
  try {
    const { page } = t;
    const card = page.locator('[data-overlay=library]');
    const toggle = card.locator('.card-toggle');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(t.reads(), 0, 'nothing is loaded while the card is closed');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await card.getByText('Docs lookup').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    const text = await card.innerText();
    assert.match(text, /2 connections · 2 skills/);
    const docs = await card.locator('[data-connection=context7]').innerText();
    assert.match(docs, /Docs lookup[\s\S]*Connected[\s\S]*Seen 4 min ago, when the scout started\.[\s\S]*A remote service at mcp\.context7\.com\. No credential\./);
    assert.match(docs, /scout can use it[\s\S]*developer can use it[\s\S]*architect cannot use it yet\. The role file \.claude\/agents\/architect\.md does not name it/i);
    assert.match(docs, /resolve-library-id reads; allowed without asking[\s\S]*query-docs reads; allowed without asking[\s\S]*Any other tool it offers is refused\. 3 calls, last by the scout \(query-docs\)\. 1 call refused\./);
    const notes = await card.locator('[data-connection=notes]').innerText();
    assert.match(notes, /Team notes[\s\S]*Failed[\s\S]*It could not be started or reached when the architect last started\.[\s\S]*Runs on this machine[\s\S]*add changes something; asks you each time/);
    assert.match(await card.locator('[data-skill=tdd]').innerText(), /tdd[\s\S]*Test-driven development[\s\S]*Roles: developer, qa/);
    // The status is a word and a mark, not a colour alone.
    assert.match(await card.locator('[data-connection=notes] .library-status').innerText(), /▲\s*Failed/);
    await shot(page, 'library-wide.png');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('the library card at 375px: it fits the screen, and a bridge that cannot answer shows a reason', { timeout: 90000 }, async () => {
  const narrow = await open({ width: 375 });
  try {
    const card = narrow.page.locator('[data-overlay=library]');
    await card.locator('.card-toggle').click();
    await card.getByText('Docs lookup').waitFor();
    const box = await card.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 375, `the card is inside the screen (${box.x} + ${box.width})`);
    assert.equal(await narrow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    await shot(narrow.page, 'library-375.png');
  } finally {
    await narrow.close();
  }
  const down = await open({ answer: () => ({ status: 500, json: { error: 'the library could not be read' } }) });
  try {
    const card = down.page.locator('[data-overlay=library]');
    await card.locator('.card-toggle').click();
    await card.getByRole('alert').waitFor();
    assert.match(await card.getByRole('alert').innerText(), /the library could not be read/);
  } finally {
    await down.close();
  }
});

// den-mvp/55: Bao's board_file ask reads as the tickets it files. The card lists each title with its priority, type and
// blockers, folds the text (rendered as markdown) under it, and keeps the raw input one click away. No escaped \n.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

const AGENT = 'c-d5253e56cd754db5', APPROVAL = 'a-21aa0369e1cfaeec';
const BATCH = { feature: 'den-mvp', tickets: [
  { title: 'Outcome 6 design: target worktrees', text: '## What to decide\n\n1. **Where** a target\'s worktrees live.\n\n## Acceptance criteria\n\n- [ ] A recorded decision.', priority: 'P1', type: 'design question' },
  { title: 'Outcome 6 slice 1: clean start', text: '## What to build\n\nThe adapter.\n\n## Acceptance criteria\n\n- [ ] Both start paths pinned.', priority: 'P1', type: 'feature', blockedBy: [1] },
] };
const INPUT_LENGTH = JSON.stringify(BATCH).length;
const ASK = { id: APPROVAL, agentId: AGENT, tool: 'mcp__den__board_file', summary: 'file 2 tickets in den-mvp: Outcome 6 design: target worktrees; Outcome 6 slice 1: clean start',
  says: null, intent: null, inputLength: INPUT_LENGTH, truncated: true, ts: new Date().toISOString(), expiresAt: new Date(Date.now() + 9 * 60000).toISOString(), state: 'pending' };
const snapshot = () => ({
  schema: 1, seq: 1, frontier: [], usage: null, requests: [], sessions: [], tickets: [],
  agents: [{ id: AGENT, ref: 'den/00-bao', role: 'orchestrator', mode: 'direct', runtime: 'claude', state: 'waiting_on_user', startedAt: new Date(Date.now() - 60000).toISOString(), lastEventAt: new Date().toISOString(),
    tool: { name: 'mcp__den__board_file', summary: 'file 2 tickets in den-mvp' }, tokens: null, capabilities: { stop: true, approve: true, send: true, handover: false } }],
  approvals: [ASK],
  transcripts: { [AGENT]: { dropped: 0, entries: [
    { id: 1, at: new Date().toISOString(), kind: 'tool', name: 'mcp__den__board_file', summary: 'file 2 tickets in den-mvp', status: 'running' },
    { id: 2, at: new Date().toISOString(), kind: 'permission', name: 'mcp__den__board_file', status: 'pending', approvalId: APPROVAL },
  ] } },
});

test("Bao's board_file ask shows the tickets, not escaped JSON", { timeout: 90000 }, async () => {
  let server, browser;
  try {
    server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
    await server.listen();
    browser = await chromium.launch(buildLaunchOptions());
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
    await lightenScene(context);
    await context.addInitScript(() => sessionStorage.setItem('den.session-token', 'tok-test-123'));
    const page = await context.newPage();
    const errors = [], writes = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (r.method() === 'POST') writes.push(r.url()); });
    const state = snapshot();
    await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(state)}\n\n` }));
    await page.route('**/state', (r) => r.fulfill({ json: state }));
    await page.route('**/metrics', (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
    await page.route(`**/approvals/${APPROVAL}`, (r) => r.fulfill({ json: { ...ASK, input: BATCH } }));
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => document.querySelector('.den-entry button')?.getAttribute('aria-disabled') !== 'true');


    await page.locator('[data-rail=needs]').click();
    const needs = page.locator('[data-overlay=needs-you]');
    await needs.locator('[data-answer=allow]').waitFor();
    await needs.locator('[data-answer=allow]').click();
    const review = page.locator('.approval-panel');
    const list = review.locator('.approval-tickets');
    await list.waitFor();
    assert.match(await list.locator('.approval-tickets-head').innerText(), /File 2 tickets in den-mvp, each at ready-for-human/);
    const items = list.locator('.approval-ticket');
    assert.equal(await items.count(), 2);
    assert.equal(await items.nth(0).locator('.approval-ticket-title').innerText(), 'Outcome 6 design: target worktrees');
    assert.equal(await items.nth(0).locator('.approval-ticket-meta').innerText(), 'P1 · design question');
    assert.equal(await items.nth(1).locator('.approval-ticket-meta').innerText(), 'P1 · feature · after ticket 1 above');
    await items.nth(0).locator('summary').click();
    const md = items.nth(0).locator('.agent-md');
    assert.equal(await md.locator('h2').first().innerText(), 'What to decide');
    assert.equal(await md.locator('strong').first().innerText(), 'Where');
    const shown = await list.innerText();
    assert.doesNotMatch(shown, /\\n|\\"|\{\s*"feature"/, 'no escaped JSON in the ticket view');
    assert.equal(await review.locator('.approval-raw pre').isVisible(), false, 'the raw input is folded');
    assert.match(await review.locator('.approval-label').innerText(), new RegExp(`All ${INPUT_LENGTH} characters shown`));
    assert.deepEqual(writes, [], 'opening the ask sends no answer');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server?.close();
  }
});

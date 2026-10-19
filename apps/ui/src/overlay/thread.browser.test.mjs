// den-mvp outcome 2 and organism-infra/230, in a real page: the thread opens from the Needs you card with no walking,
// shows the role's earlier run above the live one, sends a message to the run, stops it behind a one-step confirm, and
// follows up a run that has ended. The bridge is stubbed at the network; what it is sent is what the test checks.
// DEN_SHOTS=<dir> also saves screenshots of the thread (wide and 375px) for the user's visual check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

const RUN = 'c-af592f417c598394', OLD = 'c-0011223344556677', NEXT = 'c-8899aabbccddeeff', APPROVAL = 'a-8313dee2f728c5f1', REF = 'den/02-scout';
const iso = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const agentRow = (extra = {}) => ({
  id: RUN, ref: REF, role: 'scout', mode: 'direct', runtime: 'claude', state: 'waiting_on_user', startedAt: iso(300), lastEventAt: iso(1),
  tool: null, tokens: null, capabilities: { stop: true, approve: true, send: true, handover: false }, followUp: false, resumeOf: null, ...extra,
});
const snapshot = ({ ended = false } = {}) => ({
  schema: 1, seq: 1, frontier: [], usage: null, requests: [], sessions: [],
  tickets: [{ ref: REF, feature: 'den', title: '02: Den task for scout', type: 'task', status: 'ready-for-agent', ready: true, priority: 'P2', effectivePriority: 'P2', blockedBy: [], holder: null, gate: null }],
  agents: [agentRow(ended ? { state: 'done', followUp: true } : {})],
  approvals: ended ? [] : [{ id: APPROVAL, agentId: RUN, tool: 'Bash', summary: 'npm test -- --watch=false', says: 'I need to run the tests to see which one fails.', intent: 'Run the test suite once', inputLength: 40, truncated: false, ts: iso(5), expiresAt: new Date(Date.now() + 8 * 60000 + 30000).toISOString(), state: 'pending' }],
  transcripts: { [RUN]: { dropped: 0, entries: [
    { id: 1, at: iso(240), kind: 'message', role: 'agent', text: 'I will start by reading the failing test.' },
    { id: 2, at: iso(200), kind: 'permission', name: 'Bash', status: 'denied', approvalId: 'a-0000000000000001', note: 'Do not delete dist.', answeredAt: iso(190) },
    { id: 3, at: iso(180), kind: 'tool', name: 'Read', summary: 'apps/ui/src/a.test.mjs', status: 'done', result: 'ok' },
    { id: 4, at: iso(120), kind: 'message', role: 'user', text: 'Use port 5173.', messageId: '7b0c2f1e-3a4d-4e5f-8a6b-9c0d1e2f3a4b', status: 'applied' },
    ...(ended
      ? [{ id: 5, at: iso(60), kind: 'message', role: 'agent', text: MARKDOWN }, { id: 6, at: iso(50), kind: 'ended', state: 'done' }]
      : [{ id: 5, at: iso(5), kind: 'permission', name: 'Bash', status: 'pending', approvalId: APPROVAL }]),
  ] } },
});
// den-mvp/39: the ended run's last message is markdown, with a table wider than the 375px panel and raw HTML in it.
const MARKDOWN = 'Done. One test was wrong.\n\n## What changed\n\n- **a.test.mjs** used the wrong port\n\n| file | before | after | why the port moved |\n|---|---|---|---|\n| apps/ui/src/a.test.mjs | `4317` | `5173` | the dev server listens on 5173 in every walled run |\n\n<script>window.__ran = true</script>';
const history = { more: true, before: 40, entries: [
  { runId: OLD, ref: REF, id: 0, at: iso(9000), kind: 'run', mode: 'direct', resumeOf: null },
  { runId: OLD, ref: REF, id: 1, at: iso(8990), kind: 'message', role: 'agent', text: 'Yesterday I mapped the test folders.' },
  // den-mvp/39: a message too deeply nested to parse is shown as plain text, and the page carries on.
  { runId: OLD, ref: REF, id: 2, at: iso(8950), kind: 'message', role: 'agent', text: `${'> '.repeat(5000)}too deep` },
  { runId: OLD, ref: REF, id: 3, at: iso(8900), kind: 'ended', state: 'done' },
] };

// ci-cd/08: one dev server and one browser for the file; each scenario gets its own context and page.
let server, browser;
before(async () => {
  server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  browser = await chromium.launch(buildLaunchOptions());
}, { timeout: 120000 });
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open({ ended = false, width = 1280 } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width, height: 800 } });
  await lightenScene(context);
  await context.addInitScript(() => sessionStorage.setItem('den.session-token', 'tok-test-123'));
  const page = await context.newPage();
  const errors = [], posts = [], reads = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const state = snapshot({ ended });
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(state)}\n\n` }));
  await page.route('**/state', (r) => r.fulfill({ json: state }));
  await page.route('**/metrics', (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  await page.route('**/conversations/scout**', (r) => {
    const req = r.request();
    if (req.method() === 'GET') { reads.push(new URL(req.url()).search); return r.fulfill({ json: reads.length > 1 ? { entries: [], more: false, before: 0 } : history }); }
    posts.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() });
    return ended
      ? r.fulfill({ status: 201, json: { ok: true, runId: NEXT, messageId: 'm', resumed: true, agent: agentRow({ id: NEXT, state: 'working', resumeOf: RUN }) } })
      : r.fulfill({ status: 202, json: { ok: true, runId: RUN, messageId: 'm', resumed: false } });
  });
  await page.route('**/agents/*/stop', (r) => { posts.push({ path: new URL(r.request().url()).pathname, body: r.request().postData() }); return r.fulfill({ status: 202, json: { ok: true } }); });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => document.querySelector('.den-entry button')?.getAttribute('aria-disabled') !== 'true');
  const close = () => context.close();
  return { page, errors, posts, reads, close };
}
const shot = async (page, name) => { if (process.env.DEN_SHOTS) await page.locator('.thread-panel').screenshot({ path: path.join(process.env.DEN_SHOTS, name) }); };

// Click the scout panda where it is on screen. ci-cd/08 (PR #325 flake, a click that selected nothing): the click goes only
// once a ray through the point hits the panda and the canvas is the topmost element there; the point is read again right
// before the click, so it lands where it was measured.
const scoutPoint = async () => {
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('@react-three_fiber'));
  if (!url) return null;
  const { _roots } = await import(url);
  const canvas = document.querySelector('canvas');
  const state = _roots.get(canvas)?.store.getState();
  let found = null;
  state?.scene.traverse((o) => { if (o.userData?.actorKey === 'scout') found = o; });
  if (!found) return null;
  const p = found.getWorldPosition(found.position.clone()); p.y += 0.6; p.project(state.camera);
  const ray = new state.raycaster.constructor(); ray.setFromCamera({ x: p.x, y: p.y }, state.camera);
  if (!ray.intersectObject(found, true).length) return null;
  const r = canvas.getBoundingClientRect();
  const at = { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  return document.elementFromPoint(at.x, at.y) === canvas ? at : null;
};
async function pickScout(page) {
  await page.waitForFunction(scoutPoint);
  const at = await page.evaluate(scoutPoint);
  await page.mouse.click(at.x, at.y);
}

test('the thread: opened from Needs you, it reads as a conversation, takes a message and stops the agent behind a confirm', { timeout: 90000 }, async () => {
  const t = await open();
  try {
    const { page } = t;
    await page.locator('[data-overlay=needs-you] .needs-thread').click();
    const thread = page.getByRole('complementary', { name: 'Conversation with Scout' });
    await thread.waitFor();
    assert.match(await thread.locator('.transcript-head').innerText(), /conversation\s+Scout · 02-scout[\s\S]*Needs your answer/i);

    // The earlier run is above the live one, and more can be asked for.
    await thread.getByText('Yesterday I mapped the test folders.').waitFor();
    const log = await thread.locator('.transcript-log').innerText();
    assert.match(log, /Show earlier[\s\S]*Run started · 02-scout[\s\S]*Yesterday I mapped[\s\S]*I will start by reading/);
    // The user's answer with its note and a receipt; the typed message with its receipt; the ask with its reason first.
    assert.match(log, /Asked to run a command · answered[\s\S]*Denied\.\s*Do not delete dist\.[\s\S]*Sent with your denial and note[\s\S]*Agent next: ran Read/);
    assert.match(log, /Use port 5173\.[\s\S]*Received/);
    assert.match(log, /Asking to run a command · waiting on you · expires in \d+ min\s+I need to run the tests to see which one fails\.\s+Why this command: Run the test suite once\s+Show the command/);
    assert.doesNotMatch(log, /\b(read|saw|seen) (your|the) (note|message)/i);
    await shot(page, 'thread-live.png');
    await thread.getByRole('button', { name: 'Show earlier' }).click();
    await thread.getByRole('button', { name: 'Show earlier' }).waitFor({ state: 'hidden' });
    assert.deepEqual(t.reads, ['?limit=100', '?before=40&limit=100']);

    // A message goes to this run, by name.
    await thread.getByRole('textbox', { name: 'Message Scout' }).fill('Skip the slow suite.');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.thread-box')?.value === '');
    assert.deepEqual(t.posts, [{ path: '/conversations/scout/message', body: { text: 'Skip the slow suite.', runId: RUN } }]);

    // Stop asks once; focus is on the safe choice; Esc keeps the agent going and the thread open.
    await thread.getByRole('button', { name: 'Stop agent' }).click();
    const confirm = thread.getByRole('group', { name: 'Stop this agent?' });
    await confirm.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Keep going');
    await shot(page, 'thread-stop-confirm.png');
    await page.keyboard.press('Escape');
    await confirm.waitFor({ state: 'hidden' });
    assert.equal(await thread.isVisible(), true);
    assert.equal(t.posts.length, 1, 'nothing was stopped');
    await thread.getByRole('button', { name: 'Stop agent' }).click();
    await confirm.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.thread-panel [role=status]')].some((n) => n.textContent === 'Stop sent'));
    assert.deepEqual(t.posts[1], { path: `/agents/${RUN}/stop`, body: null });
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('the thread of a run that ended: opened from its panda, a follow-up continues it and the thread moves to the new run', { timeout: 90000 }, async () => {
  const t = await open({ ended: true, width: 375 });
  try {
    const { page } = t;
    // No request is waiting, so the thread opens from the role's panda: pick it in the overview and press R.
    await pickScout(page);
    await page.getByRole('region', { name: 'Selected panda' }).waitFor();
    await page.keyboard.press('KeyR');
    const thread = page.getByRole('complementary', { name: /Conversation with/ });
    await thread.waitFor();
    assert.match(await thread.locator('.transcript-log').innerText(), /Done\. One test was wrong\.[\s\S]*Agent ended: done/);
    // den-mvp/39: the message is formatted; its table stays inside the bubble, and its script is text that never ran.
    const md = thread.locator('.thread-bubble.agent-md').last();
    assert.equal(await md.locator('h2').innerText(), 'What changed');
    assert.equal(await md.locator('li strong').innerText(), 'a.test.mjs');
    assert.equal(await md.locator('table th').count(), 4);
    assert.match(await md.innerText(), /<script>window\.__ran = true<\/script>/);
    assert.equal(await page.evaluate(() => window.__ran), undefined, 'the script in the message did not run');
    assert.equal(await md.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, 'the wide table scrolls inside its own box, not the bubble');
    assert.equal(await thread.locator('p.thread-bubble', { hasText: 'too deep' }).count(), 1, 'the unparseable message is plain text');
    assert.match(await thread.locator('.thread-foot-note').innerText(), /A follow-up continues its session/);
    assert.equal(await thread.locator('.thread-stop').count(), 0, 'a run that ended has no Stop');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll at 375px');
    await shot(page, 'thread-ended-375.png');

    await thread.getByRole('textbox', { name: /Follow up with/ }).fill('Which test was wrong?');
    await thread.getByRole('button', { name: 'Follow up' }).click();
    await page.waitForFunction((id) => document.querySelector('.transcript-meta code')?.textContent === id, NEXT);
    assert.deepEqual(t.posts, [{ path: '/conversations/scout/message', body: { text: 'Which test was wrong?', runId: RUN } }]);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

// den-v1/12: the App capture listener (useTranscript in TranscriptPanel.jsx) takes Esc while the thread is open: it closes the
// thread and goes no further, so the panda picked from the overview stays picked (the card Esc, which unpicks, did not run).
test('Esc closes the thread and is consumed there: the picked panda card stays', { timeout: 90000 }, async () => {
  const t = await open({ ended: true });
  try {
    const { page } = t;
    await pickScout(page);
    const card = page.getByRole('region', { name: 'Selected panda' });
    await card.waitFor();
    await page.keyboard.press('KeyR');
    const thread = page.getByRole('complementary', { name: /Conversation with/ });
    await thread.waitFor();
    // A bubbling listener on window stands for every other Esc user (walk mode leaves on Esc, the card unpicks on it).
    await page.evaluate(() => { window.__esc = 0; window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__esc += 1; }); });
    await page.keyboard.press('Escape');
    await thread.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.__esc), 0, 'the Esc that closed the thread went no further');
    assert.equal(await card.isVisible(), true, 'the first Esc closed only the thread');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__esc), 1, 'with the thread closed, Esc reaches the rest of the page again');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

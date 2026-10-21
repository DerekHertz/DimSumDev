// Hierarchy audit replay in the real den: it opens over the live scene and leaves it as it was, plays and seeks without
// a single request to the bridge, survives an interrupted load and a bad import, and fits a phone with reduced motion.
// DEN_AUDIT_EVIDENCE_DIR=<dir> also saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { buildLaunchOptions } from "../../../ci-cd/launch-options.mjs";
import { lightenScene } from "../../../ci-cd/light-scene.mjs";

let server, browser;
before(async () => {
  server = await createServer({ configFile: "apps/ui/vite.config.mjs", configLoader: "native", server: { port: 0, host: "127.0.0.1" }, logLevel: "silent" });
  await server.listen();
  browser = await chromium.launch(buildLaunchOptions());
}, { timeout: 120000 });
after(async () => { await browser?.close(); await server?.close(); });

const snapshot = { schema: 1, seq: 1, frontier: [], tickets: [], usage: null, requests: [], meetings: [], deliveries: [], approvals: [], agents: [] };
async function open({ width = 1440, query = "", reducedMotion = "no-preference", block = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
  await lightenScene(context);
  const page = await context.newPage(), writes = [], errors = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (r.method() !== "GET" && r.method() !== "HEAD") writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.route("**/events", (r) => r.fulfill({ contentType: "text/event-stream", body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` }));
  await page.route("**/state", (r) => r.fulfill({ json: snapshot }));
  await page.route("**/metrics", (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  await page.route("**/library", (r) => r.fulfill({ json: { entries: [] } }));
  if (block) await page.route((url) => url.pathname.includes(block), (r) => r.abort("connectionreset"));
  await page.goto(server.resolvedUrls.local[0] + query, { timeout: 60000 });
  await page.locator("canvas").first().waitFor({ timeout: 60000 });
  return { page, writes, errors, close: () => context.close() };
}
const sheet = (page) => page.locator("#sheet-topic .audit");
const evidence = async (page, name) => {
  const dir = process.env.DEN_AUDIT_EVIDENCE_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });
};

test("opens from Work over the scene, plays, seeks and closes with the scene untouched and no writes", { timeout: 180000 }, async () => {
  const { page, writes, errors, close } = await open();
  try {
    const canvas = await page.locator("canvas").first().elementHandle();
    await page.locator('[data-rail="work"]').click();
    await page.locator('[data-open="replay"]').click();
    await sheet(page).locator('[data-audit-state="ready"], .audit-banner').first().waitFor();
    assert.match(await page.locator(".audit-banner").first().textContent(), /Illustrative sample/);
    await evidence(page, "sample-end");
    await page.getByRole("button", { name: "Back to the start" }).click();
    assert.match(await page.locator(".audit-cursor").textContent(), /event 0\//);
    await page.locator(".audit-controls select").selectOption("4");
    await page.locator(".audit-play").click();
    await page.waitForFunction(() => /event ([1-9]\d*)\//.test(document.querySelector(".audit-cursor").textContent));
    await page.locator(".audit-play").click(); // pause
    const paused = await page.locator(".audit-cursor").textContent();
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".audit-cursor").textContent(), paused, "pause holds the cursor");
    await page.locator(".audit-seek").fill("25");
    assert.match(await page.locator(".audit-cursor").textContent(), /event 25\//);
    assert.ok(await page.locator(".audit-node").count() >= 5, "nodes appear as agents start");
    await evidence(page, "sample-event-25");
    await page.getByRole("button", { name: "Static view (end)" }).click();
    await page.locator(".audit-play").click(); // Replay from the end restarts
    await page.waitForFunction(() => /event [0-9]\//.test(document.querySelector(".audit-cursor").textContent));
    await page.locator(".audit-play").click();
    await page.locator(".audit-seek").fill("17");
    const before = await page.locator(".audit-cursor").textContent();
    await page.getByRole("button", { name: "Close panel" }).click();
    await sheet(page).waitFor({ state: "detached" });
    assert.ok(await canvas.evaluate((c) => c.isConnected), "the scene canvas was never remounted");
    // Reopening returns to the same cursor.
    await page.locator('[data-rail="work"]').click();
    await page.locator('[data-open="replay"]').click();
    await sheet(page).locator(".audit-cursor").waitFor();
    assert.equal(await page.locator(".audit-cursor").textContent(), before, "reopening returns to the same cursor");
    assert.deepEqual(writes, [], "replay makes no bridge writes");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("a recorded run opens by name; the inspected event names its board row", { timeout: 180000 }, async () => {
  const { page, errors, close } = await open({ query: "?replay=team-and-den-ux-50" });
  try {
    await sheet(page).locator(".audit-banner-recorded").waitFor();
    await page.locator(".audit-log select").selectOption("all");
    await page.locator(".audit-events li", { hasText: "#13 " }).locator("button").first().click();
    await page.locator(".audit-raw summary").click();
    const raw = JSON.parse(await page.locator(".audit-raw pre").textContent());
    assert.equal(raw.sequence, 13);
    assert.deepEqual(raw.sourceRef, { log: ".scratch/events.jsonl", seq: 3867 });
    assert.equal(raw.verdict, "pass");
    assert.match(await page.locator(".audit-issues summary").textContent(), /2 warnings/);
    await evidence(page, "recorded-ticket-50");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test("an interrupted load says so and offers the sample; a bad import keeps the previous run", { timeout: 180000 }, async () => {
  const { page, close } = await open({ query: "?replay=team-and-den-ux-50", block: "team-and-den-ux-50" });
  try {
    await sheet(page).locator(".audit-error").waitFor();
    assert.match(await page.locator(".audit-error").textContent(), /did not load/);
    await page.getByRole("button", { name: "Open the sample" }).click();
    await page.locator(".audit-banner-sample").waitFor();
    await page.locator('.audit input[type="file"]').setInputFiles({ name: "next.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ schemaVersion: 7, events: [] })) });
    assert.match(await page.locator(".audit-error").textContent(), /version 7 is not supported.*previous replay is still shown/);
    assert.ok(await page.locator(".audit-banner-sample").isVisible());
    await page.locator('.audit input[type="file"]').setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from("<img src=x onerror=alert(1)>") });
    assert.match(await page.locator(".audit-error").textContent(), /not JSON/);
  } finally { await close(); }
});

test("a slow load that is overtaken by another choice never replaces it", { timeout: 180000 }, async () => {
  const { page, close } = await open({ query: "?replay=sample" });
  try {
    await page.route((url) => url.pathname.includes("team-and-den-ux-50"), async (r) => { await new Promise((ok) => setTimeout(ok, 2500)); await r.continue(); });
    await sheet(page).locator(".audit-banner-sample").waitFor();
    const picker = page.locator(".audit-toolbar select");
    await picker.selectOption("team-and-den-ux-50");
    await picker.selectOption("sample");
    await page.waitForTimeout(3500);
    assert.ok(await page.locator(".audit-banner-sample").isVisible());
    assert.equal(await page.locator(".audit-banner-recorded").count(), 0);
  } finally { await close(); }
});

test("fits a phone with reduced motion: no page overflow and no node animation", { timeout: 180000 }, async () => {
  const { page, close } = await open({ width: 390, query: "?replay=sample", reducedMotion: "reduce" });
  try {
    await sheet(page).locator(".audit-node").first().waitFor();
    await page.locator(".audit-seek").fill("30");
    const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `page overflows by ${overflow}px`);
    const running = await page.evaluate(() => [...document.querySelectorAll(".audit-node")].flatMap((n) => n.getAnimations()).length);
    assert.equal(running, 0);
    await evidence(page, "phone-reduced-motion");
  } finally { await close(); }
});

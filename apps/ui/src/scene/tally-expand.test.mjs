// team-and-den-ux/04: Tally opens as a nonmodal topic sheet from the rail. Real mounted-App
// browser checks keep its metrics, charts, keyboard and scroll behavior covered.
// Spec: handoffs/05-designer-spec-2.md (section 11 lists the criteria; section numbers are cited below).
//
// Markup contract the developer must meet (everything else is free):
//   rail      [data-rail="tally"], aria-expanded, aria-controls=<sheet id>
//   sheet     role="dialog" aria-modal="false" labelled by its "Tally" heading, docked over the scene
//   heading   the "Tally" heading takes focus on open (an h1-h6 inside the dialog)
//   close     a button named "Close panel"
//   body      role="region" aria-label="Tally metrics", tabindex 0, overflow-y auto
//   rows      one element per rod with data-rod = five-hour|week|served|tokens|spills, in that order, carrying
//             data-counted="<0..10>"; the 5 h and Week rows contain an element with data-mark="80"
//   sections  h3 "The rods" and h3 "Pipeline" (the existing <Dashboard> renders under the second)
//   meters    the topic sheet carries two role="meter" rows while open, none while closed
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { buildLaunchOptions } from "../../../ci-cd/launch-options.mjs";
import { lightenScene } from "../../../ci-cd/light-scene.mjs";
import { cameraConfig } from "./procedural/camera.mjs";
import { DEN_TARGET } from "./procedural/bindings.mjs";

const TALLY_RODS_CAPTION = "Tally rods: Served 1 bead = 1 ticket this window; Tokens 1 bead = 20k per ticket; Spills 1 bead = 0.1 per ticket.";
const VIEW = { width: 1280, height: 800 };
const PILL = '[data-rail="tally"]';
const metricsOk = () => ({
  throughput: { windows: [{ start: "2026-09-30T00:00:00Z", resolved: 3 }, { start: "2026-09-30T05:00:00Z", resolved: 6 }] },
  tokensByRole: { developer: { perTicket: 120000 }, qa: { perTicket: 48000 } },
  incidentsByTool: { Bash: { perTicket: 0.2 }, Read: { perTicket: 0.1 } },
});
const usageAt = (fiveHour, weekly) => ({ fiveHour, weekly, sampledAt: new Date(Date.now() - 12 * 60_000).toISOString() });

// One browser and dev server; scenarios run serially with one model-loading GL context at a time.
describe("tally expand", { concurrency: 1 }, () => {
let server;
let browser;
let base;

before(async () => {
  server = await createServer({ configFile: "apps/ui/vite.config.mjs", configLoader: "native", server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  base = server.resolvedUrls.local[0];
  browser = await chromium.launch(buildLaunchOptions());
  // Warm the dev server so Vite's dependency pre-bundling does not reload a page mid-test.
  const warm = await openApp({});
  await warm.page.close();
}, { timeout: 120000 });

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openApp({ usage = usageAt(79, 41), metrics = metricsOk(), metricsStatus = 200, reducedMotion = "no-preference", quiet = false } = {}) {
  const context = await browser.newContext({ viewport: VIEW, reducedMotion });
  // organism-infra/94: software GL rasterising the scene is what made these clicks flake on CI; see light-scene.mjs.
  await lightenScene(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // One active ticket by default: with none, the "den is quiet" caption is shown (see the quiet-den test).
  const active = { ref: "demo/01-add-login", feature: "demo", title: "add-login", type: "feature", status: "claimed", ready: false, holder: { role: "developer", since: "2026-09-29T05:00:00.000Z" }, lastRole: null, gate: null, blockedBy: [] };
  const snapshot = { schema: 1, seq: 1, tickets: quiet ? [] : [active], frontier: [], usage, requests: [] };
  await page.addInitScript((snap) => {
    class FakeEventSource {
      constructor() {
        this.l = {};
        setTimeout(() => {
          this.onopen?.();
          for (const f of this.l.snapshot ?? []) f({ data: JSON.stringify(snap) });
        }, 0);
      }
      addEventListener(type, fn) { (this.l[type] ??= []).push(fn); }
      close() {}
    }
    window.EventSource = FakeEventSource;
  }, snapshot);
  await page.route((url) => url.pathname === "/state", (r) => r.fulfill({ json: snapshot }));
  await page.route((url) => url.pathname === "/metrics", (r) =>
    metricsStatus === 200 ? r.fulfill({ json: metrics }) : r.fulfill({ status: metricsStatus, body: "boom" }));
  await page.goto(base);
  await page.locator(PILL).waitFor({ state: "visible", timeout: 30000 });
  page.setDefaultTimeout(20000);
  return { page, context, errors, pill: page.locator(PILL), scene: page.locator('main[aria-label="Den scene"]') };
}

const dialogOf = (page) => page.getByRole("dialog", { name: "Tally" });
const scrollState = (page) =>
  page.evaluate(() => ({ doc: document.scrollingElement.scrollTop, scene: document.querySelector("main.scene").scrollTop }));
const focusInfo = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a.tagName, text: a.textContent.trim().slice(0, 40), cls: a.className, inDialog: !!a.closest('[role="dialog"]') };
  });
const settle = (page) => page.waitForTimeout(450);

// Screen position of a world point at the app's default frame, in page pixels of the garden canvas. The camera is orthographic and centred on DEN_TARGET: pixels per unit is the viewport
// height over the frustum height, and the iso pitch squashes depth by sin and lifts height by cos.
function screenOf(sceneBox, x, y, z, target = DEN_TARGET) {
  const c = cameraConfig({ width: sceneBox.width, height: sceneBox.height });
  const k = sceneBox.height / (c.top - c.bottom), pitch = Math.atan(1 / Math.SQRT2);
  const [tx, ty, tz] = target;
  return {
    x: sceneBox.x + sceneBox.width / 2 + k * (x - tx),
    y: sceneBox.y + sceneBox.height / 2 + k * ((z - tz) * Math.sin(pitch) - (y - ty) * Math.cos(pitch)),
  };
}

test("click on the Tally rail entry opens its nonmodal sheet and focuses the heading without scrolling the page (criterion 1)", { timeout: 90000 }, async () => {
  const { page, pill, context, errors } = await openApp();
  try {
    assert.equal(await pill.getAttribute("aria-label"), "Tally");
    assert.equal(await pill.getAttribute("aria-expanded"), "false");
    assert.equal(await dialogOf(page).count(), 0, "closed: no dialog");
    const before = await scrollState(page);
    await pill.click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    assert.equal(await pill.getAttribute("aria-expanded"), "true");
    assert.equal(await pill.getAttribute("aria-controls"), await dialog.getAttribute("id"));
    assert.equal(await dialog.getAttribute("aria-modal"), "false");
    assert.ok(await dialog.evaluate((el) => !!el.closest('.forest-shell')), "Tally is mounted in the shell");
    const f = await focusInfo(page);
    assert.match(f.tag, /^H[1-6]$/, "focus moves to a heading");
    assert.equal(f.text, "Tally");
    assert.equal(f.inDialog, true);
    assert.deepEqual(await scrollState(page), before, "document and scene scrollTop unchanged");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const key of ["Enter", "Space"]) {
  test(`${key} on the focused rail entry opens Tally without scrolling the page`, { timeout: 90000 }, async () => {
    const { page, pill, context } = await openApp();
    try {
      await pill.focus();
      const before = await scrollState(page);
      await page.keyboard.press(key);
      await dialogOf(page).waitFor({ state: "visible" });
      assert.equal(await pill.getAttribute("aria-expanded"), "true");
      assert.equal((await focusInfo(page)).text, "Tally");
      assert.deepEqual(await scrollState(page), before);
    } finally {
      await context.close();
    }
  });
}

test("a quiet den with thirty-two resting residents does not block Tally from opening", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp({ quiet: true });
  try {
    assert.match(await page.getByLabel("Garden activity").innerText(), /0 working[\s\S]*32 resting/, "quiet state retains the resident activity legend");
    await pill.click();
    await dialogOf(page).waitFor({ state: "visible" });
  } finally {
    await context.close();
  }
});

test("a click on the abacus in the scene opens the Tally sheet, and another click leaves it open", { timeout: 90000 }, async () => {
  const { page, pill, scene, context } = await openApp();
  try {
    await page.waitForFunction(() => document.querySelector('.den-entry button') && document.querySelector('.den-entry button').getAttribute('aria-disabled') !== 'true', null, { timeout: 60000 });
    await page.waitForFunction(async () => {
      const url = performance.getEntriesByType('resource').find(r => r.name.includes('@react-three_fiber'))?.name;
      if (!url) return false;
      const { _roots } = await import(url);
      const state = _roots.get(document.querySelector('canvas'))?.store.getState();
      return state?.gl.info.render.frame > 1 && !!state.camera.userData.viewport;
    });
    const box = await page.locator('.forest-canvas').boundingBox();
    // Hit the solid right frame of the garden court abacus.
    const mid = screenOf(box, 5.05, 1.41, 13);
    await page.mouse.click(mid.x, mid.y);
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    assert.equal(await pill.getAttribute("aria-expanded"), "true");
    await settle(page);
    await page.mouse.click(mid.x, mid.y);
    await settle(page);
    assert.equal(await dialog.isVisible(), true, "a stray click on the 3D object never closes the view");
    assert.equal(await pill.getAttribute("aria-expanded"), "true");
  } finally {
    await context.close();
  }
});

test("Escape, Close panel and the rail entry each close Tally and return focus to the opener", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp();
  try {
    const dialog = dialogOf(page);
    // Esc with focus inside the card
    await pill.click();
    await dialog.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await pill.getAttribute("aria-expanded"), "false");
    assert.ok((await focusInfo(page)).cls.includes("den-rail-entry"), "Esc returns focus to the rail entry");
    // Close button
    await pill.click();
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Close panel" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await pill.getAttribute("aria-expanded"), "false");
    assert.ok((await focusInfo(page)).cls.includes("den-rail-entry"), "Close returns focus to the rail entry");
    // The rail entry again toggles it shut.
    await pill.click();
    await dialog.waitFor({ state: "visible" });
    await pill.click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await pill.getAttribute("aria-expanded"), "false");
    assert.ok((await focusInfo(page)).cls.includes("den-rail-entry"));
  } finally {
    await context.close();
  }
});

test("Escape closes the nonmodal topic sheet even when focus is on the scene", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp();
  try {
    await pill.click();
    await dialogOf(page).waitFor({ state: "visible" });
    await page.evaluate(() => document.querySelector("main").focus());
    await page.keyboard.press("Escape");
    await dialogOf(page).waitFor({ state: "hidden" });
    assert.equal(await pill.getAttribute("aria-expanded"), "false");
  } finally {
    await context.close();
  }
});

test("the live scene remains usable beside the nonmodal Tally sheet", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp();
  try {
    await pill.click();
    await dialogOf(page).waitFor({ state: "visible" });
    await settle(page);
    await page.mouse.move(1000, 500);
    await page.mouse.down();
    await page.mouse.up();
    assert.equal(await dialogOf(page).isVisible(), true, "an outside pointer does not dismiss the sheet");
    assert.equal(await pill.getAttribute("aria-expanded"), "true");
    assert.equal(await dialogOf(page).getAttribute("aria-modal"), "false");
  } finally {
    await context.close();
  }
});

test("the scene's accessible usage meters move into the Tally sheet without duplicates", { timeout: 90000 }, async () => {
  const { page, pill, scene, context } = await openApp({ usage: usageAt(79, 41) });
  try {
    const read = (loc) =>
      loc.evaluateAll((els) => els.map((e) => ({
        label: e.getAttribute("aria-label"),
        min: e.getAttribute("aria-valuemin"),
        max: e.getAttribute("aria-valuemax"),
        now: e.getAttribute("aria-valuenow"),
        tabindex: e.getAttribute("tabindex"),
      })));
    const want = [
      { label: "5-hour window 79%", min: "0", max: "100", now: "79", tabindex: null },
      { label: "Week 41%", min: "0", max: "100", now: "41", tabindex: null },
    ];
    assert.deepEqual(await read(page.getByRole("meter")), want, "closed: the abacus has two accessible meter twins");
    assert.equal(await page.locator('[data-sheet] [data-rod]').count(), 0, "the closed topic has no rod rows");
    await pill.click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    const open = await read(page.getByRole("meter"));
    assert.equal(open.length, 2, "open: exactly the two usage rows");
    assert.deepEqual(open.map((m) => [m.label, m.now]), [["5-hour window 79%", "79"], ["Week 41%", "41"]]);
    assert.equal(await dialog.getByRole("meter").count(), 2, "open: they are the sheet's rows");
    for (const m of open) assert.deepEqual([m.min, m.max], ["0", "100"]);
    await page.keyboard.press('Escape');
    assert.deepEqual(await read(page.getByRole('meter')), want, 'closing restores the scene meter twins');
  } finally {
    await context.close();
  }
});

test("card rows: five in order with the counted-bead counts and the 80% mark on 5 h and Week only (criterion 5)", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp({ usage: usageAt(79, 41) });
  try {
    await pill.click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    const rows = await dialog.locator("[data-rod]").evaluateAll((els) =>
      els.map((e) => ({
        id: e.getAttribute("data-rod"),
        counted: e.getAttribute("data-counted"),
        mark: e.querySelectorAll('[data-mark="80"]').length,
        text: e.innerText.replace(/\s+/g, " "),
      })));
    assert.deepEqual(rows.map((r) => r.id), ["five-hour", "week", "served", "tokens", "spills"]);
    assert.deepEqual(rows.map((r) => r.counted), ["8", "4", "6", "4", "3"]);
    assert.deepEqual(rows.map((r) => r.mark > 0), [true, true, false, false, false]);
    const [five, week, served, tokens, spills] = rows;
    assert.match(five.text, /5 h/); assert.match(five.text, /79%/);
    assert.match(week.text, /Week/); assert.match(week.text, /41%/);
    assert.match(served.text, /Served/); assert.match(served.text, /6 tickets/);
    assert.match(tokens.text, /Tokens/); assert.match(tokens.text, /84k \/ ticket/);
    assert.match(spills.text, /Spills/); assert.match(spills.text, /0\.3 \/ ticket/);
    const text = await dialog.innerText();
    assert.ok(text.includes(TALLY_RODS_CAPTION), "the scale caption lives in the card");
    assert.match(text, /Sampled 12 min ago/);
    assert.equal(await dialog.getByRole("heading", { name: "The rods" }).count(), 1);
    assert.equal(await dialog.getByRole("heading", { name: "Pipeline" }).count(), 1);
    assert.equal(await dialog.locator("figure.chart").count(), 3, "the three Dashboard charts are in the card");
    const region = dialog.getByRole("region", { name: "Tally metrics" });
    assert.equal(await region.getAttribute("tabindex"), "0");
    const sheetBody = dialog.locator('.den-sheet-body');
    assert.equal(await sheetBody.evaluate((el) => getComputedStyle(el).overflowY), "auto", "the sheet body owns vertical scrolling");
    const scroll = await sheetBody.evaluate((el) => { el.scrollTop = 120; return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }; });
    if (scroll.max > 0) assert.ok(scroll.top > 0, "metrics scroll inside the sheet body");
  } finally {
    await context.close();
  }
});

test("usage at 96 shows At limit and ten counted beads; 86 shows Wind down; below 80 shows neither (criterion 5)", { timeout: 90000 }, async () => {
  for (const [fiveHour, status, counted] of [[96, "At limit", "10"], [86, "Wind down", "9"], [79, null, "8"]]) {
    const { page, pill, context } = await openApp({ usage: usageAt(fiveHour, 41) });
    try {
      await pill.click();
      const row = dialogOf(page).locator('[data-rod="five-hour"]');
      await row.waitFor({ state: "visible" });
      assert.equal(await row.getAttribute("data-counted"), counted, `${fiveHour}%`);
      const text = await row.innerText();
      if (status) assert.match(text, new RegExp(status), `${fiveHour}%`);
      else assert.doesNotMatch(text, /At limit|Wind down/);
    } finally {
      await context.close();
    }
  }
});

test("no usage sample: 5 h and Week read 'not sampled' with no valuenow and no Sampled line (criterion 6)", { timeout: 90000 }, async () => {
  const { page, pill, scene, context } = await openApp({ usage: null });
  try {
    const labels = () => page.getByRole("meter").evaluateAll((els) => els.map((e) => [e.getAttribute("aria-label"), e.getAttribute("aria-valuenow")]));
    assert.deepEqual(await labels(), [["5-hour window not sampled", null], ["Week not sampled", null]], "closed twins");
    await pill.click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    assert.deepEqual(await labels(), [["5-hour window not sampled", null], ["Week not sampled", null]], "open rows");
    for (const id of ["five-hour", "week"]) {
      const row = dialog.locator(`[data-rod="${id}"]`);
      assert.equal(await row.getAttribute("data-counted"), "0");
      assert.match(await row.innerText(), /not sampled/);
    }
    assert.doesNotMatch(await dialog.innerText(), /Sampled \d+ min ago/);
  } finally {
    await context.close();
  }
});

test("metrics loading (empty): Served, Tokens and Spills read 'no data' and the charts say 'No data yet' (criterion 6)", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp({ metrics: {} });
  try {
    await pill.click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    for (const id of ["served", "tokens", "spills"]) {
      const row = dialog.locator(`[data-rod="${id}"]`);
      assert.equal(await row.getAttribute("data-counted"), "0", id);
      assert.match(await row.innerText(), /no data/, id);
    }
    assert.match(await dialog.innerText(), /No data yet/);
    assert.equal(await dialog.locator('[data-rod="five-hour"]').getAttribute("data-counted"), "8", "usage unaffected");
  } finally {
    await context.close();
  }
});

test("metrics error: three rows read 'unavailable', the alert with Retry stays in the Pipeline section, usage rows unaffected (criterion 6)", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp({ metricsStatus: 500 });
  try {
    await pill.click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    for (const id of ["served", "tokens", "spills"]) {
      const row = dialog.locator(`[data-rod="${id}"]`);
      assert.equal(await row.getAttribute("data-counted"), "0", id);
      assert.match(await row.innerText(), /unavailable/, id);
    }
    const alert = dialog.getByRole("alert");
    assert.match(await alert.innerText(), /Metrics unavailable/);
    assert.equal(await alert.getByRole("button", { name: "Retry" }).count(), 1);
    assert.match(await dialog.locator('[data-rod="five-hour"]').innerText(), /79%/);
  } finally {
    await context.close();
  }
});

test("arrow keys, + and - pressed inside the card do not reach the camera rig (criterion 7)", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp();
  try {
    await pill.click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    const prevented = (selector, key) =>
      page.evaluate(([sel, k]) => {
        const target = sel === "main" ? document.querySelector("main") : document.querySelector(sel);
        const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return ev.defaultPrevented;
      }, [selector, key]);
    for (const key of ["ArrowLeft", "ArrowRight", "+", "-"]) {
      assert.equal(await prevented('[role="dialog"] button[aria-label="Close panel"]', key), false, `${key} on Close`);
      assert.equal(await prevented('[role="dialog"] [role="region"]', key), false, `${key} on the scroll region`);
    }
    // Control: the same key on the scene itself does move the camera (so the probe is valid).
    assert.equal(await prevented("main", "ArrowRight"), true, "ArrowRight on the scene is handled by the camera rig");
  } finally {
    await context.close();
  }
});

test("placement: the Tally sheet stays within the shell and overlays the live scene", { timeout: 90000 }, async () => {
  const { page, pill, scene, context } = await openApp();
  try {
    await pill.click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    await settle(page);
    const d = await dialog.boundingBox();
    const rail = await page.getByRole('navigation', { name: 'Den' }).boundingBox();
    const shell = await page.locator('.forest-shell').boundingBox();
    const garden = await scene.boundingBox();
    assert.ok(d.x >= rail.x + rail.width && d.x + d.width <= shell.x + shell.width, "sheet is bounded after the rail");
    assert.ok(d.y >= shell.y && d.y + d.height <= shell.y + shell.height, "sheet is bounded vertically");
    assert.ok(d.x < garden.x + garden.width, "the sheet overlays rather than resizes the scene");
  } finally {
    await context.close();
  }
});

test("reduced motion: the card shows with no transform transition and no animation (criterion 8)", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp({ reducedMotion: "reduce" });
  try {
    await pill.click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    const style = await dialog.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { prop: cs.transitionProperty, anim: cs.animationName };
    });
    assert.doesNotMatch(style.prop, /transform|all/, `transition-property ${style.prop}`);
    assert.equal(style.anim, "none");
  } finally {
    await context.close();
  }
});

test("the cards have no Pipeline or usage slot, and the Dashboard charts are mounted once (criterion 9)", { timeout: 90000 }, async () => {
  const { page, pill, context } = await openApp();
  try {
    const sidebar = () =>
      page.evaluate(() => ({
        h2: [...document.querySelectorAll(".card h2")].map((h) => h.textContent.trim()),
        dashboardSlot: document.querySelectorAll('.card [data-slot="dashboard"]').length,
        charts: document.querySelectorAll(".card figure.chart").length,
      }));
    const closed = await sidebar();
    assert.ok(!closed.h2.some((h) => /Plan usage/.test(h)), `no usage slot on the cards: ${closed.h2}`);
    assert.ok(!closed.h2.some((h) => /Pipeline/.test(h)), `no Pipeline slot: ${closed.h2}`);
    assert.equal(closed.dashboardSlot, 0);
    assert.equal(closed.charts, 0);
    await pill.click();
    await dialogOf(page).waitFor({ state: "visible" });
    const ids = await page.evaluate(() => [...document.querySelectorAll('[id^="chart-title-"]')].map((e) => e.id));
    assert.equal(ids.length, 3, `chart title ids: ${ids}`);
    assert.equal(new Set(ids).size, 3, "no duplicate chart ids");
    assert.equal((await sidebar()).charts, 0, "still none on the cards when the Tally is open");
  } finally {
    await context.close();
  }
});
});

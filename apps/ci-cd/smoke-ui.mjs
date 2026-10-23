// dimsumden-ui-v0/13: `npm run smoke:ui`, the end-to-end smoke of bridge + UI on a fixture board.
// Builds the UI, starts the bridge on a disposable .scratch/ tree (the bridge test fixture),
// loads the UI with smoke.mjs --url (clean load), then drives it in a headless browser and checks
// the scene count, the queue order, a chart and one Approve round trip. One PASS/FAIL line per
// check; exits non-zero on any FAIL.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateFixture, FEATURE, HANDLED_ID } from "../bridge/bridge-fixture.mjs";
import { startBridge } from "../bridge/server.mjs";
import { buildLaunchOptions } from "./launch-options.mjs";
import { lightenScene } from "./light-scene.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

// Expected values are literals worked out from the fixture (see bridge-fixture.mjs), not
// recomputed from the snapshot.
//  Scene: one chip per active ticket (04 in-review, 05 blocked, 06 ready-for-human) plus one "Queued" chip per
//  frontier basket on the table (02, 07, 08; den-v1, kept by the user 2026-10-03) = 6; the tally chip is not an agent chip.
const EXPECTED_CHIPS = 6;
//  Queue: frontier by priority. 02 is P0; 07 is P1 (no aging bump since queue/06,
//  so it follows 02 by priority); 08 has no priority (P2).
const EXPECTED_QUEUE_HEAD = ["02: Ready P0", "07: Bumpable", "08: Plain"];
const MERGE_REF = `${FEATURE}/04-review`;

const results = [];
function report(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    report(name, true, detail);
  } catch (err) {
    report(name, false, err?.message ?? String(err));
  }
}
function expectEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.once("error", (err) => resolve({ code: 1, out: String(err) }));
    child.once("exit", (code) => resolve({ code, out }));
  });
}

async function launch(chromium) {
  let last;
  for (const channel of ["chrome", "msedge", undefined]) {
    try {
      return await chromium.launch(buildLaunchOptions(channel));
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("smoke:ui: playwright not installed, run npm install && npx playwright install chromium");
    return 1;
  }

  const build = await runCommand("npm", ["run", "ui:build"]);
  if (build.code !== 0) {
    report("build", false, `npm run ui:build exited ${build.code}\n${build.out}`);
    return 1;
  }

  const fx = await makeStateFixture();
  // Drop the pending request on the merge ticket so its Approve button is live.
  const reqFile = path.join(fx.root, ".scratch", "_requests", "requests.jsonl");
  const kept = (await readFile(reqFile, "utf8")).split("\n").filter((l) => l && !l.includes(MERGE_REF));
  await writeFile(reqFile, kept.join("\n") + "\n");

  // organism-infra/139: POST /requests needs a session, so the page opens with a launch code like a real user.
  const launchCode = randomBytes(32).toString("base64url");
  const bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode } });
  let browser;
  try {
    const load = await runCommand("node", ["apps/ci-cd/smoke.mjs", "--url", `${bridge.url}/`]);
    report("load", load.code === 0, load.code === 0 ? "" : load.out.trim());

    browser = await launch(chromium);
    const context = await browser.newContext();
    // organism-infra/94: the software-rendered scene made the Tally click flake on CI. The clean load above (smoke.mjs
    // --url) already ran with real draws; these checks read the DOM, so draws are skipped here. See light-scene.mjs.
    await lightenScene(context);
    // Headless pointer capture can emit OS recentering deltas after the pan
    // scenario. Exercise the supported drag-to-look fallback so W movement is
    // measured from the authored entry view, independent of the window manager.
    await context.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = undefined; });
    const page = await context.newPage();
    const requested = [];
    page.on("request", (r) => requested.push(r.url()));
    await page.goto(`${bridge.url}/#code=${launchCode}`, { waitUntil: "load" });
    await page.locator("[data-rail=work]").click();
    await page.waitForSelector("[data-overlay=teams] .queue-row", { timeout: 15000 });

    await check("font: Long Cang is self-hosted, no Google Fonts request", async () => {
      const loaded = await page.evaluate(async () => {
        await document.fonts.load("44px 'Long Cang'");
        return document.fonts.check("44px 'Long Cang'") && [...document.fonts].some((f) => f.family.includes("Long Cang") && f.status === "loaded");
      });
      if (!loaded) throw new Error("Long Cang did not load from the bundled woff2");
      const google = requested.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u));
      if (google.length) throw new Error("Google Fonts requested: " + google.join(", "));
      return "bundled woff2, 0 Google requests";
    });

    await check("scene: one chip per active ticket", async () => {
      await page
        .waitForFunction((n) => document.querySelectorAll(".chip-layer .chip:not(.chip-tally)").length === n, EXPECTED_CHIPS, { timeout: 10000 })
        .catch(() => {});
      expectEqual(await page.locator(".chip-layer .chip:not(.chip-tally)").count(), EXPECTED_CHIPS, "chips");
      return `${EXPECTED_CHIPS} chips`;
    });

    await check("queue: frontier in priority order", async () => {
      const titles = await page.locator("[data-overlay=teams] .queue-rows").first().locator(".queue-title").allTextContents();
      expectEqual(titles, EXPECTED_QUEUE_HEAD, "frontier titles");
    });

    await check("chart: the Tally card opens in place and its pipeline charts render with an accessible title", async () => {
      await page.locator("[data-rail=tally]").click({ timeout: 10000 });
      await page.waitForSelector("[data-sheet=topic] figure.chart svg[role=img]", { timeout: 10000 });
      const n = await page.locator("[data-sheet=topic] figure.chart svg[role=img]").count();
      if (n < 1) throw new Error("no chart rendered");
      const title = (await page.locator("[data-sheet=topic] figure.chart figcaption").first().textContent())?.trim();
      if (!title) throw new Error("chart has no title");
      await page.keyboard.press("Escape");
      return `${n} charts`;
    });

    await check("approve: round trip writes a merge-approve request and the card shows it pending", async () => {
      // den-scene-v1/07: the Needs you card shows one request at a time; pick the merge ticket's if another leads.
      await page.locator("[data-rail=needs]").click();
      const card = page.locator("[data-overlay=needs-you]");
      const short = MERGE_REF.slice(MERGE_REF.indexOf("/") + 1);
      if (!(await card.locator(".needs-title", { hasText: short }).count())) await card.locator(".request-row", { hasText: short }).click();
      await card.getByRole("button", { name: /^Approve/ }).click();
      await card.getByText("Approval sent, waiting for the orchestrator").waitFor({ timeout: 10000 });
      const rows = (await readFile(reqFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const req = rows.find((r) => r.ref === MERGE_REF && r.id !== HANDLED_ID);
      expectEqual(req?.kind, "merge-approve", "request kind");
      await page.keyboard.press("Escape");
    });

    // den-iso-v1/02: the orthographic camera. Observables are the four team signs (`.team-label`, placed by
    // projecting each kiosk's roof apex) and the Tally chip, measured against the scene box (`main.scene`).
    // Expected values are literals: at the default zoom every team sign of the restaurant scene (site plan, den-layout/02) is in
    // view at 1440x900 and at 375x667; wheel zoom is exponential (zoom *= exp(deltaY / 1000), procedural/camera.mjs) so signs spread by 1/d; a drag of dx px shifts every
    // sign by dx px (an orthographic camera moves the whole scene rigidly).
    const sceneProbe = () =>
      page.evaluate(() => {
        const scene = document.querySelector("main.scene").getBoundingClientRect();
        const rel = (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2 - scene.left, y: r.top + r.height / 2 - scene.top, left: r.left - scene.left, right: r.right - scene.left, top: r.top - scene.top, bottom: r.bottom - scene.top };
        };
        const signs = {},projected={};
        for (const el of document.querySelectorAll(".chip-layer .team-label")) {
          projected[el.textContent.trim()]=rel(el);
          if (getComputedStyle(el).visibility === "visible") signs[el.textContent.trim()] = rel(el);
        }
        const chips = {};
        for (const el of document.querySelectorAll(".chip-layer .chip[data-ref]")) {
          if (getComputedStyle(el).visibility === "visible") chips[el.dataset.ref] = rel(el);
        }
        return { width: scene.width, height: scene.height, signs, projected, chips };
      });
    const settle = async (predicate, what) => {
      const deadline = Date.now() + 6000;
      let last;
      while (Date.now() < deadline) {
        last = await sceneProbe();
        if (predicate(last)) return last;
        await page.waitForTimeout(150);
      }
      throw new Error(`${what}: not reached within 6 s; last ${JSON.stringify(last)}`);
    };
    const fits = (p) => {
      const names = ["The Pass", "Steamers", "Front of House", "Tea & Pantry", "Library"];
      if (!names.every((n) => p.signs[n])) return false;
      const all = names.map((n) => p.signs[n]);
      return all.every((r) => r.left >= 0 && r.right <= p.width && r.top >= 0 && r.bottom <= p.height);
    };

    await check("camera fit: every kiosk sign is in the scene at 1440x900", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const p = await settle(fits, "1440x900 fit");
      return `${Object.keys(p.signs).length} signs inside ${Math.round(p.width)}x${Math.round(p.height)}`;
    });

    // The phone shell keeps its rail beside the scene without horizontal scrolling.
    await check("camera fit: every kiosk sign is in the scene at 375x667", async () => {
      await page.setViewportSize({ width: 375, height: 667 });
      const p = await settle((q) => q.width <= 375 && q.height <= 667 && fits(q), "375x667 fit");
      const layout = await page.evaluate(() => {
        const garden=document.querySelector('main.scene').getBoundingClientRect();
        const rail=document.querySelector('.den-rail').getBoundingClientRect();
        return {gardenLeft:garden.left,railRight:rail.right,width:document.body.scrollWidth};
      });
      if(layout.gardenLeft<layout.railRight||layout.width>375)throw new Error('Phone scene and rail overlap or overflow: '+JSON.stringify(layout));
      return `${Object.keys(p.signs).length} signs inside ${Math.round(p.width)}x${Math.round(p.height)}`;
    });

    await check("camera zoom: wheel zoom scales the sign spacing by 1/d (exponential) and stays within the range", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      // The signs follow a resize a few frames late (longer under load): the first probe can still show the
      // phone-sized layout from the previous check, which also "fits". Take the baseline only once the signs are
      // settled at the approved target x=-6. Team plots flank x=±30.5;
      // their midpoint therefore projects six scene units right of the target.
      const centred = (p) => p.signs["Steamers"] && p.signs["Tea & Pantry"] && Math.abs((p.signs["Steamers"].x + p.signs["Tea & Pantry"].x) / 2 - p.width / 2 - (p.signs["Tea & Pantry"].x-p.signs["Steamers"].x)*6/61) < 2;
      const base = await settle((p) => centred(p) && fits(p), "default frame before zoom");
      // Projected positions remain measurable when close zoom clips the outer signs.
      const gap = (p) => p.projected["Tea & Pantry"].x - p.projected["Steamers"].x;
      const box = await page.locator('.forest-canvas canvas').boundingBox();
      await page.mouse.move(box.x + box.width * .85, box.y + box.height * .15);
      await page.mouse.wheel(0, -300); // exponential: zoom factor 1 -> exp(-0.3) = 0.7408, so 1/0.7408 = 1.3499 times wider
      const zoomed = await settle((p) => Math.abs(gap(p) / gap(base) - 1.3499) < 0.03, "zoom in by exp(-0.3)");
      await page.mouse.wheel(0, -5000); // close zoom allows inspection of the personal workstations
      const nearest = await settle((p) => Math.abs(gap(p) / gap(base) - 1/.55) < 0.04, "zoom clamps at 0.55");
      await page.mouse.wheel(0, 20000); // clamps at 1.2: 1/1.2 = 0.833
      const farthest = await settle((p) => Math.abs(gap(p) / gap(base) - 1 / 1.2) < 0.03, "zoom clamps at 1.2");
      return `spacing x${(gap(zoomed) / gap(base)).toFixed(3)}, x${(gap(nearest) / gap(base)).toFixed(3)} (nearest), x${(gap(farthest) / gap(base)).toFixed(3)} (farthest)`;
    });

    await check("camera pan: dragging 100 px right moves every sign 100 px right", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const wheelBox=await page.locator('.forest-canvas canvas').boundingBox();
      await page.mouse.move(wheelBox.x+wheelBox.width*.85,wheelBox.y+wheelBox.height*.15);
      await page.mouse.wheel(0, -780.1586); // factor 1.2 -> .55: keep both flanking signs visible while panning
      await settle((p) => p.signs["Steamers"] && p.signs["Tea & Pantry"] && p.signs["Tea & Pantry"].x - p.signs["Steamers"].x > 350, "zoomed in");
      await page.waitForTimeout(800); // let the rig's easing finish before measuring
      const start = await sceneProbe();
      const names = Object.keys(start.signs).filter((n) => start.signs[n].left >= 4 && start.signs[n].right + 110 <= start.width);
      if (names.length<2) throw new Error("expected at least two signs on screen with room to pan, got " + JSON.stringify(names));
      const box = await page.locator("main.scene").boundingBox();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 50, cy, { steps: 5 });
      await page.mouse.move(cx + 100, cy, { steps: 5 });
      await page.mouse.up();
      const after = await settle((p) => names.every((n) => p.signs[n] && Math.abs(p.signs[n].x - start.signs[n].x - 100) < 4), "drag by 100 px");
      for (const n of names) {
        if (Math.abs(after.signs[n].y - start.signs[n].y) > 4) throw new Error(`${n} sign moved vertically by ${after.signs[n].y - start.signs[n].y}`);
      }
      return `${names.length} signs shifted ${Math.round(after.signs[names[0]].x - start.signs[names[0]].x)} px`;
    });

    // den-v1/03, back for den-layout/04: Enter the den switches to a first-person camera in the restaurant scene, WASD
    // moves it, Esc returns the diorama camera to the frame it left. Observables: the button's aria-pressed, the
    // crosshair, and the team signs, which ChipLayer projects through whichever camera is live (the walker's
    // perspective camera moves them; the diorama's does not).
    await check("walk: Enter the den, move with W, Esc returns the diorama to the same frame", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(800); // the diorama's easing has finished
      const enter = page.getByRole("button", { name: "Enter the den" });
      await page.waitForFunction(() => !document.querySelector(".den-entry button")?.hasAttribute("aria-disabled"), null, { timeout: 15000 });
      // Signs and chips both: at real frame rates (PW_GPU=1) the team signs leave the walker's view within a second.
      const round = (p) => Object.fromEntries(Object.entries({ ...p.signs, ...p.chips }).map(([n, r]) => [n, [Math.round(r.x), Math.round(r.y)]]));
      const before = await sceneProbe();
      await enter.click();
      await page.waitForSelector('.den-entry button[aria-pressed="true"]', { timeout: 5000 });
      expectEqual(await page.locator(".den-entry button[aria-pressed]").getAttribute("aria-pressed"), "true", "button pressed in walk mode");
      await page.waitForTimeout(500);
      const standing = round(await sceneProbe());
      // Hold W until the view has moved (the software-rendered scene runs at a few frames a second, so poll, don't sleep).
      await page.keyboard.down("KeyW");
      let walked = standing;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && JSON.stringify(walked) === JSON.stringify(standing)) {
        await page.waitForTimeout(250);
        walked = round(await sceneProbe());
      }
      await page.keyboard.up("KeyW");
      if (JSON.stringify(walked) === JSON.stringify(standing)) throw new Error("W did not move the view in 8 s: " + JSON.stringify(standing));
      await page.keyboard.press("Escape");
      await page.waitForSelector(".den-crosshair[hidden]", { state: "attached", timeout: 5000 });
      expectEqual(await page.locator(".den-entry button[aria-pressed]").getAttribute("aria-pressed"), "false", "button after Esc");
      const names = Object.keys(before.signs);
      const back = await settle((p) => names.every((n) => p.signs[n] && Math.abs(p.signs[n].x - before.signs[n].x) < 2 && Math.abs(p.signs[n].y - before.signs[n].y) < 2), "diorama frame restored after Esc");
      return `view moved while walking, ${names.length} signs back within 2 px after Esc (${Math.round(back.width)}x${Math.round(back.height)})`;
    });
  } finally {
    await browser?.close();
    await bridge.close();
    await fx.cleanup();
  }
  return results.every(Boolean) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });

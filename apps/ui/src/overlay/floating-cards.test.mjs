// Mounted-App regression coverage for board/session behavior, zoom, keyboard access and the
// full-window shell. Layout assertions follow the signed-off rail and docked-sheet model.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { buildLaunchOptions } from "../../../ci-cd/launch-options.mjs";
import { lightenScene } from "../../../ci-cd/light-scene.mjs";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const ZOOM_NEAREST = 0.25;
const ZOOM_FARTHEST = 1.2;
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

// One browser and dev server; the model-loading scenarios use one context at a time.
describe("full-window den shell", { concurrency: 1 }, () => {
let server;
let browser;
let base;

before(async () => {
  server = await createServer({ configFile: "apps/ui/vite.config.mjs", configLoader: "native", server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  base = server.resolvedUrls.local[0];
  browser = await chromium.launch(buildLaunchOptions());
  const warm = await openApp({});
  await warm.context.close();
}, { timeout: 120000 });

after(async () => {
  await browser?.close();
  await server?.close();
});

const ticket = (n, slug, extra = {}) => ({
  ref: `demo/${n}-${slug}`, feature: "demo", title: slug, type: "feature", status: "claimed", ready: false,
  holder: null, lastRole: null, gate: null, blockedBy: [], priority: "P1", effectivePriority: "P1", bumped: false, ...extra,
});

function fixture() {
  const since = new Date(Date.now() - 2 * 60_000).toISOString();
  return {
    schema: 1, seq: 1, usage: { fiveHour: 79, weekly: 41, sampledAt: new Date(Date.now() - 12 * 60_000).toISOString() }, requests: [],
    tickets: [
      ticket("01", "add-login", { holder: { role: "developer", since } }),
      ticket("02", "verify-it", { holder: { role: "qa", since }, gate: "merge" }),
      ticket("03", "ship-it", { holder: { role: "designer", since }, gate: "dispatch", status: "in-review" }),
      ticket("04", "odd-job", { holder: { role: "intern", since } }),
      ticket("05", "next-up", { status: "ready", ready: true, effectivePriority: "P0", priority: "P0" }),
      ticket("06", "later-on", { status: "ready", ready: true, effectivePriority: "P2", priority: "P2" }),
    ],
    frontier: ["demo/05-next-up", "demo/06-later-on"],
    capacity: { max: 8, cap: 8, load: 0, live: 0, room: 8, refs: [] }, // organism-infra/228: the bridge always sends it; Run is enabled, so the tab-order walk reaches it
  };
}
const quietSnapshot = () => ({ schema: 1, seq: 1, tickets: [], frontier: [], usage: null, requests: [] });

// organism-infra/139: the bridge now gates POST /requests behind a session. The stub plays the bridge's side:
// POST /session redeems LAUNCH_CODE for SESSION_TOKEN, and POST /requests answers 401 unless the request carries
// `Authorization: Bearer <SESSION_TOKEN>`, so every existing Approve/Deny test below also proves the Bearer is sent.
// `code: null` opens the page with no fragment (a reload, or a used-up link); `sessionStatus` makes /session refuse.
const LAUNCH_CODE = "test-launch-code";
const SESSION_TOKEN = "tok-ui-session-0123456789abcdef0123456789abcdef";

async function openApp({ snapshot = fixture(), viewport = DESKTOP, hasTouch = false, isMobile = false, code = LAUNCH_CODE, sessionStatus = 200 } = {}) {
  // isMobile gives a coarse pointer, which the 44px touch-target rules key on.
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", hasTouch: hasTouch || isMobile, isMobile });
  // organism-infra/94: software GL rasterising the scene starves Playwright clicks (test 18 clicks 80 times); see
  // ci-cd/light-scene.mjs. These tests read DOM only, never pixels.
  await lightenScene(context);
  const page = await context.newPage();
  const errors = [];
  const posts = [];
  const sessions = []; // POST /session bodies
  const unauth = []; // POST /requests that arrived without the right Bearer
  page.on("pageerror", (e) => errors.push(e.message));
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
  await page.route((url) => url.pathname === "/metrics", (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  await page.route((url) => url.pathname === "/session", (r) => {
    const req = r.request();
    sessions.push({ ...JSON.parse(req.postData() ?? "{}"), method: req.method(), contentType: req.headers()["content-type"], authorization: req.headers().authorization });
    return sessionStatus === 200 ? r.fulfill({ status: 200, json: { token: SESSION_TOKEN } }) : r.fulfill({ status: sessionStatus, json: { error: "refused" } });
  });
  await page.route((url) => url.pathname === "/requests", (r) => {
    const req = r.request();
    if (req.method() === "POST") {
      if (req.headers().authorization !== `Bearer ${SESSION_TOKEN}`) {
        unauth.push(req.headers().authorization ?? null);
        return r.fulfill({ status: 401, json: { error: "unauthorized" } });
      }
      posts.push(JSON.parse(req.postData() ?? "{}"));
      return r.fulfill({ status: 202, json: {} });
    }
    return r.fulfill({ json: [] });
  });
  await page.goto(code === null ? base : `${base}#code=${code}`);
  // The app is up once its rail is rendered. Needs opens by default here because most legacy
  // behavioral checks exercise the requests card; tests for other topics select them explicitly.
  await page.locator('[data-rail="needs"]').waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-rail="needs"]').click();
  await page.locator('[data-overlay="logo"]').waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
  // organism-infra/104: 5 s was a load flake ("Ctrl+Enter in the Note", fill after the first POST timed out while
  // the machine was busy). Playwright actions return as soon as the element is ready, so a longer ceiling only
  // delays the failure of a test that is really broken; no test here asserts on a timeout elapsing.
  page.setDefaultTimeout(20000);
  return {
    page, context, errors, posts, sessions, unauth,
    noSession: page.locator('[data-session="none"]'),
    logo: page.locator('[data-overlay="logo"]'),
    needs: page.locator('[data-sheet="topic"]'),
    teams: page.locator('[data-sheet="topic"]'),
    zoom: page.locator('[data-overlay="zoom"]'),
  };
}

// In a sheet the card's former collapsible header is gone. Focus a real control inside the
// Needs-you body so its keyboard handler receives the key; sheet visibility belongs to the rail.
const header = (sheet) => sheet.locator('[data-overlay="needs-you"] button').first();
const zoomValue = async (zoom) => Number(await zoom.getAttribute("data-zoom"));
const token = (page, name) =>
  page.evaluate((n) => {
    const probe = document.createElement("span");
    probe.style.color = `var(--${n})`;
    document.querySelector(".forest-shell").appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
const colourOf = (locator) => locator.evaluate((el) => getComputedStyle(el).color);
const withApp = (opts, fn) => async () => {
  const app = await openApp(opts);
  try {
    await fn(app);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.context.close();
  }
};
const openWork = async (page) => {
  await page.locator('[data-rail="work"]').click();
  return page.locator('[data-sheet="topic"]');
};

// ---- Layout: full-window shell, rail and docked topic sheet ---------------------------------------------

test("the full-window shell has a top bar, a Den rail, a live scene, and one bounded topic sheet", { timeout: 90000 }, withApp({}, async ({ page, needs }) => {
  assert.equal(await page.locator('.forest-shell').count(), 1);
  assert.equal(await page.locator('.den-bar').count(), 1);
  assert.equal(await page.getByRole('navigation', { name: 'Den' }).count(), 1);
  assert.equal(await page.locator('main[aria-label="Den scene"]').count(), 1);
  assert.equal(await page.getByRole('complementary', { name: 'Your desk' }).count(), 0);
  assert.equal(await page.locator('.forest-masthead, .forest-desk-home').count(), 0);
  assert.equal(await page.locator('[data-sheet="topic"]').count(), 1);
  assert.equal(await needs.getAttribute('aria-modal'), 'false');
  const shell = await page.locator('.forest-shell').boundingBox();
  const bar = await page.locator('.den-bar').boundingBox();
  const rail = await page.getByRole('navigation', { name: 'Den' }).boundingBox();
  const scene = await page.locator('main[aria-label="Den scene"]').boundingBox();
  const sheet = await needs.boundingBox();
  assert.ok(bar.y >= shell.y && bar.y + bar.height <= scene.y + 1);
  assert.ok(rail.x >= shell.x && rail.x + rail.width <= scene.x + 1);
  assert.ok(scene.x + scene.width <= shell.x + shell.width + .5);
  assert.ok(sheet.x >= rail.x + rail.width && sheet.x + sheet.width <= shell.x + shell.width);
}));

test("the bar keeps the brand and zoom controls; rail entries replace the old masthead and desk navigation", { timeout: 90000 }, withApp({}, async ({ page, logo }) => {
  assert.equal((await logo.locator('h1').textContent()).trim(), 'Dim Sum Dev');
  assert.equal(await logo.getByText('Live', { exact: true }).count(), 1);
  const entries = await page.locator('.den-rail-list:first-child [data-rail]').evaluateAll((els) => els.map((e) => e.dataset.rail));
  assert.deepEqual(entries, ['bao', 'needs', 'queue', 'work', 'meetings', 'team', 'library', 'tally']);
  assert.equal(await page.locator('.den-bar').getByRole('button', { name: /Talk to Bao/ }).count(), 1);
  assert.equal(await page.locator('.forest-masthead, [aria-label="Workspace"]').count(), 0);
}));

test("logo pill shows 'Dim Sum Dev' and a Live badge in qi", { timeout: 90000 }, withApp({}, async ({ page, logo }) => {
  await logo.getByText("Live", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await colourOf(logo.getByText("Live", { exact: true })), await token(page, "qi"));
  assert.equal((await logo.locator("h1").textContent()).trim(), "Dim Sum Dev");
}));

// ---- Needs you ---------------------------------------------------------------------------------------------

test("Needs you: open with waiting requests, named with the count, eyebrow, title, code well, key hints, other rows with an age (criterion: Needs you contents, key hints visible)", { timeout: 90000 }, withApp({}, async ({ page, needs }) => {
  assert.match(await page.locator('[data-rail="needs"]').getAttribute("aria-label"), /^Needs you, 2 waiting$/);
  assert.equal(await page.locator('[data-rail="needs"]').getAttribute("aria-expanded"), "true", "open when at least 1 waits");
  const text = await needs.innerText();
  assert.match(text, /Tea · qa · .*02-verify-it/, "eyebrow: Team · role · ticket");
  assert.match(text, /02-verify-it.* wants merge approval/, "title: <id> wants <action>");
  assert.ok((await needs.locator("code, pre").count()) >= 1, "code preview well");
  const approve = needs.getByRole("button", { name: /^Approve/ });
  const deny = needs.getByRole("button", { name: /^Deny/ });
  await approve.waitFor({ state: "visible" });
  await deny.waitFor({ state: "visible" });
  const hint = (btn, key) => btn.evaluate((el, k) => [...el.querySelectorAll("*")].some((c) => c.children.length === 0 && c.textContent.trim() === k && c.getClientRects().length > 0), key);
  assert.equal(await hint(approve, "a"), true, "Approve shows key hint a");
  assert.equal(await hint(deny, "d"), true, "Deny shows key hint d");
  assert.match(text, /03-ship-it|ship-it/, "second waiting request is a row");
  assert.match(text, /\b2 min\b/, "relative time on the row");
  assert.doesNotMatch(text, /wants dispatch approval[\s\S]*Approve/, "only the first request has buttons");
}));

test("'a' approves and 'd' denies the top request when focus is on the card, through POST /requests (criterion: Approve/Deny respond to a/d)", { timeout: 90000 }, withApp({}, async ({ page, needs, posts }) => {
  await header(needs).focus();
  await page.keyboard.press("a");
  await expectPost(posts, { kind: "merge-approve", ref: "demo/02-verify-it" });
  posts.length = 0;
  await header(needs).focus();
  await page.keyboard.press("d");
  await expectPost(posts, { kind: "merge-reject", ref: "demo/02-verify-it" });
}));

test("typing 'a' or 'd' in the Note field is text, not a decision; 'm' moves focus to the Note field", { timeout: 90000 }, withApp({}, async ({ page, needs, posts }) => {
  await header(needs).focus();
  await page.keyboard.press("m");
  const note = needs.getByRole("textbox", { name: /note/i });
  assert.equal(await note.evaluate((el) => el === document.activeElement), true, "m focuses the Note field");
  await page.keyboard.type("add");
  assert.equal(await note.inputValue(), "add");
  await page.waitForTimeout(150);
  assert.deepEqual(posts, [], "nothing was filed while typing");
}));

test("'j' and 'k' step through the waiting requests; the next 'a' acts on the one shown", { timeout: 90000 }, withApp({}, async ({ page, needs, posts }) => {
  await header(needs).focus();
  assert.match(await needs.innerText(), /02-verify-it.* wants merge approval/);
  await page.keyboard.press("j");
  await needs.getByText(/ship-it.* wants dispatch approval/).first().waitFor({ state: "visible" });
  await page.keyboard.press("a");
  await expectPost(posts, { kind: "dispatch-approve", ref: "demo/03-ship-it" });
  await page.keyboard.press("k");
  await needs.getByText(/verify-it.* wants merge approval/).first().waitFor({ state: "visible" });
}));

// User ruling 2026-10-02: `m` = deny with message. It focuses the Note (chip `m` on the Note label), and Ctrl or Cmd +
// Enter in the Note sends Deny with that note. Designer helper line: "Ctrl Enter denies with this note".
test("deny with message: the Note label carries an 'm' chip and a 'Ctrl Enter denies with this note' helper (ruling: m)", { timeout: 90000 }, withApp({}, async ({ needs }) => {
  const note = needs.getByRole("textbox", { name: /note/i });
  await note.waitFor({ state: "visible" });
  const chip = await note.evaluate((el) => {
    const label = el.labels?.[0];
    if (!label) return { label: false };
    const leaf = [...label.querySelectorAll("*")].find((c) => c.children.length === 0 && c.textContent.trim() === "m");
    return { label: true, chip: !!leaf, visible: !!leaf && leaf.getClientRects().length > 0 };
  });
  assert.equal(chip.label, true, "the Note field has a label");
  assert.equal(chip.chip, true, "the Note label holds an element whose whole text is 'm'");
  assert.equal(chip.visible, true, "the m chip is visible");
  assert.match(await needs.innerText(), /Ctrl[\s+]*Enter denies with this note/i);
}));

test("Ctrl+Enter in the Note sends Deny with that note; Cmd+Enter does too; plain Enter only adds a line (ruling: m)", { timeout: 90000 }, withApp({}, async ({ page, needs, posts }) => {
  await header(needs).focus();
  await page.keyboard.press("m");
  const note = needs.getByRole("textbox", { name: /note/i });
  assert.equal(await note.evaluate((el) => el === document.activeElement), true, "m focuses the Note field");
  await page.keyboard.type("needs a rewrite");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  assert.deepEqual(posts, [], "plain Enter files nothing");
  await note.fill("needs a rewrite");
  await page.keyboard.press("Control+Enter");
  await expectPost(posts, { kind: "merge-reject", ref: "demo/02-verify-it" });
  assert.equal(posts[0].note, "needs a rewrite", "the note travels with the deny");
  posts.length = 0;
  // organism-infra/150: the stub sees the POST before the page has handled the 202, and Cards.jsx holds the kind in
  // `inflight` until then and drops a repeat keypress. The Deny button reads "Sending…" for exactly that span, so
  // wait for it to read "Deny" again before firing the second key.
  await needs.getByRole("button", { name: /^Deny/ }).waitFor({ state: "visible" });
  await note.fill("second thoughts");
  await note.focus();
  await page.keyboard.press("Meta+Enter");
  await expectPost(posts, { kind: "merge-reject", ref: "demo/02-verify-it" });
  assert.equal(posts[0].note, "second thoughts");
}));

// Designer F7: j and k change the card with no announcement. The title sits in one aria-live region that persists
// across the change (a region that is re-created each time announces nothing).
test("'j' and 'k' are announced: the request title lives in a persistent aria-live region (designer F7)", { timeout: 90000 }, withApp({}, async ({ page, needs }) => {
  const first = needs.getByText(/02-verify-it.* wants merge approval/).first();
  const second = /ship-it.* wants dispatch approval/;
  await first.waitFor({ state: "visible" });
  const mark = await first.evaluate((el) => {
    const region = el.closest('[aria-live="polite"], [aria-live="assertive"], [role="status"]');
    if (region) region.dataset.qaMark = "1";
    return !!region;
  });
  assert.equal(mark, true, "the shown request's title is inside an aria-live region");
  await header(needs).focus();
  await page.keyboard.press("j");
  await needs.getByText(second).first().waitFor({ state: "visible" });
  const after = await needs.getByText(second).first().evaluate((el) => {
    const region = el.closest('[aria-live="polite"], [aria-live="assertive"], [role="status"]');
    return { live: !!region, same: region?.dataset.qaMark === "1" };
  });
  assert.equal(after.live, true, "the new title is in an aria-live region");
  assert.equal(after.same, true, "the same live region persists across j, so the change is announced");
}));

test("card keys are card-scoped:'a' does nothing from the scene or from inside the Tally dialog", { timeout: 90000 }, withApp({}, async ({ page, needs, posts }) => {
  assert.equal(await needs.getByRole("button", { name: /^Approve/ }).count(), 1, "precondition: the card is there with a request to act on");
  await page.locator('main[aria-label="Den scene"]').focus();
  await page.keyboard.press("a");
  await page.locator('[data-rail="tally"]').click();
  await page.getByRole("dialog", { name: "Tally" }).waitFor({ state: "visible" });
  await page.keyboard.press("a");
  await page.keyboard.press("d");
  await page.waitForTimeout(200);
  assert.deepEqual(posts, [], "no request filed from outside the card");
}));

test("the Needs rail entry closes and reopens its sheet; an empty sheet says so and has no count", { timeout: 90000 }, async () => {
  const app = await openApp({});
  try {
    const { page } = app;
    const rail = page.locator('[data-rail="needs"]');
    await rail.click();
    assert.equal(await page.locator('[data-sheet="topic"]').count(), 0);
    await rail.click();
    assert.equal(await page.locator('[data-sheet="topic"]').count(), 1);
    assert.equal(await page.getByRole("button", { name: /^Approve/ }).count(), 1);
  } finally {
    await app.context.close();
  }
  const quiet = await openApp({ snapshot: quietSnapshot() });
  try {
    await quiet.needs.getByText("Nothing is waiting on you.").waitFor({ state: "visible" });
    assert.equal(await quiet.needs.getByRole("button", { name: /^Approve/ }).count(), 0);
    assert.doesNotMatch(await quiet.page.locator('[data-rail="needs"]').getAttribute('aria-label'), /\d/, "no count in the rail label when nothing waits");
  } finally {
    await quiet.context.close();
  }
});

// ---- Teams & queue ----------------------------------------------------------------------------------------

test("the Work rail entry opens and closes the topic sheet", { timeout: 90000 }, withApp({}, async ({ page }) => {
  const work = await openWork(page);
  await work.locator('[data-team-pill="steamers"]').waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-rail="work"]').getAttribute('aria-expanded'), 'true');
  await page.locator('[data-rail="work"]').click();
  assert.equal(await page.locator('[data-sheet="topic"]').count(), 0);
  assert.equal(await page.locator('[data-sheet="side"]').count(), 0);
}));

test("open teams: one pill each in order with name and count; a pill shows '· waiting' in lantern only when one of its pandas waits (criterion: waiting pill)", { timeout: 90000 }, withApp({}, async ({ page, teams }) => {
  await openWork(page);
  const ids = await teams.locator("[data-team-pill]").evaluateAll((els) => els.map((e) => e.dataset.teamPill));
  assert.deepEqual(ids, ["pass", "steamers", "tea", "pantry", "front-of-house", "cubs", "library", "drum"]);
  const pill = (id) => teams.locator(`[data-team-pill="${id}"]`);
  assert.match(await pill("steamers").innerText(), /Steamers\s*1\b/);
  assert.match(await pill("pass").innerText(), /\bPass\b/);
  assert.match(await pill("pantry").innerText(), /Pantry\s*0\b/);
  assert.match(await pill("front-of-house").innerText(), /Front of House\s*1\b/);
  for (const id of ["tea", "front-of-house"]) {
    assert.match(await pill(id).innerText(), /·\s*waiting/, `${id} has a waiting panda`);
  }
  for (const id of ["pass", "steamers", "pantry"]) {
    assert.doesNotMatch(await pill(id).innerText(), /waiting/, `${id} has none waiting`);
  }
  const waitingText = pill("tea").getByText(/waiting/);
  assert.equal(await colourOf(waitingText), await token(page, "lantern"), "waiting is lantern");
  for (const id of ["pass", "steamers", "tea", "pantry", "front-of-house"]) {
    assert.equal(await pill(id).evaluate((e) => e.tagName), "BUTTON", `${id} pill is a button`);
  }
}));

test("dormant teams are dashed, non-interactive pills: Library and Drum 'coming online', Cubs 'N asleep' (criterion: dormant pills)", { timeout: 90000 }, withApp({}, async ({ page, teams }) => {
  await openWork(page);
  const pill = (id) => teams.locator(`[data-team-pill="${id}"]`);
  assert.match(await pill("library").innerText(), /coming online/);
  assert.match(await pill("drum").innerText(), /coming online/);
  assert.match(await pill("cubs").innerText(), /\b1 asleep\b/, "one cub in the fixture");
  for (const id of ["cubs", "library", "drum"]) {
    const info = await pill(id).evaluate((e) => ({ tag: e.tagName, style: getComputedStyle(e).borderTopStyle, tabindex: e.getAttribute("tabindex") }));
    assert.equal(info.style, "dashed", `${id} border`);
    assert.notEqual(info.tag, "BUTTON");
    assert.equal(info.tabindex, null, `${id} is not a tab stop`);
  }
  assert.doesNotMatch(await pill("tea").innerText(), /coming online|asleep/);
}));

test("summary and queue: '5 open · N ready', 'Next on the susan', rows with a P-chip and title; an empty susan says so (criterion: Queue contents)", { timeout: 90000 }, async () => {
  const app = await openApp({});
  try {
    await openWork(app.page);
    const text = await app.teams.innerText();
    assert.match(text, /5 open · 2 ready/);
    assert.match(text, /Next on the susan/i);
    assert.match(text, /P0[\s\S]*next-up/);
    assert.match(text, /P2[\s\S]*later-on/);
    assert.ok(text.indexOf("next-up") < text.indexOf("later-on"), "frontier order kept");
  } finally {
    await app.context.close();
  }
  const quiet = await openApp({ snapshot: quietSnapshot() });
  try {
    await openWork(quiet.page);
    await quiet.teams.getByText("The susan is empty.").waitFor({ state: "visible" });
    assert.match(await quiet.teams.innerText(), /0 ready/);
  } finally {
    await quiet.context.close();
  }
});

test("clicking an open team pill zooms to that team (level 2 · Team becomes current)", { timeout: 90000 }, withApp({}, async ({ page, teams, zoom }) => {
  await openWork(page);
  await teams.locator('[data-team-pill="tea"]').click();
  await zoom.getByRole("button", { name: "2 · Team" }).waitFor({ state: "visible" });
  assert.equal(await zoom.getByRole("button", { name: "2 · Team" }).getAttribute("aria-current"), "true");
  assert.ok((await zoomValue(zoom)) < 1, "closer than the Level 1 framing");
}));

// ---- Zoom switcher and free zoom -----------------------------------------------------------------------------

test("zoom switcher labels are exactly 1 · Den, 2 · Team, 3 · Panda, 4 · Workspace; Level 1 is current in qi; + and - have aria-labels (criterion: labels)", { timeout: 90000 }, withApp({}, async ({ page, zoom }) => {
  const nav = page.getByRole("navigation", { name: "Zoom level" });
  assert.equal(await nav.count(), 1);
  const levels = await zoom.locator("button").evaluateAll((bs) => bs.map((b) => b.textContent.trim()).filter((t) => /^\d ·/.test(t)));
  assert.deepEqual(levels, ["1 · Den", "2 · Team", "3 · Panda", "4 · Workspace"]);
  assert.equal(await zoom.getByRole("button", { name: "Zoom in" }).count(), 1);
  assert.equal(await zoom.getByRole("button", { name: "Zoom out" }).count(), 1);
  const den = zoom.getByRole("button", { name: "1 · Den" });
  assert.equal(await den.getAttribute("aria-current"), "true");
  assert.equal(await colourOf(den), await token(page, "qi"), "current level is qi");
  assert.equal(await colourOf(zoom.getByRole("button", { name: "2 · Team" })), await token(page, "ink-muted"));
  assert.equal(await zoomValue(zoom), 1, "starts at the Level 1 framing");
}));

test("clicking a level makes it current and dollies in (Level 3 is closer than Level 2, which is closer than Level 1)", { timeout: 90000 }, withApp({}, async ({ zoom }) => {
  await zoom.getByRole("button", { name: "2 · Team" }).click();
  const two = await zoomValue(zoom);
  assert.equal(await zoom.getByRole("button", { name: "2 · Team" }).getAttribute("aria-current"), "true");
  await zoom.getByRole("button", { name: "3 · Panda" }).click();
  const three = await zoomValue(zoom);
  assert.equal(await zoom.getByRole("button", { name: "3 · Panda" }).getAttribute("aria-current"), "true");
  assert.ok(three < two && two < 1, `levels dolly in: 1 > ${two} > ${three}`);
  assert.ok(three >= ZOOM_NEAREST, "within the clamp");
}));

test("+ and - buttons step the same zoom the wheel and keys use, and clamp at [0.25, 1.2]", { timeout: 90000 }, withApp({}, async ({ page, zoom }) => {
  const zin = zoom.getByRole("button", { name: "Zoom in" });
  const zout = zoom.getByRole("button", { name: "Zoom out" });
  await zin.click();
  const afterIn = await zoomValue(zoom);
  assert.ok(afterIn < 1, `Zoom in moves closer, got ${afterIn}`);
  await zout.click();
  assert.ok(near(await zoomValue(zoom), 1, 1e-6), "Zoom out undoes it");
  for (let i = 0; i < 40; i++) await zin.click();
  assert.ok(near(await zoomValue(zoom), ZOOM_NEAREST, 1e-6), `clamped at ${ZOOM_NEAREST}, got ${await zoomValue(zoom)}`);
  for (let i = 0; i < 40; i++) await zout.click();
  assert.ok(near(await zoomValue(zoom), ZOOM_FARTHEST, 1e-6), `clamped at ${ZOOM_FARTHEST}, got ${await zoomValue(zoom)}`);
  await page.locator('main[aria-label="Den scene"]').focus();
  await page.keyboard.press("+");
  assert.ok((await zoomValue(zoom)) < ZOOM_FARTHEST, "the + key moves the same zoom");
}));

test("scroll wheel over the scene zooms freely and clamps at both ends (scope 2026-10-01: wheel, clamp)", { timeout: 90000 }, withApp({}, async ({ page, zoom }) => {
  const canvas = await page.locator('.forest-canvas').boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(() => Number(document.querySelector('[data-overlay=zoom]').dataset.zoom) < 1);
  const closer = await zoomValue(zoom);
  assert.ok(closer < 1 && closer >= ZOOM_NEAREST, `wheel up zooms in: ${closer}`);
  await page.mouse.wheel(0, -100000);
  await page.waitForFunction(nearest => Number(document.querySelector('[data-overlay=zoom]').dataset.zoom) === nearest, ZOOM_NEAREST);
  assert.ok(near(await zoomValue(zoom), ZOOM_NEAREST, 1e-6), "a huge scroll in stops at the nearest limit");
  await page.mouse.wheel(0, 100000);
  await page.waitForFunction(() => Number(document.querySelector('[data-overlay=zoom]').dataset.zoom) === 1.2);
  assert.ok(near(await zoomValue(zoom), ZOOM_FARTHEST, 1e-6), "a huge scroll out stops at the farthest limit");
}));

test("two-finger pinch zooms: spreading the fingers moves closer, pinching in moves back, both clamped (scope 2026-10-01: pinch)", { timeout: 90000 }, async () => {
  const app = await openApp({ hasTouch: true });
  try {
    const { page, context, zoom } = app;
    const cdp = await context.newCDPSession(page);
    const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, id) => ({ x: p[0], y: p[1], id })) });
    const canvas = await page.locator('.forest-canvas').boundingBox();
    const cx = canvas.x + canvas.width / 2;
    const cy = canvas.y + canvas.height / 2;
    const wide = Math.min(200, canvas.width * .35);
    const gesture = async (from, to) => {
      await touch("touchStart", [[cx - from, cy], [cx + from, cy]]);
      for (let i = 1; i <= 10; i++) {
        const d = from + ((to - from) * i) / 10;
        await touch("touchMove", [[cx - d, cy], [cx + d, cy]]);
      }
      await touch("touchEnd", []);
    };
    const start = await zoomValue(zoom);
    await gesture(40, wide);
    const spread = await zoomValue(zoom);
    assert.ok(spread < start && spread >= ZOOM_NEAREST, `spread zooms in: ${start} to ${spread}`);
    await gesture(wide, 20);
    const pinched = await zoomValue(zoom);
    assert.ok(pinched > spread && pinched <= ZOOM_FARTHEST, `pinch zooms out: ${spread} to ${pinched}`);
    assert.equal(await page.locator('.forest-canvas').evaluate((el) => getComputedStyle(el).touchAction), "none", "the browser leaves the gesture to the scene");
  } finally {
    await app.context.close();
  }
});

// ---- The connected Bao entry and uncluttered responsive layout -------------------------------------------

test("Talk to Bao opens the real conversation composer in the side sheet", { timeout: 90000 }, withApp({}, async ({ page, posts }) => {
  const talk = page.locator('.den-bar').getByRole('button', { name: /Talk to Bao/ });
  await talk.click();
  const conversation = page.locator('[data-sheet="side"]');
  await conversation.waitFor({ state: 'visible' });
  assert.equal(await conversation.getAttribute('role'), 'dialog');
  assert.equal(await conversation.getAttribute('aria-modal'), 'false');
  assert.equal(await conversation.locator('.thread-box').count(), 1);
  assert.equal(await conversation.getByRole('button', { name: 'Send', exact: true }).count(), 1);
  assert.deepEqual(posts, [], 'opening a conversation does not dispatch work');
}));

test("closing Bao removes only the side sheet and leaves the topic sheet open", { timeout: 90000 }, withApp({}, async ({ page }) => {
  const topic = page.locator('[data-sheet="topic"]');
  const opener = page.locator('.den-bar').getByRole('button', { name: /Talk to Bao/ });
  await opener.click();
  await page.getByRole('button', { name: 'Close conversation' }).click();
  assert.equal(await page.locator('[data-sheet="side"]').count(), 0);
  assert.equal(await topic.count(), 1);
  assert.equal(await page.locator('[data-rail="needs"]').getAttribute('aria-expanded'), 'true');
}));

test("the connected shell offers Bao instead of disabled intent, autonomy and replay placeholders", { timeout: 90000 }, withApp({}, async ({ page, posts }) => {
  assert.equal(await page.locator('[data-overlay="intent"], [data-overlay="timeline"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /utonomy/ }).count(), 0);
  assert.equal(await page.locator('.den-bar').getByRole('button', { name: /Talk to Bao/ }).isEnabled(), true);
  assert.deepEqual(posts, []);
}));

test("the shell, bar, rail, scene and open sheet stay bounded with no horizontal overflow", { timeout: 120000 }, withApp({}, async ({ page, zoom }) => {
  for (const width of [1440, 1280, 1024, 900, 899, 768, 600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const shell = await page.locator('.forest-shell').boundingBox();
    const bar = await page.locator('.den-bar').boundingBox();
    const rail = await page.getByRole('navigation', { name: 'Den' }).boundingBox();
    const scene = await page.locator('main[aria-label="Den scene"]').boundingBox();
    const sheet = await page.locator('[data-sheet="topic"]').boundingBox();
    assert.ok(bar.x >= shell.x && bar.x + bar.width <= width + .5, `${width}: bar is bounded`);
    assert.ok(rail.x >= shell.x && rail.x + rail.width <= scene.x + .5, `${width}: rail is bounded beside scene`);
    assert.ok(scene.x + scene.width <= width + .5, `${width}: scene is bounded`);
    assert.ok(sheet.x >= rail.x + rail.width && sheet.x + sheet.width <= width + .5, `${width}: sheet is bounded`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: no horizontal overflow`);
    assert.equal(await zoom.getByRole('button', { name: 'Zoom in' }).isVisible(), true);
    assert.equal(await zoom.getByRole('button', { name: 'Zoom out' }).isVisible(), true);
  }
}));

test("Talk to Bao remains keyboard-operable without the old Ctrl K placeholder control", { timeout: 90000 }, withApp({}, async ({ page }) => {
  const talk = page.locator('.den-bar').getByRole('button', { name: /Talk to Bao/ });
  await talk.focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-sheet="side"]').waitFor({ state: 'visible' });
  assert.equal(await page.getByPlaceholder('Give the den an intent…').count(), 0);
  await page.keyboard.press('Escape');
  await page.locator('[data-sheet="side"]').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-sheet="side"]').count(), 0);
}));

test("the full Talk to Bao label fits in the bar across desktop and phone widths", { timeout: 120000 }, withApp({}, async ({ page }) => {
  for (const width of [1440, 1024, 768, 600, 390, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const button = await page.locator('.den-bar').getByRole('button', { name: /Talk to Bao/ }).boundingBox();
    assert.ok(button.x + button.width <= width + .5 && button.x >= 0, `${width}: label stays within the bar`);
  }
}));

test("phone coarse-pointer controls keep a 44px target for Bao, navigation and garden zoom", { timeout: 90000 }, async () => {
  const app = await openApp({ viewport: { width: 375, height: 667 }, isMobile: true });
  try {
    const { page, zoom } = app;
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    const controls = [page.locator('.den-bar').getByRole('button', { name: /Talk to Bao/ }), page.locator('[data-rail="work"]'), zoom.getByRole('button', { name: 'Zoom in' })];
    for (const control of controls) assert.ok((await control.boundingBox()).height >= 44, 'touch target remains at least 44px tall');
  } finally { await app.context.close(); }
});

// ---- Phone width -----------------------------------------------------------------------------------------------

test("phone topic sheets stay within the shell and the rail switches one topic at a time", { timeout: 90000 }, async () => {
  const app = await openApp({ viewport: PHONE });
  try {
    const { page, zoom } = app;
    assert.equal(await page.locator('[data-rail="needs"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-sheet="topic"]').count(), 1);
    assert.equal(await zoom.getByRole('button', { name: 'Zoom in' }).isVisible(), true);
    assert.equal(await page.locator('[data-overlay="intent"], [data-overlay="timeline"]').count(), 0);
    await page.locator('[data-rail="work"]').click();
    assert.equal(await page.locator('[data-rail="work"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-rail="needs"]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-sheet="topic"]').count(), 1);
    const sheet = await page.locator('[data-sheet="topic"]').boundingBox();
    assert.ok(sheet.x >= 0 && sheet.x + sheet.width <= PHONE.width + .5);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await app.context.close(); }
});

// ---- Keyboard, focus ring, accessible names, den words ---------------------------------------------------------

test("every visible control is keyboard-reachable with the 2px focus ring (criterion: keyboard, focus ring)", { timeout: 120000 }, async () => {
  const app = await openApp({});
  try {
    const { page } = app;
    await page.locator('[data-rail="work"]').click();
    const ring = await token(page, "focus-ring");
    // Interactive elements that must be reachable, in the overlays.
    const unreachable = await page.evaluate(() =>
      [...document.querySelectorAll('.den-rail :is(button, a[href], input, textarea, select, [role="slider"]), .den-bar :is(button, a[href], input, textarea, select, [role="slider"]), [data-sheet] :is(button, a[href], input, textarea, select, [role="slider"])')]
        .filter((e) => e.getClientRects().length > 0 && (e.tabIndex < 0 || e.disabled))
        .map((e) => e.outerHTML.slice(0, 80)));
    assert.deepEqual(unreachable, [], "no visible control is removed from the tab order");
    // Focus the scene, then walk through the shell's keyboard stops.
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.locator('main[aria-label="Den scene"]').focus();
    const seen = [];
    for (let i = 0; i < 90; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const a = document.activeElement;
        const cs = getComputedStyle(a);
        return {
          overlay: a.closest("[data-overlay]")?.dataset.overlay ?? a.closest("[data-sheet]")?.dataset.sheet ?? (a.closest(".den-rail") ? "rail" : a.closest(".den-bar") ? "bar" : null),
          text: (a.getAttribute("aria-label") ?? a.textContent ?? "").trim().slice(0, 30),
          width: cs.outlineWidth, style: cs.outlineStyle, offset: cs.outlineOffset, color: cs.outlineColor,
        };
      });
      seen.push(info);
    }
    const overlaySeq = seen.map((s) => s.overlay).filter(Boolean);
    for (const name of ["rail", "topic", "zoom"]) assert.ok(overlaySeq.includes(name), `${name} controls are reachable by Tab; saw ${overlaySeq}`);
    const labels = seen.filter((s) => s.overlay === "zoom").map((s) => s.text);
    for (const want of ["1 · Den", "2 · Team", "3 · Panda", "4 · Workspace", "Zoom in", "Zoom out"]) assert.ok(labels.includes(want), `Tab reaches ${want}`);
    const shellStops = seen.filter((s) => s.overlay);
    assert.ok(shellStops.length >= 10, `walked ${shellStops.length} shell stops`);
    for (const s of shellStops) {
      assert.equal(s.width, "2px", `${s.overlay} "${s.text}" outline width`);
      assert.equal(s.style, "solid", `${s.overlay} "${s.text}" outline style`);
      assert.equal(s.offset, s.overlay === "rail" ? "-2px" : "2px", `${s.overlay} "${s.text}" outline offset`);
      assert.equal(s.color, ring, `${s.overlay} "${s.text}" outline colour is focus-ring`);
    }
  } finally {
    await app.context.close();
  }
});

// Stand-in for axe (not a dependency; adding one is a security gate): the rules axe would flag on these
// overlays, checked through Playwright's accessibility tree and the DOM.
test("accessibility basics: every button, link and field has a name, ids are unique, landmarks are named, aria-controls resolve, and den words only (criterion: axe finds no serious issues; den words)", { timeout: 90000 }, withApp({}, async ({ page, teams }) => {
  await openWork(page);
  const tree = await page.locator("body").ariaSnapshot();
  const unnamed = tree.split("\n").filter((line) => /^\s*- (button|link|textbox|slider|combobox|checkbox|switch)\b/.test(line) && !/^\s*- \w+ "/.test(line));
  assert.deepEqual(unnamed, [], "controls without an accessible name");
  const dom = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    const broken = [...document.querySelectorAll("[aria-controls]")].filter((e) => !document.getElementById(e.getAttribute("aria-controls"))).map((e) => e.outerHTML.slice(0, 80));
    const unnamedRegions = [...document.querySelectorAll('section, nav, [role="region"]')].filter((e) => !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby")).map((e) => e.outerHTML.slice(0, 80));
    const words = /\b(organism|organisms|placement|placements|genome|apoptosis|endocrine)\b/i;
    const biology = [...document.querySelectorAll("[data-overlay]")].flatMap((root) => [root, ...root.querySelectorAll("*")])
      .flatMap((e) => [e.getAttribute("aria-label"), e.children.length === 0 ? e.textContent : null, e.getAttribute("placeholder")])
      .filter((t) => t && words.test(t));
    return { dupes, broken, unnamedRegions, biology, h1: document.querySelectorAll("h1").length };
  });
  assert.deepEqual(dom.dupes, [], "duplicate ids");
  assert.deepEqual(dom.broken, [], "aria-controls pointing nowhere");
  assert.deepEqual(dom.unnamedRegions, [], "landmarks need a name");
  assert.deepEqual(dom.biology, [], "no biology words in visible labels");
  assert.equal(dom.h1, 1, "one h1");
}));

async function expectPost(posts, want) {
  const deadline = Date.now() + 20000; // organism-infra/104: same load ceiling as the page default timeout
  while (Date.now() < deadline && posts.length === 0) await new Promise((r) => setTimeout(r, 50));
  assert.equal(posts.length, 1, `exactly one POST /requests, got ${JSON.stringify(posts)}`);
  assert.equal(posts[0].kind, want.kind);
  assert.equal(posts[0].ref, want.ref);
}

// ---- Steering session (organism-infra/139) -------------------------------------------------------------------
// Markup contract: when there is no usable session the page shows exactly one element [data-session="none"]
// holding one line of copy (the wording is a designer glance or orchestrator call: human-verified). The den itself
// (scene, Needs you card) still renders, because the read routes stay open. With a session the element is absent.
async function waitFor(cond, what, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !(await cond())) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await cond(), `timed out waiting for ${what}`);
}

test("the UI redeems #code once at POST /session as JSON, drops the fragment from the address bar, and shows no 'no session' line", { timeout: 90000 }, withApp({}, async ({ page, sessions, noSession }) => {
  await waitFor(() => sessions.length === 1, "POST /session");
  assert.equal(sessions[0].code, LAUNCH_CODE);
  assert.equal(sessions[0].method, "POST");
  assert.match(sessions[0].contentType, /^application\/json/);
  assert.equal(sessions[0].authorization, undefined, "no Bearer on the redemption");
  await waitFor(async () => !page.url().includes("#"), "the fragment to leave the address bar");
  assert.ok(!page.url().includes("code="), `the launch code must not stay in the URL: ${page.url()}`);
  assert.equal(await noSession.count(), 0);
}));

test("Approve sends Authorization: Bearer <session token> (a click right after load is not dropped or sent bare)", { timeout: 90000 }, withApp({}, async ({ page, needs, posts, unauth }) => {
  await header(needs).focus();
  await page.keyboard.press("a");
  await expectPost(posts, { kind: "merge-approve", ref: "demo/02-verify-it" });
  assert.deepEqual(unauth, [], "every POST /requests carried the session token");
}));

test("the token lives in sessionStorage only: not localStorage, not a cookie, and the launch code is stored nowhere", { timeout: 90000 }, withApp({}, async ({ page, context, sessions }) => {
  await waitFor(() => sessions.length === 1, "POST /session");
  await waitFor(() => page.evaluate(() => sessionStorage.length > 0), "the token to be stored");
  const stores = await page.evaluate(() => ({ session: JSON.stringify({ ...sessionStorage }), local: JSON.stringify({ ...localStorage }) }));
  assert.ok(stores.session.includes(SESSION_TOKEN), "sessionStorage holds the token so a reload keeps the session");
  assert.ok(!stores.local.includes(SESSION_TOKEN), "localStorage must not hold the token (it outlives the tab and is shared across tabs)");
  assert.ok(!stores.session.includes(LAUNCH_CODE) && !stores.local.includes(LAUNCH_CODE), "the launch code is never stored");
  const cookies = JSON.stringify(await context.cookies());
  assert.ok(!cookies.includes(SESSION_TOKEN), "no cookie carries the token");
}));

test("reloading the page keeps the session: no new code, no new /session call, and Approve still works with the Bearer", { timeout: 90000 }, withApp({}, async ({ page, needs, sessions, posts, unauth, noSession }) => {
  await waitFor(() => sessions.length === 1, "POST /session");
  await waitFor(() => page.evaluate(() => sessionStorage.length > 0), "the token to be stored");
  await page.reload();
  await page.locator('[data-rail="needs"]').waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-rail="needs"]').click();
  assert.ok(!page.url().includes("code="), "the reloaded URL carries no code");
  await header(needs).focus();
  await page.keyboard.press("a");
  await expectPost(posts, { kind: "merge-approve", ref: "demo/02-verify-it" });
  assert.equal(sessions.length, 1, "the reload did not redeem a code again");
  assert.deepEqual(unauth, []);
  assert.equal(await noSession.count(), 0, "a reload is not a lost session");
}));

test("no code and no stored session: one line of copy, the den still renders, and Approve files nothing", { timeout: 90000 }, withApp({ code: null }, async ({ page, needs, noSession, sessions, posts, unauth }) => {
  await noSession.waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await noSession.count(), 1, "exactly one such element");
  const text = (await noSession.innerText()).trim();
  assert.ok(text.length > 0 && text.length <= 140, `one short line, got ${JSON.stringify(text)}`);
  assert.ok(!/\n/.test(text), "one line, no line break");
  assert.equal(sessions.length, 0, "nothing to redeem, so no POST /session");
  assert.equal(await needs.count(), 1, "the Needs you card still renders from the open read routes");
  await header(needs).focus();
  await page.keyboard.press("a");
  await page.waitForTimeout(300);
  assert.deepEqual(posts, []);
  assert.deepEqual(unauth, [], "the UI never sends an unauthenticated POST /requests");
}));

test("a refused or already-used code shows the same one line, drops the fragment, and files nothing", { timeout: 90000 }, withApp({ sessionStatus: 401 }, async ({ page, needs, noSession, sessions, posts, unauth }) => {
  await noSession.waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await noSession.count(), 1);
  assert.ok(!/\n/.test((await noSession.innerText()).trim()));
  assert.equal(sessions.length, 1);
  assert.ok(!page.url().includes("code="), `the spent code must not stay in the URL: ${page.url()}`);
  await header(needs).focus();
  await page.keyboard.press("a");
  await page.waitForTimeout(300);
  assert.deepEqual(posts, []);
  assert.deepEqual(unauth, []);
}));
});

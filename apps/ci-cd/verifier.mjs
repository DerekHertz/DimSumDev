// trust-ladder/02: the browser verifier. `runVerifier` starts a server, drives Chromium through a flow and returns the evidence
// (screenshots, console and page errors, failed requests, a perf trace) and the findings an agent should act on. The CLI is
// verify-ui.mjs. The deterministic parts live here; the agent supplies the flow and the judgment.
//
// A flow is { name, steps[] }; each step has exactly one of: goto, click, fill, press, waitFor, expectText, wait, screenshot.
// A finding is attributed to the last action step (goto, click, fill, press) that ran before it, so its `reproduce` list is the
// steps a person would repeat. Every run is capped: past `timeoutMs` the run records a `timeout` finding, closes everything and
// sweeps any browser still carrying the run's `--verify-run=<id>` marker, so no browser outlives the CLI.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDevServer, REPO_ROOT, FAVICON_PATH } from "./dev-server.mjs";
import { buildLaunchOptions } from "./launch-options.mjs";

export class FlowError extends Error {}
export class BrowserMissingError extends Error {}

const ACTIONS = new Set(["goto", "click", "fill", "press"]);
const STEP_KINDS = new Set([...ACTIONS, "waitFor", "expectText", "wait", "screenshot"]);
const SHOT_NAME = /^[\w.-]+$/;
const LAUNCH_CHANNELS = ["chrome", "msedge", undefined];
const CLOSE_BOUND_MS = 5000;

const isString = (v) => typeof v === "string" && v.length > 0;

export function parseFlow(raw) {
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length === 0) throw new FlowError("a flow needs a non-empty steps list");
  raw.steps.forEach((step, i) => {
    const kinds = Object.keys(step ?? {});
    const unknown = kinds.find((k) => !STEP_KINDS.has(k));
    if (unknown) throw new FlowError(`step ${i + 1}: unknown step "${unknown}" (one of ${[...STEP_KINDS].join(", ")})`);
    if (kinds.length !== 1) throw new FlowError(`step ${i + 1}: exactly one action per step, got ${kinds.length}`);
    const [kind] = kinds;
    const v = step[kind];
    const ok = {
      goto: isString(v), click: isString(v), press: isString(v), waitFor: isString(v),
      fill: isString(v?.selector) && typeof v?.value === "string",
      expectText: isString(v?.selector) && isString(v?.text),
      wait: Number.isFinite(v) && v >= 0,
      screenshot: typeof v === "string" && SHOT_NAME.test(v),
    }[kind];
    if (!ok) throw new FlowError(kind === "screenshot" ? `step ${i + 1}: bad screenshot name ${JSON.stringify(v)} (letters, digits, . _ - only)` : `step ${i + 1}: bad value for ${kind}`);
  });
  return { name: isString(raw.name) ? raw.name : "flow", steps: raw.steps };
}

export function describeStep(step) {
  const [kind] = Object.keys(step);
  const v = step[kind];
  return {
    goto: () => `open ${v}`,
    click: () => `click ${v}`,
    fill: () => `type "${v.value}" into ${v.selector}`,
    press: () => `press ${v}`,
    waitFor: () => `wait for ${v}`,
    expectText: () => `expect ${v.selector} to contain "${v.text}"`,
    wait: () => `wait ${v} ms`,
    screenshot: () => `take screenshot "${v}"`,
  }[kind]();
}

export const reproSteps = (steps, index) => steps.slice(0, index + 1).map((s, i) => `${i + 1}. ${describeStep(s)}`); // index -1: nothing ran yet

function processList(procDir) {
  if (existsSync(procDir)) {
    return readdirSync(procDir).filter((n) => /^\d+$/.test(n)).map((pid) => {
      try {
        return { pid: Number(pid), argv: readFileSync(path.join(procDir, pid, "cmdline"), "utf8").split("\0") };
      } catch {
        return null; // exited between the listing and the read
      }
    }).filter(Boolean);
  }
  const ps = execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
  return ps.split("\n").filter(Boolean).map((line) => {
    const [, pid, args] = line.match(/^\s*(\d+)\s+(.*)$/) ?? [];
    return pid ? { pid: Number(pid), argv: args.split(/\s+/) } : null;
  }).filter(Boolean);
}

export function findRunPids(runId, { procDir = "/proc" } = {}) {
  return processList(procDir).filter((p) => p.pid !== process.pid && p.argv.includes(`--verify-run=${runId}`)).map((p) => p.pid);
}

export function sweepRun(runId, { procDir = "/proc", kill = process.kill.bind(process) } = {}) {
  const pids = findRunPids(runId, { procDir });
  for (const pid of pids) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return pids;
}

const bounded = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

async function loadChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") throw new BrowserMissingError("playwright not installed, run npm install && npx playwright install chromium");
    throw err;
  }
}

async function launchBrowser(chromium, runId) {
  let last;
  for (const channel of LAUNCH_CHANNELS) {
    const opts = buildLaunchOptions(channel);
    try {
      return await chromium.launch({ ...opts, args: [...(opts.args ?? []), `--verify-run=${runId}`, "--disable-dev-shm-usage"] });
    } catch (err) {
      last = err;
    }
  }
  if (/executable doesn't exist/i.test(last?.message ?? "")) throw new BrowserMissingError("no Chromium found, run npx playwright install chromium (or set PW_CHROMIUM_PATH)");
  throw last;
}

async function startTarget({ url, den, root, skipBuild }) {
  if (url) return { base: url.replace(/\/+$/, ""), close: async () => {}, vars: {} };
  if (den) {
    const { runBuild, startDenFixture } = await import("./verifier-den.mjs");
    if (!skipBuild) await runBuild();
    return startDenFixture();
  }
  const server = createDevServer(root);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    vars: {},
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

const COLLECT_PERF = () => {
  const nav = performance.getEntriesByType("navigation")[0];
  const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
  const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
  return {
    loadMs: round(nav?.loadEventEnd), domContentLoadedMs: round(nav?.domContentLoadedEventEnd), ttfbMs: round(nav?.responseStart),
    firstContentfulPaintMs: paint["first-contentful-paint"] ?? null, largestContentfulPaintMs: round(window.__verify?.lcp),
    cumulativeLayoutShift: Math.round((window.__verify?.cls ?? 0) * 1000) / 1000, jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
  };
};

const OBSERVE_VITALS = () => {
  window.__verify = { lcp: 0, cls: 0 };
  const watch = (type, onEntry) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe({ type, buffered: true });
    } catch {
      // the browser lacks this entry type
    }
  };
  watch("largest-contentful-paint", (e) => (window.__verify.lcp = e.startTime));
  watch("layout-shift", (e) => { if (!e.hadRecentInput) window.__verify.cls += e.value; });
};

async function perform(page, step, ctx) {
  const [kind] = Object.keys(step);
  const v = step[kind];
  const timeout = ctx.stepTimeoutMs;
  if (kind === "goto") {
    const target = /^https?:\/\//.test(v) ? v : ctx.base + (v.startsWith("/") ? v : `/${v}`);
    await page.goto(target.replace(/\{(\w+)\}/g, (m, name) => ctx.vars[name] ?? m), { waitUntil: "load", timeout });
  } else if (kind === "click") await page.click(v, { timeout });
  else if (kind === "fill") await page.fill(v.selector, v.value, { timeout });
  else if (kind === "press") await page.keyboard.press(v);
  else if (kind === "waitFor") await page.waitForSelector(v, { timeout });
  else if (kind === "expectText") await page.locator(v.selector).filter({ hasText: v.text }).first().waitFor({ timeout });
  else if (kind === "wait") await page.waitForTimeout(v);
  else if (kind === "screenshot") {
    const file = path.join(ctx.outDir, `${v}.png`);
    await page.screenshot({ path: file });
    ctx.screenshots.push({ name: v, path: file });
  }
}

async function driveFlow({ flow, ctx, state }) {
  const chromium = await loadChromium();
  const browser = await launchBrowser(chromium, ctx.runId);
  state.browser = browser;
  if (state.aborted) return browser.close();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(OBSERVE_VITALS);
  const page = await context.newPage();
  state.page = page;

  const finding = (kind, message) => state.findings.push({ kind, message, step: state.lastAction, reproduce: reproSteps(flow.steps, state.lastAction) });
  page.on("console", (msg) => {
    // "Failed to load resource" is the browser's echo of a network failure, which is captured with its URL below.
    if (msg.type() !== "error" || /^Failed to load resource/.test(msg.text())) return;
    state.consoleErrors.push({ text: msg.text(), step: state.lastAction });
    finding("console-error", msg.text());
  });
  page.on("pageerror", (err) => {
    state.pageErrors.push({ text: err.message, step: state.lastAction });
    finding("page-error", err.message);
  });
  page.on("requestfailed", (req) => {
    if (new URL(req.url()).pathname === FAVICON_PATH) return;
    const error = req.failure()?.errorText ?? "failed";
    if (error === "net::ERR_ABORTED") return; // the page cancelled it (an image swapped, a navigation moved on); not a failure
    state.networkFailures.push({ url: req.url(), error, step: state.lastAction });
    finding("request-failed", `${req.url()} (${error})`);
  });
  page.on("response", (res) => {
    if (res.status() < 400 || new URL(res.url()).pathname === FAVICON_PATH) return;
    state.networkFailures.push({ url: res.url(), status: res.status(), step: state.lastAction });
    finding("http-error", `${res.url()} responded ${res.status()}`);
  });

  await browser.startTracing(page, { path: ctx.tracePath, screenshots: false });
  state.tracing = true;
  for (const [i, step] of flow.steps.entries()) {
    const [kind] = Object.keys(step);
    if (ACTIONS.has(kind)) state.lastAction = i;
    state.current = i;
    try {
      await perform(page, step, ctx);
      state.steps.push({ index: i, step: describeStep(step), ok: true });
    } catch (err) {
      const message = String(err?.message ?? err).split("\n")[0];
      state.steps.push({ index: i, step: describeStep(step), ok: false, error: message });
      state.findings.push({ kind: "step-failed", message: `${describeStep(step)}: ${message}`, step: i, reproduce: reproSteps(flow.steps, i) });
      await page.screenshot({ path: path.join(ctx.outDir, `failure-step-${i + 1}.png`) }).then(() => ctx.screenshots.push({ name: `failure-step-${i + 1}`, path: path.join(ctx.outDir, `failure-step-${i + 1}.png`) }), () => {});
      break;
    }
    if (ACTIONS.has(kind)) await page.waitForTimeout(100); // let this action's late console, request and page errors land on it
  }
  await page.waitForTimeout(300);
}

async function collectPerf(state, ctx) {
  const perf = { loadMs: null, tracePath: null };
  try {
    Object.assign(perf, await bounded(state.page.evaluate(COLLECT_PERF), 2000));
  } catch {
    // the page is gone or unresponsive; the trace still has what happened
  }
  if (state.tracing) {
    state.tracing = false;
    await bounded(state.browser.stopTracing().catch(() => {}), CLOSE_BOUND_MS);
    perf.tracePath = ctx.tracePath;
  }
  return perf;
}

/**
 * Runs `flow` against a server it starts (the repo's dev server over `root`, or the den on a fixture board with `den`) or against
 * `url`, writes `<outDir>/report.json` and returns the report. Never rejects for a finding; rejects for a bad environment.
 */
export async function runVerifier({ flow: rawFlow, root = REPO_ROOT, url, den = false, skipBuild = false, outDir, timeoutMs = 120000, stepTimeoutMs = 15000 }) {
  const flow = parseFlow(rawFlow);
  const runId = `run-${randomBytes(6).toString("hex")}`;
  outDir = path.resolve(outDir ?? path.join(".verify", `${flow.name}-${runId}`));
  await mkdir(outDir, { recursive: true });
  const started = Date.now();
  const state = { aborted: false, browser: null, page: null, tracing: false, current: -1, lastAction: -1, steps: [], findings: [], consoleErrors: [], pageErrors: [], networkFailures: [] };
  const screenshots = [];
  let target;
  let perf = { loadMs: null, tracePath: null };
  let timer;
  try {
    target = await startTarget({ url, den, root, skipBuild });
    const ctx = { runId, base: target.base, vars: target.vars, outDir, tracePath: path.join(outDir, "perf-trace.json"), screenshots, stepTimeoutMs };
    const work = driveFlow({ flow, ctx, state });
    const outcome = await Promise.race([
      work.then(() => "done"),
      new Promise((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs))),
    ]);
    if (outcome === "timeout") {
      state.aborted = true;
      const at = state.current >= 0 ? `, during step ${state.current + 1} (${describeStep(flow.steps[state.current])})` : " before the first step";
      state.findings.push({ kind: "timeout", message: `the run passed its ${timeoutMs} ms cap${at}`, step: state.current, reproduce: reproSteps(flow.steps, state.current) });
      work.catch(() => {});
    }
    if (state.page) perf = await collectPerf(state, ctx);
    if (outcome === "timeout") await bounded(work.catch(() => {}), CLOSE_BOUND_MS);
  } finally {
    clearTimeout(timer);
    state.aborted = true;
    if (state.browser) await bounded(state.browser.close().catch(() => {}), CLOSE_BOUND_MS);
    sweepRun(runId);
    await target?.close();
  }
  const report = {
    ok: state.findings.length === 0, runId, flow: flow.name, url: target?.base, outDir, durationMs: Date.now() - started, steps: state.steps, screenshots,
    consoleErrors: state.consoleErrors, pageErrors: state.pageErrors, networkFailures: state.networkFailures, perf, findings: state.findings,
  };
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

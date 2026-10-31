// portable-den/15: the `{ goal }` step end to end in a real browser: runVerifier snapshots the fixture page, a stubbed Jev picks,
// the pick is clicked in the page, and the log row is written. Runs through `npm run test:path`, which caps browser files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runVerifier } from "./verifier.mjs";

const PAGE = "apps/ci-cd/fixtures/verifier/next-click.html";

const stubJev = (p) => async (req) => {
  const pick = req.state.elements.find((e) => e.label === "Work queue");
  const offered = Object.keys(req.questions.target.criteria);
  return {
    answers: {
      goal_reached: { noul: 0.01 }, can_progress: { noul: 0.99 }, operation: { choice: "CLICK" },
      target: { choice: String(pick.index), probabilities: Object.fromEntries(offered.map((n) => [n, n === String(pick.index) ? p : 0.01])) },
    },
    usage: { input_tokens: 500 },
  };
};

async function run(goalStep, p) {
  const dir = await mkdtemp(path.join(tmpdir(), "next-click-browser-"));
  const logPath = path.join(dir, "log.jsonl");
  try {
    const flow = { name: "next-click", steps: [{ goto: PAGE }, goalStep, { expectText: { selector: "#panel", text: "Queue open" } }] };
    const report = await runVerifier({ flow, outDir: path.join(dir, "out") }, { jev: { ask: stubJev(p), env: { TYPESAFE_API_KEY: "k" }, logPath } });
    const rows = (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { report, rows };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a confident Jev pick is clicked in the page, the destructive Stop is never offered, and the step is logged as decided", async () => {
  const { report, rows } = await run({ goal: "open the work queue" }, 0.9);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "decided");
  assert.equal(rows[0].pick.label, "Work queue");
  assert.equal(rows[0].flow, "next-click");
  assert.equal(rows[0].step, 1);
});

test("a low-confidence pick is handed to Claude: its `claude` selector is clicked and logged", async () => {
  const { report, rows } = await run({ goal: "open the work queue", claude: "#work" }, 0.4);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(rows[0].decision, "handed");
  assert.equal(rows[0].claude_pick, "#work");
});

test("a handed-off step without a `claude` selector is a step-failed finding that names the candidates", async () => {
  const { report } = await run({ goal: "open the work queue" }, 0.4);
  const f = report.findings.find((x) => x.kind === "step-failed");
  assert.ok(f, JSON.stringify(report.findings));
  assert.match(f.message, /hand to Claude/);
  assert.match(f.message, /Work queue/);
});

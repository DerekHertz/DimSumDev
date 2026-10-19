// organism-infra/211 AC3: `npm run spend` (scripts/spend.mjs) prints billed spend per ticket and
// per role, the orchestrator included.
//
// Pinned contract:
//   package.json scripts.spend === "node scripts/spend.mjs"
//   node scripts/spend.mjs [--json]    reads $DEN_ROOT/.scratch/usage.jsonl
//   - Only kind:"spend" rows count (agent rows carry the same totals but are not summed again).
//     Garbage lines and other kinds are skipped. No usage.jsonl or no spend rows: exit 0, no NaN.
//   - --json prints one object:
//       {"by_ticket": {"<ref>": T, ...}, "by_role": {"<role>": T, ...}}
//     where T = {input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, total}
//     and total is the sum of the four. A spend row with no ticket is keyed "(none)" under by_ticket.
//   - Text mode prints one line per ticket and per role, each carrying the key and its total as a
//     plain integer (no thousands separators), and each of the four totals as plain integers too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../apps/board/board-fixture.mjs";

const SPEND = path.join(REPO_ROOT, "scripts", "spend.mjs");

const spend = (ticket, role, [i, cc, cr, o], extra = {}) => ({
  kind: "spend", ts: "2026-10-09T00:00:00.000Z", session: `s-${role}`, role, ...(ticket ? { ticket } : {}),
  input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o, ...extra,
});

function report(usageRows, args = []) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "spend-report-")));
  mkdirSync(path.join(root, ".scratch"));
  if (usageRows !== null) writeFileSync(path.join(root, ".scratch", "usage.jsonl"), usageRows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return spawnSync(process.execPath, [SPEND, ...args], { cwd: root, env: { ...process.env, DEN_ROOT: root }, encoding: "utf8", timeout: 15000 });
}

const ROWS = () => [
  spend("f/01-a", "orchestrator", [1, 10, 100, 1000]),
  spend("f/01-a", "developer", [2, 20, 200, 2000]),
  spend("f/01-a", "developer", [3, 30, 300, 3000]), // a second developer return on the same ticket
  spend("f/02-b", "qa", [4, 40, 400, 4000]),
  spend(null, "orchestrator", [5, 50, 500, 5000]), // orchestrator spend not tied to a ticket
  { kind: "cell", ticket: "f/01-a", cell: "developer", tokens: 9, ms: 1, outcome: "ok", input_tokens: 99999, cache_creation_input_tokens: 99999, cache_read_input_tokens: 99999, output_tokens: 99999 },
  { kind: "usage", ts: "2026-10-09T00:00:00Z", five_hour: 10 },
  "garbage {",
];

test("package.json has an npm run spend entry", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.spend, "node scripts/spend.mjs");
});

test("--json sums spend rows per ticket and per role, orchestrator included", () => {
  const r = report(ROWS(), ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.by_ticket["f/01-a"], { input_tokens: 6, cache_creation_input_tokens: 60, cache_read_input_tokens: 600, output_tokens: 6000, total: 6666 });
  assert.deepEqual(out.by_ticket["f/02-b"], { input_tokens: 4, cache_creation_input_tokens: 40, cache_read_input_tokens: 400, output_tokens: 4000, total: 4444 });
  assert.deepEqual(out.by_ticket["(none)"], { input_tokens: 5, cache_creation_input_tokens: 50, cache_read_input_tokens: 500, output_tokens: 5000, total: 5555 });
  assert.deepEqual(out.by_role.orchestrator, { input_tokens: 6, cache_creation_input_tokens: 60, cache_read_input_tokens: 600, output_tokens: 6000, total: 6666 });
  assert.deepEqual(out.by_role.developer, { input_tokens: 5, cache_creation_input_tokens: 50, cache_read_input_tokens: 500, output_tokens: 5000, total: 5555 });
  assert.deepEqual(out.by_role.qa, { input_tokens: 4, cache_creation_input_tokens: 40, cache_read_input_tokens: 400, output_tokens: 4000, total: 4444 });
  assert.deepEqual(Object.keys(out.by_role).sort(), ["developer", "orchestrator", "qa"]);
});

test("text mode prints a line per ticket and per role with plain-integer totals", () => {
  const r = report(ROWS());
  assert.equal(r.status, 0, r.stderr);
  const line = (key) => r.stdout.split("\n").find((l) => l.includes(key));
  assert.match(line("f/01-a") ?? "", /\b6666\b/);
  assert.match(line("f/02-b") ?? "", /\b4444\b/);
  assert.match(line("orchestrator") ?? "", /\b6666\b/);
  assert.match(line("developer") ?? "", /\b5555\b/);
  assert.match(line("qa") ?? "", /\b4444\b/);
  assert.match(r.stdout, /\b6000\b/, "the output-token total for f/01-a is shown");
  assert.doesNotMatch(r.stdout, /NaN|undefined|99999/);
});

test("no spend rows: exit 0, empty JSON maps, no NaN", () => {
  const r = report([{ kind: "usage", ts: "2026-10-09T00:00:00Z", five_hour: 5 }], ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { by_ticket: {}, by_role: {} });
  const text = report([{ kind: "usage", ts: "2026-10-09T00:00:00Z", five_hour: 5 }]);
  assert.equal(text.status, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /NaN|undefined/);
});

test("no usage.jsonl at all: exit 0", () => {
  const r = report(null, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { by_ticket: {}, by_role: {} });
});

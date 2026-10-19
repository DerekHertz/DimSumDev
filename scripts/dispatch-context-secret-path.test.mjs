// organism-infra/166: the context step's secret-in-root fallback names the offending file (repo-relative path, never the
// contents), so a recurrence costs no hunt. Seam: buildContext's row, and the CLI's printed JSON line plus usage row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext } from "./dispatch-context.mjs";

const execFileP = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./dispatch-context.mjs", import.meta.url));
const tmp = (p) => mkdtempSync(path.join(realpathSync(tmpdir()), p));
// Built at run time so this file itself holds no secret-looking literal for the root scan.
const FAKE_AWS_KEY = "AKI" + "A" + "ABCDEFGHIJKLMNOP";
const NOW = () => 1_700_000_000_000;

function makeRepo(files = {}) {
  const root = tmp("dc166-repo-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const ticketText = "# 99: sample\n\n**Type:** feature\n\n**What to build:** Add a retry to the relay.\n\n**Status:** ready-for-agent\n\n## Comments\n";

// git goes to real git in the tmp repo; any jg call that slips through is a failure the test would notice.
function fakeRun() {
  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push(cmd);
    if (cmd === "jg") return { stdout: "## scripts/a.mjs\nx\nEnd context.\n", exitCode: 0 };
    try {
      const { stdout } = await execFileP(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
      return { stdout, exitCode: 0 };
    } catch (e) {
      return { stdout: e.stdout ?? "", exitCode: typeof e.code === "number" ? e.code : 1 };
    }
  };
  return { run, calls };
}

test("[166] AC1: the secret-in-root row names the first matching file and never holds its contents", async () => {
  const root = makeRepo({
    "a/clean.mjs": "export const ok = 1;\n",
    "b/leak.mjs": `export const k = "${FAKE_AWS_KEY}";\n`,
    "c/leak.mjs": `export const k = "${FAKE_AWS_KEY}";\n`,
  });
  const f = fakeRun();
  const { file, row } = await buildContext({ ticketText, root, run: f.run, now: NOW });
  assert.equal(file, undefined);
  assert.equal(row.fallback, "secret-in-root");
  assert.equal(row.secret_path, "b/leak.mjs", "the first matching repo-relative path");
  assert.ok(!f.calls.includes("jg"), "nothing is sent to jg");
  assert.ok(!JSON.stringify(row).includes(FAKE_AWS_KEY), "no matched text in the row");
  assert.ok(!JSON.stringify(row).includes(root), "the path is repo-relative, not absolute");
});

test("[166] AC1: a fallback other than secret-in-root carries no secret_path", async () => {
  const root = makeRepo({ "src/ok.mjs": "export const ok = 1;\n" });
  const f = fakeRun();
  const { row } = await buildContext({ ticketText: ticketText.replace("feature", "docs"), root, run: f.run, now: NOW });
  assert.ok(row.skipped, "a non-code ticket is skipped");
  assert.ok(!("secret_path" in row), "no secret_path on a skip");
});

function cliEnv() {
  const bin = tmp("dc166-bin-");
  symlinkSync(process.execPath, path.join(bin, "node"));
  const jg = path.join(bin, "jg");
  writeFileSync(jg, `#!/usr/bin/env node
if (process.argv[2] === "files") { console.log("3 files, 1000 bytes eligible"); process.exit(0); }
console.log("## scripts/a.mjs\\nexcerpt\\nEnd context.");
`);
  chmodSync(jg, 0o755);
  return { bin, home: tmp("dc166-home-") };
}

test("[166] AC1: the CLI printed line and the kind:jg usage row carry secret_path, never the contents", () => {
  const root = makeRepo({ "scripts/jg.mjs": "x", "src/leak.mjs": `export const k = "${FAKE_AWS_KEY}";\n` });
  mkdirSync(path.join(root, ".scratch", "feat-x", "issues"), { recursive: true });
  writeFileSync(path.join(root, ".scratch", "feat-x", "issues", "01-thing.md"), ticketText);
  const e = cliEnv();
  const r = spawnSync(process.execPath, [SCRIPT, "--ticket", "feat-x/01-thing", "--root", root], {
    encoding: "utf8",
    timeout: 60000,
    env: { PATH: `${e.bin}:/usr/bin:/bin`, HOME: e.home, DEN_ROOT: root },
  });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.fallback, "secret-in-root");
  assert.equal(out.secret_path, "src/leak.mjs");
  assert.ok(!r.stdout.includes(FAKE_AWS_KEY) && !r.stderr.includes(FAKE_AWS_KEY), "no matched text printed");
  const usagePath = path.join(root, ".scratch", "usage.jsonl");
  assert.ok(existsSync(usagePath));
  const usageText = readFileSync(usagePath, "utf8");
  const row = usageText.trim().split("\n").map((l) => JSON.parse(l)).find((x) => x.kind === "jg");
  assert.equal(row.fallback, "secret-in-root");
  assert.equal(row.secret_path, "src/leak.mjs");
  assert.ok(!usageText.includes(FAKE_AWS_KEY), "no matched text in the usage log");
});

// trust-ladder/02: the same verifier run, from inside an agent container, returns the same evidence as a host run.
// The container is built like the bridge builds one (ADR 0031 decision 2): container root, no capabilities, read-only root,
// tmpfs /tmp and /root, the worktree mounted at its host path, joined to the internal `den-agents` network. Its HOME is empty,
// so any Chromium it finds comes from the image (PW_CHROMIUM_PATH), never the host's Playwright cache.
// Skipped unless VERIFY_AGENT_IMAGE names an image built from apps/bridge/agents/image/Dockerfile:
//   docker build -t den-agent:verify apps/bridge/agents/image && VERIFY_AGENT_IMAGE=den-agent:verify node --test apps/ci-cd/verify-ui.docker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const IMAGE = process.env.VERIFY_AGENT_IMAGE;
const DOCKER = "/usr/bin/docker";
const DOCKER_HOST = process.env.DOCKER_HOST || `unix://${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`}/docker.sock`;

const docker = (args) =>
  new Promise((resolve) => {
    execFile(DOCKER, args, { env: { ...process.env, DOCKER_HOST }, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });

test("a run from inside an agent container reaches the dev server and returns the same evidence as the host", { skip: !IMAGE && "set VERIFY_AGENT_IMAGE to run" }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), "verify-ui-docker-"));
  try {
    const run = await docker([
      "run", "--rm", "--init", "--user", "0:0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
      "--tmpfs", "/tmp", "--tmpfs", "/root", "--network", "den-agents", "--memory", "2g", "--pids-limit", "256",
      "-v", `${REPO_ROOT}:${REPO_ROOT}`, "-v", `${out}:${out}`, "-w", REPO_ROOT, IMAGE,
      "node", "apps/ci-cd/verify-ui.mjs", "--flow", "apps/ci-cd/fixtures/verifier/broken.flow.json", "--out", out, "--timeout", "90000",
    ]);
    assert.equal(run.code, 1, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
    const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
    assert.deepEqual(report.findings.map((f) => f.kind).sort(), ["http-error", "page-error", "request-failed"]);
    assert.equal(report.screenshots.length, 1);
    assert.ok((await readFile(report.screenshots[0].path)).length > 1000);
    assert.ok(report.perf.loadMs > 0);
    assert.ok(JSON.parse(await readFile(report.perf.tracePath, "utf8")).traceEvents.length > 0);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

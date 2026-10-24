// organism-infra/183: the CI test job's Playwright install must fail fast, cache the browser,
// and not depend on apt. Reads .github/workflows/ci.yml as text (no YAML dependency) and checks
// the "test" job's steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const workflow = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

test("the sandbox job uses the supported Ubuntu host and requires real resource enforcement", () => {
  const job=workflow.split(/^  test:/m)[1]?.split(/^  test-browser:/m)[0];
  assert.match(job,/runs-on: ubuntu-24\.04/);
  const preflight=job.indexOf('createResourceLauncher');
  assert.ok(preflight>=0&&preflight<job.indexOf('npm run test:rest'));
  const setup=job.indexOf('apt-get install');
  assert.ok(setup>=0&&setup<preflight,'sandbox prerequisites must be installed before enforcement is probed');
  assert.match(job,/apt-get install[^\n]*bubblewrap[^\n]*dbus-user-session/);
  assert.match(job,/systemctl start "user@\$\(id -u\)\.service"/);
  assert.match(job,/if\s*\(!\w+\.ok\)\s*throw new Error/);
});

// Split the "test" job's steps into blocks, one per "- name:" entry.
function testJobSteps() {
  const job = workflow.split(/^  test-browser:/m)[1]?.split(/^  security:/m)[0];
  assert.ok(job, "expected a test-browser job in ci.yml");
  return job
    .split(/^      - name: /m)
    .slice(1)
    .map((block) => ({ name: block.split("\n")[0], text: block }));
}

function installStep() {
  const step = testJobSteps().find((s) => /playwright\s+install/.test(s.text));
  assert.ok(step, "expected a step that runs `playwright install`");
  return step;
}

test("the Playwright install step has its own timeout-minutes, well under the job's 15", () => {
  const m = installStep().text.match(/^\s+timeout-minutes:\s*(\d+)/m);
  assert.ok(m, "install step needs timeout-minutes so a stall cannot eat the job timeout");
  assert.ok(Number(m[1]) <= 10, `install step timeout ${m[1]} must be <= 10 minutes`);
});

test("the Playwright install retries once", () => {
  const text = installStep().text;
  assert.match(text, /for\s+\w+\s+in\s+1\s+2/, "expected a two-attempt retry loop");
  assert.match(text, /timeout\s+(-k\s+\d+\s+)?\d+\s+npx playwright install/, "each attempt needs its own timeout");
});

test("the install does not run apt via --with-deps (ubuntu-latest ships Chrome, which smoke prefers)", () => {
  assert.ok(!/--with-deps/.test(workflow), "--with-deps runs apt-get, the suspected stall");
});

test("the browser dir is cached, keyed on the Playwright version from package-lock.json", () => {
  const steps = testJobSteps();
  const cache = steps.find((s) => /uses:\s*actions\/cache@/.test(s.text));
  assert.ok(cache, "expected an actions/cache step");
  assert.match(cache.text, /~\/\.cache\/ms-playwright/, "cache path");
  assert.match(cache.text, /key:.*steps\.[\w-]+\.outputs\.[\w-]+/, "key derived from the version step output");
  assert.match(cache.text, /uses:\s*actions\/cache@[0-9a-f]{40}/, "pinned to a commit SHA like the other actions");

  const versionStep = steps.find((s) => /package-lock\.json/.test(s.text) && /node_modules\/playwright/.test(s.text));
  assert.ok(versionStep, "expected a step reading the Playwright version from package-lock.json");
  assert.ok(steps.indexOf(versionStep) < steps.indexOf(cache), "version step must run before the cache step");
});

test("a warm cache skips the install step", () => {
  assert.match(installStep().text, /if:\s*steps\.[\w-]+\.outputs\.cache-hit\s*!=\s*'true'/);
});

test("the cache and install steps run before the browser tests", () => {
  const steps = testJobSteps();
  const idx = (re) => steps.findIndex((s) => re.test(s.text));
  const run = idx(/run:\s*npm run test:browser/);
  assert.ok(run > idx(/actions\/cache@/) && run > idx(/playwright\s+install/));
});

test("CI runs two parallel test jobs, each with a timeout of 15 minutes or less", () => {
  for (const name of ["test", "test-browser"]) {
    const m = workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?timeout-minutes:\\s*(\\d+)`, "m"));
    assert.ok(m, `expected a ${name} job with timeout-minutes`);
    assert.ok(Number(m[1]) <= 15, `${name} timeout ${m[1]}`);
  }
  assert.match(workflow, /npm run test:rest/);
  assert.match(workflow, /npm run test:browser/);
  assert.ok(!/needs:/.test(workflow), "the two test jobs must not wait on each other");
});

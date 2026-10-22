// den-revival/01, ADR 0030 test 1: Codex's own sandbox starts under the real launch plan. No model or account call.
// The plan is the real one: a systemd user scope, prlimit, the outer bwrap wrapper (apps/bridge/agents/resource-group.mjs) and a
// named profile that grants only the Node binary, Codex's native helper and the worktree. The failure message carries the captured
// stderr: that is the evidence the three PR 389 diagnostics lost. Skips, with its reason, on a host that cannot run the plan.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { codexSandboxHost, describeRun, makeFixture, dropSlice } from "./codex-sandbox-test-helpers.mjs";

after(dropSlice);

test("codex sandbox runs a Node probe under the real resource-group launch plan and prints its output", async (t) => {
  const host = await codexSandboxHost();
  if (host.skip) return t.skip(host.skip);
  const fixture = await makeFixture(host);
  try {
    const r = await fixture.run(`import fs from "node:fs";\nfs.writeSync(1, "den-codex-probe-ok\\n");\n`);
    assert.equal(r.code, 0, `Codex's sandbox did not start under the den's launch plan.\n${describeRun(r)}`);
    assert.equal(r.stdout.trim(), "den-codex-probe-ok", describeRun(r));
    assert.equal(r.settled, true, `the run's scope did not settle: ${r.unit}`);
  } finally {
    await fixture.dispose();
  }
});

// den-revival/01, ADR 0030 test 2: under the real launch plan, a write outside the worktree is refused, and a planted fake
// auth.json stays unreadable and unchanged. Everything is checked on the host disk after the run, never by the exit code: a refused
// write can exit 0 into a private mount. The fixture lives under the home directory, not /tmp, so a private /tmp cannot explain a
// missing file. No model or account call. Skips, with its reason, on a host that cannot run the plan.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { codexSandboxHost, describeRun, makeFixture, dropSlice } from "./codex-sandbox-test-helpers.mjs";

after(dropSlice);

// The probe writes with fs only (Node's console output is lost on the socket stdio a bridge hands a child, see the handoff), one
// file inside the worktree and one outside it, and tries to read and overwrite each planted auth.json. It prints nothing it read.
const PROBE = `import fs from "node:fs";
const [inside, outside, ...auth] = process.argv.slice(2);
const attempt = (fn) => { try { fn(); return "done"; } catch (e) { return e.code ?? "error"; } };
const report = { inside: attempt(() => fs.writeFileSync(inside, "inside-ok")), outside: attempt(() => fs.writeFileSync(outside, "outside-leak")) };
report.reads = auth.map((f) => { try { return fs.readFileSync(f, "utf8").length > 0 ? "READABLE" : "empty"; } catch (e) { return e.code ?? "error"; } });
report.writes = auth.map((f) => attempt(() => fs.writeFileSync(f, "tampered")));
fs.writeSync(1, JSON.stringify(report) + "\\n");
`;

test("a write outside the worktree is refused, and a planted fake auth.json stays unreadable and unchanged", async (t) => {
  const host = await codexSandboxHost();
  if (host.skip) return t.skip(host.skip);
  const fixture = await makeFixture(host);
  try {
    const inside = `${fixture.worktree}/inside.txt`;
    const outside = `${fixture.outside}/outside.txt`;
    const planted = fixture.authFiles.map((file) => [file, readFileSync(file, "utf8")]);
    const r = await fixture.run(PROBE, [inside, outside, ...fixture.authFiles]);
    // The probe really ran under the sandbox: its worktree write landed on the host disk.
    assert.ok(existsSync(inside), `the sandboxed probe never wrote inside the worktree, so nothing below proves a refusal.\n${describeRun(r)}`);
    assert.equal(readFileSync(inside, "utf8"), "inside-ok", describeRun(r));
    assert.equal(existsSync(outside), false, `a write outside the worktree reached the host disk: ${outside}\n${describeRun(r)}`);
    for (const [file, before] of planted) {
      assert.equal(readFileSync(file, "utf8"), before, `a planted auth.json was changed from inside the sandbox: ${file}`);
    }
    assert.ok(!r.stdout.includes(fixture.marker) && !r.stderr.includes(fixture.marker), "the planted credential's contents reached the probe's output");
    assert.deepEqual(JSON.parse(r.stdout).reads.filter((v) => v === "READABLE"), [], `a planted auth.json was readable inside the sandbox\n${describeRun(r)}`);
  } finally {
    await fixture.dispose();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineCanaryPlan, CANARY_SLICE } from "./codex-permissions-canary.mjs";

test("the offline canary plan selects only the task-owned slice and shell sandbox", () => {
  const plan = offlineCanaryPlan({ root: "/tmp/den-codex-profile-task2-Ab1234", codexBin: "/tools/codex", nativeHelper: "/tools/private-package/bin/codex", nodeBin: "/tools/node", port: 12345 });
  assert.equal(plan.slice, "den-agents-codex-task2");
  assert.equal(CANARY_SLICE, plan.slice);
  assert.equal(plan.launchable, false);
  assert.deepEqual(plan.args.slice(0, 6), ["sandbox", "--permission-profile", "bridge-offline-canary", "--cd", `${plan.root}/worktree`, "--"]);
  assert.equal(plan.env.CODEX_HOME, `${plan.root}/native`);
  assert.equal(plan.env.HOME, `${plan.root}/home`);
  assert.equal(Object.hasOwn(plan.env, "OPENAI_API_KEY"), false);
  assert.match(plan.config, /cli_auth_credentials_store = "ephemeral"/);
  assert.match(plan.config, /"\/tmp\/den-codex-profile-task2-Ab1234\/native" = "deny"/);
  assert.match(plan.config, /"\/tools\/private-package\/bin\/codex" = "read"/);
  assert.doesNotMatch(plan.config, /"\/tools\/private-package" =/);
  assert.doesNotMatch(plan.config, /"\/tools" =/);
});

test("the canary refuses roots outside its disposable fixture prefix and command interpolation", () => {
  const valid = { root: "/tmp/den-codex-profile-task2-Ab1234", codexBin: "/tools/codex", nativeHelper: "/tools/private-package/bin/codex", nodeBin: "/tools/node", port: 12345 };
  for (const patch of [{ root: "/tmp" }, { root: `${valid.root}/child` }, { root: `${valid.root}/../outside` }, { codexBin: "/tools/codex;echo" }, { nativeHelper: undefined }, { nativeHelper: "/tools/../codex" }, { port: 0 }]) {
    assert.throws(() => offlineCanaryPlan({ ...valid, ...patch }));
  }
});

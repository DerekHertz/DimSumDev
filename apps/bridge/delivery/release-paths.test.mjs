import { test } from "node:test";
import assert from "node:assert/strict";
import { isBridgePath, touchesBridge } from "./release-paths.mjs";

test("bridge, service, package and lock files count; docs, UI and tests do not", () => {
  for (const f of ["apps/bridge/server.mjs", "apps/bridge/service/den-service.mjs", "package.json", "package-lock.json", "scripts/risk-check.mjs"]) assert.equal(isBridgePath(f), true, f);
  for (const f of ["docs/adr/0001.md", "README.md", "apps/ui/src/App.jsx", "apps/bridge/server.test.mjs", "scripts/other.mjs", "apps/bridgey/x.mjs"]) assert.equal(isBridgePath(f), false, f);
  assert.equal(touchesBridge(["docs/a.md", "apps/bridge/x.mjs"]), true);
  assert.equal(touchesBridge(["docs/a.md"]), false);
  assert.equal(touchesBridge(undefined), false);
});

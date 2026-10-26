// trust-ladder/03: qa verify calls the browser verifier and reports its evidence in the form the bridge reads (delivery/prompts.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the qa role definition tells verify to run the browser verifier and list its evidence", () => {
  const qa = readFileSync(new URL("../.claude/agents/qa.md", import.meta.url), "utf8");
  assert.match(qa, /npm run verify:ui/);
  assert.match(qa, /browser-verify/);
  assert.match(qa, /Verifier evidence:/);
});

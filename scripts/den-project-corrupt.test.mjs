// multi-project/04: a corrupt registry is reported by the CLI as a line, not a stack trace.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("den:project verify and remove on a corrupt registry print the reason and leave the file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "den-state-"));
  const file = path.join(dir, "projects.json");
  writeFileSync(file, "{not json");
  const script = new URL("./den-project.mjs", import.meta.url).pathname;
  for (const args of [["verify", "acme"], ["remove", "acme"]]) {
    const r = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, DEN_STATE_DIR: dir }, encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, args[0]);
    assert.match(out, /registry/, args[0]);
    assert.doesNotMatch(out, /\n\s+at /, `${args[0]} printed a stack`);
  }
  assert.equal(readFileSync(file, "utf8"), "{not json");
});

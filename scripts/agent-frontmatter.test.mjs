// Claude Code silently skips a role whose frontmatter is not valid YAML, so a
// stray ": " in a plain value makes the role vanish (qa did, 2026-10-26).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { render } from "./codex-sync.mjs";

const dir = join(import.meta.dirname, "..", ".claude", "agents");

export function plainScalarErrors(text) {
  const front = text.split(/^---$/m)[1] ?? "";
  const errors = [];
  front.split("\n").forEach((line, i) => {
    const m = line.match(/^\s*(?:- )?[\w-]+: (.*)$/);
    if (!m) return;
    const value = m[1];
    if (/^["'[{|>]/.test(value)) return;
    if (value.includes(": ") || value.endsWith(":") || value.includes(" #")) {
      errors.push(`line ${i + 1}: unquoted value holds ": " or " #": ${value.slice(0, 60)}`);
    }
  });
  return errors;
}

test("a plain value with a colon-space is caught", () => {
  assert.equal(plainScalarErrors("---\npurpose: a: b\n---\n").length, 1);
  assert.equal(plainScalarErrors('---\npurpose: "a: b"\n---\n').length, 0);
});

for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  test(`${file} frontmatter has no unquoted ": " in a plain value`, () => {
    assert.deepEqual(plainScalarErrors(readFileSync(join(dir, file), "utf8")), []);
  });
}

test("the codex mirror unquotes a quoted description", () => {
  const toml = render(readFileSync(join(dir, "chief-of-staff.md"), "utf8"));
  assert.match(toml, /^description = "The executive role/m);
});

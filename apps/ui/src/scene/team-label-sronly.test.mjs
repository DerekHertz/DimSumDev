// den-scene-v1/03 bounce 1: the noren sign is the visible stall name, so the floating .team-label
// text must be visually hidden (sr-only) while its ChipLayer anchor stays for screen readers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const css = read("../styles.css");

// Concatenate every declaration block whose selector list names .team-label.
const declarations = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, sel]) => /(^|[\s,])\.team-label(?![\w-])/.test(sel))
  .map(([, , body]) => body)
  .join(";");

test(".team-label text is visually hidden with the sr-only pattern (the noren is the visible name)", () => {
  assert.ok(declarations, ".team-label rule present");
  assert.match(declarations, /position:\s*absolute/);
  assert.match(declarations, /width:\s*1px/);
  assert.match(declarations, /height:\s*1px/);
  assert.match(declarations, /overflow:\s*hidden/);
  assert.match(declarations, /clip:\s*rect\(0[^)]*\)|clip-path:\s*inset\(50%\)/, "clipped to nothing");
  assert.doesNotMatch(declarations, /font-size:\s*(1[2-9]|[2-9]\d)px/, "no visible 18px ink text");
});

test("the ChipLayer team anchor stays: class, text and positioning hook are unchanged", () => {
  const chip = read("./ChipLayer.jsx");
  assert.match(chip, /className="team-label"/);
  assert.match(chip, /\{l\.text\}/);
  assert.match(chip, /labelNodes/);
});

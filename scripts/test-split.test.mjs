import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { allTestFiles, split, isBrowserFile, BROWSER_FILES } from "./test-split.mjs";

test("every test file lands in exactly one group", () => {
  const all = allTestFiles();
  const { browser, rest } = split(all);
  assert.equal(browser.length + rest.length, all.length);
  assert.ok(!browser.some((f) => rest.includes(f)));
});

test("the listed browser files exist and *.browser.test.mjs files are browser files", () => {
  const all = allTestFiles();
  for (const f of BROWSER_FILES) assert.ok(all.includes(f), `${f} is listed but missing`);
  const { browser } = split(all);
  for (const f of all.filter((x) => x.endsWith(".browser.test.mjs"))) assert.ok(browser.includes(f));
});

test("a file that imports playwright is a browser file whatever its name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-"));
  fs.writeFileSync(path.join(dir, "new.test.mjs"), 'import { chromium } from "play' + 'wright";\n');
  fs.writeFileSync(path.join(dir, "plain.test.mjs"), 'import test from "node:test";\n');
  assert.equal(isBrowserFile("new.test.mjs", dir), true);
  assert.equal(isBrowserFile("plain.test.mjs", dir), false);
});

test("no file in rest imports playwright", () => {
  const { rest } = split();
  for (const f of rest) assert.equal(isBrowserFile(f), false);
  const root = path.resolve(import.meta.dirname, "..");
  for (const f of rest) assert.ok(!/from\s+["']playwright["']/.test(fs.readFileSync(path.join(root, f), "utf8")), f);
});

test("allTestFiles covers apps, packages and scripts, as the old npm test glob did", () => {
  const tops = new Set(allTestFiles().map((f) => f.split("/")[0]));
  for (const top of tops) assert.ok(["apps", "packages", "scripts"].includes(top), top);
  assert.ok(tops.has("apps") && tops.has("scripts"));
});

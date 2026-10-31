// portable-den/09: docviz's PR diagram as one marked comment. Seam: the CLI (main) run with stub `docviz` and `gh`
// executables on PATH; the stub gh keeps the PR's comments in a JSON file.
// Criterion map:
//   AC1 a PR gets the docviz comment with its cost footer      -> "posts the docviz comment ..."
//   AC3 without docviz the PR body says skipped, nothing fails -> "without docviz on PATH ..."
//   AC5 a second push edits the same comment                   -> "a second push edits ..."
//   AC2 (script half) docviz failing leaves a one-line note    -> "a docviz failure ..."
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, MARKER } from "./docviz-pr.mjs";

const FOOTER = "<sub>Diagram by docviz, cost $0.04.</sub>";

function rig({ withDocviz = true, docvizFails = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "docviz-pr-"));
  const bin = path.join(dir, "bin");
  const store = path.join(dir, "comments.json");
  const log = path.join(dir, "docviz-args.json");
  writeFileSync(store, "[]");
  const stub = (name, code) => {
    writeFileSync(path.join(bin, name), `#!${process.execPath}\n${code}`);
    chmodSync(path.join(bin, name), 0o755);
  };
  mkdirSync(bin, { recursive: true });
  return { dir, bin, store, log, stub, withDocviz, docvizFails };
}

function setup(opts) {
  const r = rig(opts);
  r.stub("gh", `
const fs = require("fs"); const a = process.argv.slice(2); const f = ${JSON.stringify(r.store)};
const list = JSON.parse(fs.readFileSync(f, "utf8")); const body = (a.find((x) => x.startsWith("body=")) || "").slice(5);
const jq = a[a.indexOf("--jq") + 1] || "";
if (a.includes("--jq") && a.includes("user")) { console.log("bridge"); }
else if (a.includes("--jq")) { const who = /user\\.login == "([^"]+)"/.exec(jq); console.log(list.filter((c) => c.body.startsWith(${JSON.stringify(MARKER)}) && (!who || c.user === who[1])).map((c) => c.id).join("\\n")); }
else if (a.includes("PATCH")) { const id = Number(a.find((x) => /comments\\/\\d+$/.test(x)).split("/").pop()); list.find((c) => c.id === id).body = body; fs.writeFileSync(f, JSON.stringify(list)); }
else { list.push({ id: list.length + 100, user: "bridge", body }); fs.writeFileSync(f, JSON.stringify(list)); }
`);
  if (r.withDocviz) {
    r.stub("docviz", r.docvizFails
      ? `console.error("diagram doesn't parse: line 3\\ncost: $0.02"); process.exit(2);`
      : `require("fs").writeFileSync(${JSON.stringify(r.log)}, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(`${MARKER}\n## How this PR works\n\n${FOOTER}`)});`);
  }
  const env = { ...process.env, PATH: r.bin };
  const lines = [];
  const run = (argv, cwd = r.dir) => main(argv, { env, cwd, out: (s) => lines.push(s) });
  return { ...r, run, lines, comments: () => JSON.parse(readFileSync(r.store, "utf8")) };
}

const ARGS = ["steps.json", "--pr", "https://github.com/o/r/pull/7", "--title", "t"];

test("posts the docviz comment with its cost footer, and passes CONTEXT.md as the glossary when present", async () => {
  const t = setup();
  writeFileSync(path.join(t.dir, "CONTEXT.md"), "terms");
  assert.equal(await t.run(ARGS), 0);
  assert.equal(t.comments().length, 1);
  assert.ok(t.comments()[0].body.startsWith(MARKER));
  assert.ok(t.comments()[0].body.includes(FOOTER), "the cost footer is in the posted comment");
  assert.deepEqual(JSON.parse(readFileSync(t.log, "utf8")), ["pr", "steps.json", "--pr", "https://github.com/o/r/pull/7", "--title", "t", "--glossary", "CONTEXT.md"]);
});

test("a second push edits the same comment instead of adding one", async () => {
  const t = setup();
  await t.run(ARGS);
  const first = t.comments()[0].id;
  assert.equal(await t.run(ARGS), 0);
  assert.equal(t.comments().length, 1);
  assert.equal(t.comments()[0].id, first);
  assert.match(t.lines.at(-1), /^updated:/);
});

test("a marked comment somebody else wrote is never edited: a new one is posted", async () => {
  const t = setup();
  writeFileSync(t.store, JSON.stringify([{ id: 5, user: "mallory", body: `${MARKER}\nhers` }]));
  assert.equal(await t.run(ARGS), 0);
  assert.equal(t.comments().length, 2);
  assert.equal(t.comments()[0].body, `${MARKER}\nhers`);
  assert.match(t.lines.at(-1), /^posted:/);
});

test("without docviz on PATH it skips, exits 0, posts nothing, and the body line says so", async () => {
  const t = setup({ withDocviz: false });
  assert.equal(await t.run(ARGS), 0);
  assert.match(t.lines.at(-1), /^skipped: docviz is not on PATH/);
  assert.deepEqual(t.comments(), []);
  assert.equal(await t.run(["--body-line"]), 0);
  assert.equal(t.lines.at(-1), "- Diagram: skipped, docviz is not on PATH");
});

test("a docviz failure leaves a one-line note in the marked comment and exits 0", async () => {
  const t = setup({ docvizFails: true });
  assert.equal(await t.run(ARGS), 0);
  assert.equal(t.comments().length, 1);
  assert.equal(t.comments()[0].body, `${MARKER}\nNo diagram on this push: diagram doesn't parse: line 3\n`);
});

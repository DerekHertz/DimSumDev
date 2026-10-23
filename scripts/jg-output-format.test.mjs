// organism-infra/97: the live AC1 run found that real jg (0.8.0) opens a search with "Jevgrep: N relevant files." and has no
// "## <path>" headers, so the wrapper counted 0 files and every successful search fell back "incomplete". The wrapper must
// count files from the real header as well as from "## " headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runJg } from "./jg.mjs";

const root = () => {
  const r = mkdtempSync(path.join(realpathSync(tmpdir()), "jgfmt-"));
  mkdirSync(path.join(r, ".git"));
  writeFileSync(path.join(r, ".git", "HEAD"), "ref: refs/heads/main\n");
  return r;
};
const answer = (stdout) => ({ run: async () => ({ stdout, exitCode: 0 }) });

const REAL = 'Jevgrep: 147 relevant files.\nSymbols use name@start-end.\n- "scripts/jg.mjs" — implementation; source below\n\nSource block "scripts/jg.mjs" lines 1-3:\n```\nx\n```\n\nEnd context.\n';

test("[97] jg output: the real 'Jevgrep: N relevant files.' header counts as N files and the search is not a fallback", async () => {
  const r = await runJg({ query: "q", root: root(), ...answer(REAL) });
  assert.equal(r.row.filesReturned, 147);
  assert.equal(r.row.fallback, false);
  assert.equal(r.stdout, REAL);
});

test("[97] jg output: the header jg prints when discovery was incomplete ('...files; discovery incomplete.') still counts", async () => {
  const r = await runJg({ query: "q", root: root(), ...answer("Jevgrep: 3 relevant files; discovery incomplete.\nEnd context.\n") });
  assert.equal(r.row.filesReturned, 3);
});

test("[97] jg output: 'Jevgrep: 0 relevant files.' is still no-files", async () => {
  const r = await runJg({ query: "q", root: root(), ...answer("Jevgrep: 0 relevant files.\nEnd context.\n") });
  assert.equal(r.row.reason, "no-files");
  assert.equal(r.stdout, undefined);
});

test("[97] jg output: '## <path>' headers still count", async () => {
  const r = await runJg({ query: "q", root: root(), ...answer("## a.mjs\nx\n## b.mjs\ny\nEnd context.\n") });
  assert.equal(r.row.filesReturned, 2);
});

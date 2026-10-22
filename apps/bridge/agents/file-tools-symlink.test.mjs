// hardening/01 addendum (user, 2026-10-22): fileToolRefusal is lexical, so a symlink inside the worktree that resolves outside it
// gets a file tool out. The rule must judge where the path really leads: a symlink (or a path under a symlinked directory) that
// resolves outside the worktree is refused for Read, Write and Edit; one that resolves inside stays allowed; a path that does not
// exist yet (a Write of a new file) is judged by its nearest existing parent, so it stays allowed in the worktree and is refused
// under a symlinked directory that leads out. A dangling symlink is refused: writing through it creates a file outside.
// Units at fileToolRefusal (the pure rule), and one end-to-end case through the host's permission answer.
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileToolRefusal } from "./claude-adapter.mjs";
import { makeBridge, until } from "./host-test-helpers.mjs";

let base, wt, outside, grant;
const at = (...p) => path.join(wt, ...p);
before(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "den-symlink-")));
  wt = path.join(base, "wt");
  outside = path.join(base, "outside");
  grant = path.join(base, "grant");
  for (const d of [at("src"), path.join(outside, "dir"), grant]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  writeFileSync(path.join(outside, "dir", "other.txt"), "other");
  writeFileSync(at("src", "real.txt"), "real");
  symlinkSync(path.join(outside, "secret.txt"), at("out-file"));
  symlinkSync("../outside/secret.txt", at("rel-out"));
  symlinkSync(at("hop2"), at("hop1"));
  symlinkSync(path.join(outside, "secret.txt"), at("hop2"));
  symlinkSync(path.join(outside, "dir"), at("out-dir"));
  symlinkSync(path.join(outside, "not-yet.txt"), at("dangling"));
  symlinkSync(at("src", "real.txt"), at("src", "in-link"));
  symlinkSync(at("src"), at("in-dir-link"));
  symlinkSync(wt, path.join(base, "wt-alias"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(grant, "escape"));
});
after(() => rmSync(base, { recursive: true, force: true }));

const refusal = (tool, file, extra = {}) => fileToolRefusal({ tool, input: { file_path: file }, worktree: wt, ...extra });

describe("a symlink that leaves the worktree is refused for Read, Write and Edit", () => {
  for (const tool of ["Read", "Write", "Edit"]) {
    test(`${tool}: a file link, a relative link, a chain of links, a link to a directory and a dangling link`, () => {
      const cases = {
        "a symlink to a file outside": at("out-file"),
        "a relative symlink that climbs out": at("rel-out"),
        "a chain of symlinks that ends outside": at("hop1"),
        "an existing file under a symlinked directory": at("out-dir", "other.txt"),
        "a new file under a symlinked directory": at("out-dir", "new.txt"),
        "a dangling symlink to a new outside path": at("dangling"),
      };
      for (const [what, file] of Object.entries(cases)) {
        const why = refusal(tool, file);
        assert.equal(typeof why, "string", `${tool} on ${what} must be refused`);
        assert.match(why, /outside/i, what);
      }
    });

    test(`${tool}: a link that resolves inside the worktree, a real file and a not-yet-existing path stay allowed`, () => {
      for (const file of [at("src", "in-link"), at("in-dir-link", "real.txt"), at("src", "real.txt"), at("src", "new.txt"), at("in-dir-link", "new.txt"), at("new", "deeper", "file.txt")]) {
        assert.equal(refusal(tool, file), null, `${tool} on ${file} must be allowed`);
      }
    });
  }

  test("a worktree reached through a symlinked path still allows its own files (a /tmp that is a link)", () => {
    const alias = path.join(base, "wt-alias");
    for (const tool of ["Read", "Write", "Edit"]) {
      assert.equal(fileToolRefusal({ tool, input: { file_path: path.join(alias, "src", "real.txt") }, worktree: alias }), null);
      assert.equal(fileToolRefusal({ tool, input: { file_path: path.join(alias, "src", "new.txt") }, worktree: alias }), null);
    }
  });

  test("inside a granted path the same holds: a link that leads out is refused, a plain file is not", () => {
    assert.match(refusal("Write", path.join(grant, "escape"), { grantPaths: [grant] }) ?? "", /outside/i);
    assert.equal(refusal("Write", path.join(grant, "ok.txt"), { grantPaths: [grant] }), null);
  });
});

describe("the host answers deny for a symlink out of the worktree (end to end)", () => {
  let t;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  test("Write through a symlinked directory in the agent's worktree is denied at once and never held for the user", async () => {
    t = await makeBridge();
    assert.equal((await t.post("/tasks", { role: "developer", text: "Tidy the notes." })).status, 201);
    const rec = t.fake.spawns[0];
    mkdirSync(rec.args.cwd, { recursive: true });
    symlinkSync(outside, path.join(rec.args.cwd, "escape"));
    rec.emit({ type: "permission-request", requestId: "sym-1", tool: "Write", input: { file_path: path.join(rec.args.cwd, "escape", "new.txt"), content: "x" } });
    const decision = await until(() => rec.decisions.find((d) => d.requestId === "sym-1"), { what: "the host's answer" });
    assert.equal(decision.allow, false);
    assert.match(decision.reason ?? "", /outside/i);
    assert.deepEqual(((await t.state()).approvals ?? []).filter((a) => a.state === "pending"), []);
  });
});

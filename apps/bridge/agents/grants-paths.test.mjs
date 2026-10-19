// agent-os/02, the two path-grant gaps the user ordered fixed here (orchestrator comment 2026-10-11), plus the read limit's ticket Read.
//
//   1. A path grant that contains the worktree (the main checkout, its .claude, its worktrees directory, or a home grant that
//      reaches them) is a 400 from POST /tasks, before a ticket is written, not a 502 at spawn. compileCeiling still throws.
//   2. A path grant inside the main checkout is covered by the governance denies: forbid beats permit. compileCeiling takes
//      the main checkout's path as `root`, and the compiled rules deny the governed paths the grant reaches, in absolute form
//      (Write/Edit rules and sandbox.filesystem.denyWrite). Security's CI-path exception applies in its worktree only.
//   3. A host grant's read limit keeps the agent's own ticket file readable (permissions.additionalDirectories).
import assert from "node:assert/strict";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { buildClaudeArgs, compileCeiling } from "./claude-adapter.mjs";
import { makeBridge } from "./host-test-helpers.mjs";
import { DEN_FEATURE } from "./policy.mjs";

const SID = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const ROOT = "/work/den";
const WT = `${ROOT}/.claude/worktrees/den-fx-01-abcd1234`;
const TEXT = "Fetch the package index and note which versions changed.";
const settingsOf = (opts) => {
  const argv = buildClaudeArgs({ sessionId: SID, agent: opts.agent ?? "developer", ...opts.compiled });
  return JSON.parse(argv[argv.indexOf("--settings") + 1]);
};
const compile = (role, grants, extra = {}) => compileCeiling(role, { worktree: WT, root: ROOT, grants, ...extra });
const path_ = (value) => ({ kind: "path", value });
const denyOf = (role, grants) => {
  const compiled = compile(role, grants);
  const s = settingsOf({ agent: role, compiled });
  return { deny: s.permissions.deny, denyWrite: s.sandbox.filesystem.denyWrite ?? [] };
};

describe("a path grant inside the main checkout meets the governance denies", () => {
  test("a grant on a governed directory is denied for Write, Edit and shell writes", () => {
    const { deny, denyWrite } = denyOf("developer", [path_(`${ROOT}/.github/workflows`)]);
    assert.ok(deny.includes(`Write(/${ROOT}/.github/workflows/**)`), JSON.stringify(deny));
    assert.ok(deny.includes(`Edit(/${ROOT}/.github/workflows/**)`));
    assert.ok(denyWrite.includes(`${ROOT}/.github/workflows`), JSON.stringify(denyWrite));
  });

  test("a grant under a governed directory is denied at the grant", () => {
    const { deny, denyWrite } = denyOf("developer", [path_(`${ROOT}/.github/workflows/sub`)]);
    assert.ok(deny.includes(`Write(/${ROOT}/.github/workflows/sub/**)`), JSON.stringify(deny));
    assert.ok(denyWrite.includes(`${ROOT}/.github/workflows/sub`));
  });

  test("a grant above a governed file denies that file", () => {
    const { deny, denyWrite } = denyOf("developer", [path_(`${ROOT}/apps/bridge`)]);
    assert.ok(deny.includes(`Write(/${ROOT}/apps/bridge/agents/ceilings.json)`), JSON.stringify(deny));
    assert.ok(deny.includes(`Edit(/${ROOT}/apps/bridge/agents/governance.json)`));
    assert.ok(denyWrite.includes(`${ROOT}/apps/bridge/agents/ceilings.json`));
  });

  test("a governed file named as the grant is denied", () => {
    const { deny } = denyOf("developer", [path_(`${ROOT}/Jenkinsfile`)]);
    assert.ok(deny.includes(`Write(/${ROOT}/Jenkinsfile)`), JSON.stringify(deny));
  });

  test("security's CI-path exception does not reach the main checkout", () => {
    const { deny } = denyOf("security", [path_(`${ROOT}/.github/workflows`)]);
    assert.ok(deny.includes(`Write(/${ROOT}/.github/workflows/**)`), JSON.stringify(deny));
  });

  test("the guardrail paths of the main checkout are denied under a grant that reaches them, for every role that takes grants", () => {
    for (const role of ["developer", "qa", "security"]) {
      const { deny } = denyOf(role, [path_(`${ROOT}/apps`)]);
      assert.ok(deny.includes(`Write(/${ROOT}/apps/bridge/agents/governance.json)`), role);
    }
  });

  test("a grant that reaches no governed path adds no main-checkout deny", () => {
    const { deny, denyWrite } = denyOf("developer", [path_(`${ROOT}/docs/notes`), path_("/srv/shared")]);
    assert.equal(deny.some((r) => r.includes(`/${ROOT}`) && !r.includes(WT)), false, JSON.stringify(deny));
    assert.equal(denyWrite.some((p) => p.startsWith(ROOT) && !p.startsWith(WT)), false);
  });

  test("a grant inside the agent's own worktree adds no main-checkout deny", () => {
    const { deny } = denyOf("developer", [path_(`${WT}/src`)]);
    assert.equal(deny.some((r) => r.includes(`/${ROOT}/`) && !r.includes(WT)), false, JSON.stringify(deny));
  });

  test("a grant in a sibling worktree is denied at the grant, and the agent's own worktree stays writable", () => {
    const sibling = `${ROOT}/.claude/worktrees/den-other-02-ffff0000`;
    const s = settingsOf({ compiled: compile("developer", [path_(sibling)]) });
    assert.ok(s.permissions.deny.includes(`Write(/${sibling}/**)`), JSON.stringify(s.permissions.deny));
    assert.equal(s.permissions.deny.includes(`Write(/${ROOT}/.claude/**)`), false, "the whole .claude tree would deny the agent's own worktree");
    assert.ok(s.permissions.allow.includes(`Write(/${WT}/**)`));
  });

  test("without a root the compile is as before (no main-checkout denies)", () => {
    const compiled = compileCeiling("developer", { worktree: WT, grants: [path_(`${ROOT}/.github/workflows`)] });
    assert.equal(compiled.denyAbs, undefined);
  });
});

// agent-os/02, user decision 2026-10-11 after qa verify bounce 1: the main checkout's .git is never grantable. It is a governed
// path (governance.json guardrailPaths), so a grant naming it or anything under it meets the deny and forbid beats permit.
describe("the main checkout's .git is never grantable", () => {
  for (const [name, p, denied] of [
    ["the .git directory", `${ROOT}/.git`, `${ROOT}/.git`],
    ["its config file", `${ROOT}/.git/config`, `${ROOT}/.git/config`],
    ["its hooks directory", `${ROOT}/.git/hooks`, `${ROOT}/.git/hooks`],
    ["a worktree admin directory", `${ROOT}/.git/worktrees/den-fx-01-abcd1234`, `${ROOT}/.git/worktrees/den-fx-01-abcd1234`],
  ]) {
    for (const role of ["developer", "qa", "security"]) {
      test(`${role}: a grant on ${name} is denied for Write, Edit and shell writes`, () => {
        const { deny, denyWrite } = denyOf(role, [path_(p)]);
        assert.ok(deny.includes(`Write(/${denied}/**)`), JSON.stringify(deny));
        assert.ok(deny.includes(`Edit(/${denied}/**)`), JSON.stringify(deny));
        assert.ok(denyWrite.includes(denied), JSON.stringify(denyWrite));
      });
    }
  }

  test("a grant above .git cannot be made without containing the worktree, so it is a TypeError", () => {
    assert.throws(() => compile("developer", [path_(ROOT)]), TypeError);
  });

  test("a grant on .gitignore is not caught by the .git deny", () => {
    const { deny } = denyOf("developer", [path_(`${ROOT}/.gitignore`)]);
    assert.equal(deny.some((r) => r.includes(`/${ROOT}/`) && !r.includes(WT)), false, JSON.stringify(deny));
  });

  test("with no grant, the ceiling denies .git writes under the worktree too", () => {
    const s = settingsOf({ compiled: compile("developer", []) });
    assert.ok(s.permissions.deny.includes("Write(.git/**)"), JSON.stringify(s.permissions.deny));
    assert.ok(s.permissions.deny.includes("Edit(.git/**)"));
    assert.ok(s.sandbox.filesystem.denyWrite.includes(`${WT}/.git`), JSON.stringify(s.sandbox.filesystem.denyWrite));
  });
});

describe("a path grant that contains the worktree", () => {
  const reaching = [
    ["the main checkout", ROOT],
    ["its .claude directory", `${ROOT}/.claude`],
    ["the worktrees directory", `${ROOT}/.claude/worktrees`],
    ["a parent of the main checkout", "/work"],
  ];
  for (const [name, p] of reaching) {
    test(`${name} is a TypeError from compileCeiling`, () => {
      assert.throws(() => compile("developer", [path_(p)]), TypeError);
    });
  }

  test("a ~/ grant that reaches the worktree is a TypeError when home is known", () => {
    assert.throws(() => compileCeiling("developer", { worktree: "/home/u/den/.claude/worktrees/w-1", root: "/home/u/den", home: "/home/u", grants: [path_("~/den")] }), TypeError);
    assert.throws(() => compileCeiling("developer", { worktree: "/home/u/den/.claude/worktrees/w-1", root: "/home/u/den", home: "/home/u", grants: [path_("~/den/.claude")] }), TypeError);
  });

  test("a ~/ grant elsewhere in home is fine", () => {
    const c = compileCeiling("developer", { worktree: "/home/u/den/.claude/worktrees/w-1", root: "/home/u/den", home: "/home/u", grants: [path_("~/notes")] });
    assert.deepEqual(c.writePaths, ["~/notes"]);
  });
});

describe("the read limit keeps the ticket file readable", () => {
  const TICKET = "/work/den/.scratch/den/issues/01-task.md";
  test("a host grant adds the ticket's directory as an additional directory", () => {
    const compiled = compile("developer", [{ kind: "host", value: "api.example.com" }]);
    const s = settingsOf({ compiled: { ...compiled, ticketFile: TICKET } });
    assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.deepEqual(s.permissions.additionalDirectories, ["/work/den/.scratch/den/issues"]);
    assert.ok(s.permissions.allow.includes(`Read(/${TICKET})`));
  });

  test("with no read limit there is no additional directory", () => {
    const s = settingsOf({ compiled: { ...compile("developer", []), ticketFile: TICKET } });
    assert.equal(s.permissions.additionalDirectories, undefined);
  });
});

describe("POST /tasks refuses a path grant that contains the worktree", () => {
  let t;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });
  const tickets = async () => (await readdir(path.join(t.fx.root, ".scratch", DEN_FEATURE, "issues")).catch(() => [])).filter((n) => n.endsWith(".md"));
  const reaching = (root) => [
    ["the main checkout", root],
    ["its .claude directory", path.join(root, ".claude")],
    ["the worktrees directory", path.join(root, ".claude", "worktrees")],
    ["a parent of the main checkout", path.dirname(root)],
  ];
  for (const [i, name] of ["the main checkout", "its .claude directory", "the worktrees directory", "a parent of the main checkout"].entries()) {
    test(`${name} is a 400, nothing written, nothing spawned`, async () => {
      t = await makeBridge();
      const value = reaching(t.fx.root)[i][1];
      const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: [{ kind: "path", value }] });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.body.error.includes(value), false, "the error does not echo the path");
      assert.deepEqual(await tickets(), []);
      assert.equal(t.fake.spawns.length, 0);
    });
  }

  test("a path grant inside the main checkout is allowed and reaches the runtime with the root", async () => {
    t = await makeBridge();
    const value = path.join(t.fx.root, "docs", "notes");
    const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: [{ kind: "path", value }] });
    assert.equal(res.status, 201, res.text);
    assert.equal(t.fake.spawns[0].args.root, await realpath(t.fx.root));
  });

  test("a path grant elsewhere is allowed", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: [{ kind: "path", value: "/srv/shared/data" }] });
    assert.equal(res.status, 201, res.text);
  });
});

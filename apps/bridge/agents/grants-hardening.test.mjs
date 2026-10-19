// agent-os/07 (ADR 0021): grant hardening. A path grant that could never be safe is a 400 from POST /tasks, with a reason the
// Start box can show, before a ticket is written or an agent spawned. The deny rules of agent-os/02 stay as the second layer
// (grants-paths.test.mjs and grants.test.mjs are unchanged and still cover a grant that reaches the adapter by another route).
//
//   1. A path grant on a governed path of the main checkout, or under one, is a 400 (user, 2026-10-11).
//   2. A path grant on a home or system path of security's list (02-security finding 1) is a 400, a test per entry.
//   3. A bare `.git` guardrail entry covers the worktree's `.git` pointer file (compiled Write and Edit rules).
//   4. The low findings: `.GIT` casing, a symlink to the main checkout, GitHub hosts. The ticket-directory read (finding 6) is
//      fix-or-record for the developer and has no test here.
//   Human-verified, not tested here: the live `.git/refs`, `HEAD` and `git update-ref` probe, and the live Write-tool check of
//   `<worktree>/.git` (both are recorded on the ticket by the developer).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { buildClaudeArgs, compileCeiling } from "./claude-adapter.mjs";
import { makeBridge } from "./host-test-helpers.mjs";
import { DEN_FEATURE } from "./policy.mjs";

const SID = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const ROOT = "/work/den";
const WT = `${ROOT}/.claude/worktrees/den-fx-01-abcd1234`;
const TEXT = "Fetch the package index and note which versions changed.";
const ROLES = ["developer", "qa", "security"];
const path_ = (value) => ({ kind: "path", value });
const host_ = (value) => ({ kind: "host", value });

let t;
const cleanups = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  while (cleanups.length > 0) await cleanups.pop()();
});
const tickets = async () => (await readdir(path.join(t.fx.root, ".scratch", DEN_FEATURE, "issues")).catch(() => [])).filter((n) => n.endsWith(".md"));

// One refused grant: 400, a reason that does not echo the grant, nothing written, nothing spawned.
async function assertRefused(role, grants) {
  const res = await t.post("/tasks", { role, text: TEXT, grants });
  assert.equal(res.status, 400, res.text);
  assert.equal(typeof res.body.error, "string");
  assert.ok(res.body.error.length > 0, "a reason the Start box can show");
  for (const g of grants) assert.equal(res.body.error.includes(g.value), false, "the error does not echo the grant");
  assert.deepEqual(await tickets(), [], "no ticket");
  assert.equal(t.fake.spawns.length, 0, "no agent");
}

describe("POST /tasks refuses a path grant on a governed path of the main checkout", () => {
  // Test-local literals (independent of governance.json): the guardrail and CI paths, and paths under each.
  const GOVERNED = [
    [".git", ".git"],
    ["a file under .git", ".git/config"],
    ["the hooks directory of .git", ".git/hooks"],
    ["the refs of .git", ".git/refs/heads"],
    ["a worktree admin directory", ".git/worktrees/den-fx-01-abcd1234"],
    ["a file under .claude", ".claude/settings.json"],
    ["a role definition", ".claude/agents/developer.md"],
    ["the agents directory", ".claude/agents"],
    ["a sibling worktree", ".claude/worktrees/den-other-02-ffff0000"],
    ["ceilings.json", "apps/bridge/agents/ceilings.json"],
    ["governance.json", "apps/bridge/agents/governance.json"],
    ["the CI workflows directory", ".github/workflows"],
    ["a workflow file", ".github/workflows/ci.yml"],
    ["a directory under the workflows", ".github/workflows/sub"],
    ["CODEOWNERS", ".github/CODEOWNERS"],
    [".gitlab-ci.yml", ".gitlab-ci.yml"],
    ["Jenkinsfile", "Jenkinsfile"],
  ];
  for (const role of ROLES) {
    for (const [name, rel] of GOVERNED) {
      test(`${role}: ${name} is a 400, nothing written, nothing spawned`, async () => {
        t = await makeBridge();
        await assertRefused(role, [path_(path.join(t.fx.root, rel))]);
      });
    }
  }

  test("the resolved (realpath) form of the main checkout's .git is a 400 too", async () => {
    t = await makeBridge();
    await assertRefused("developer", [path_(path.join(await realpath(t.fx.root), ".git", "refs"))]);
  });

  test("one governed grant among good ones refuses the whole task", async () => {
    t = await makeBridge();
    await assertRefused("developer", [path_("/srv/shared/data"), host_("api.example.com"), path_(path.join(t.fx.root, ".git", "config"))]);
  });

  test("a grant on .gitignore or a docs path is not caught by the governed list", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: [path_(path.join(t.fx.root, ".gitignore")), path_(path.join(t.fx.root, "docs", "notes"))] });
    assert.equal(res.status, 201, res.text);
  });
});

describe("POST /tasks refuses a path grant on a home or system path (security's list, 02-security finding 1)", () => {
  // `~/.git*` is the glob: ~/.gitconfig and ~/.git-credentials are as bad as ~/.git. A shell rc file is a write that runs on the
  // user's next login. Each entry, and a path under it, is refused in `~/` form and (when the home path is plain) absolute form.
  const HOME_ENTRIES = [
    "~/.ssh", "~/.ssh/authorized_keys", "~/.ssh/config",
    "~/.claude", "~/.claude/settings.json", "~/.claude/hooks",
    "~/.config", "~/.config/git/config", "~/.config/systemd/user",
    "~/.local", "~/.local/bin", "~/.local/share/applications",
    "~/.git", "~/.gitconfig", "~/.git-credentials",
    "~/.bashrc", "~/.profile", "~/.zshrc", "~/.zshenv", "~/.zprofile", "~/.zlogin",
  ];
  const SYSTEM_ENTRIES = ["/etc", "/etc/passwd", "/etc/cron.d", "/etc/sudoers.d", "/usr", "/usr/bin", "/usr/local/bin", "/usr/share/applications"];

  for (const value of [...HOME_ENTRIES, ...SYSTEM_ENTRIES]) {
    for (const role of ROLES) {
      test(`${role}: ${value} is a 400`, async () => {
        t = await makeBridge();
        await assertRefused(role, [path_(value)]);
      });
    }
  }

  const home = homedir();
  const plainHome = /^(?:\/[A-Za-z0-9._@+-]+)+$/.test(home);
  for (const rel of HOME_ENTRIES) {
    test(`the absolute home form of ${rel} is a 400`, { skip: !plainHome && "home is not a plain path" }, async () => {
      t = await makeBridge();
      await assertRefused("developer", [path_(`${home}${rel.slice(1)}`)]);
    });
  }

  test("a refused entry among otherwise good grants refuses the whole task", async () => {
    t = await makeBridge();
    await assertRefused("developer", [path_("/srv/shared/data"), path_("~/.ssh/config")]);
  });

  // Names that start like a refused one but are not it stay grantable: the refusal is by path segment, not by string prefix.
  for (const value of ["~/notes", "~/projects/x", "/srv/shared/data", "/etcetera/x", "/usrlocal/x", "/var/tmp/work"]) {
    test(`${value} is still allowed`, async () => {
      t = await makeBridge();
      const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: [path_(value)] });
      assert.equal(res.status, 201, res.text);
    });
  }
});

describe("the deny rules of agent-os/02 stay as the second layer", () => {
  // A governed-path grant that reaches compileCeiling by another route (no POST check) still compiles to denies and is not lifted.
  test("compileCeiling still denies a governed grant instead of throwing", () => {
    const compiled = compileCeiling("developer", { worktree: WT, root: ROOT, grants: [path_(`${ROOT}/.git/config`), path_(`${ROOT}/.github/workflows`)] });
    assert.ok(compiled.denyAbs.includes(`${ROOT}/.git/config/**`), JSON.stringify(compiled.denyAbs));
    assert.ok(compiled.denyAbs.includes(`${ROOT}/.github/workflows/**`), JSON.stringify(compiled.denyAbs));
  });
});

describe("a bare .git entry covers the worktree's .git pointer file", () => {
  const settingsOf = (compiled) => {
    const argv = buildClaudeArgs({ sessionId: SID, agent: "developer", ...compiled });
    return JSON.parse(argv[argv.indexOf("--settings") + 1]);
  };
  test("Write and Edit deny the .git file itself, not only its children", () => {
    const s = settingsOf(compileCeiling("developer", { worktree: WT, root: ROOT, grants: [] }));
    assert.ok(s.permissions.deny.includes("Write(.git)"), JSON.stringify(s.permissions.deny));
    assert.ok(s.permissions.deny.includes("Edit(.git)"), JSON.stringify(s.permissions.deny));
  });

  test("the children rules and the shell-write deny stay", () => {
    const s = settingsOf(compileCeiling("developer", { worktree: WT, root: ROOT, grants: [] }));
    assert.ok(s.permissions.deny.includes("Write(.git/**)"));
    assert.ok(s.permissions.deny.includes("Edit(.git/**)"));
    assert.ok(s.sandbox.filesystem.denyWrite.includes(`${WT}/.git`), JSON.stringify(s.sandbox.filesystem.denyWrite));
  });

  test("every role that takes grants gets the bare .git deny", () => {
    for (const role of ROLES) {
      const s = settingsOf(compileCeiling(role, { worktree: WT, root: ROOT, grants: [] }));
      assert.ok(s.permissions.deny.includes("Write(.git)"), role);
    }
  });
});

describe("low finding: .GIT casing (macOS volumes are case-insensitive)", () => {
  for (const [name, rel] of [[".GIT", ".GIT"], ["a mixed-case .Git config", ".Git/config"], ["a mixed-case .Claude", ".Claude/agents"], ["a mixed-case workflows", ".GitHub/Workflows"], ["JENKINSFILE", "JENKINSFILE"]]) {
    test(`POST /tasks: ${name} is a 400`, async () => {
      t = await makeBridge();
      await assertRefused("developer", [path_(path.join(t.fx.root, rel))]);
    });
  }

  test("compileCeiling does not accept a .GIT grant with no deny", () => {
    let compiled;
    try {
      compiled = compileCeiling("developer", { worktree: WT, root: ROOT, grants: [path_(`${ROOT}/.GIT/config`)] });
    } catch (e) {
      assert.ok(e instanceof TypeError, "a refusal is a TypeError");
      return;
    }
    const denies = (compiled.denyAbs ?? []).map((p) => p.toLowerCase());
    assert.ok(denies.some((p) => p.startsWith(`${ROOT}/.git`)), `a deny for the .GIT grant: ${JSON.stringify(compiled.denyAbs)}`);
  });
});

describe("low finding: a symlink to the main checkout is seen", () => {
  async function linkTo(target, name = "link") {
    const dir = await mkdtemp(path.join(tmpdir(), "den-grant-link-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const link = path.join(dir, name);
    await symlink(target, link);
    return link;
  }

  test("a symlink to the main checkout is a 400", async () => {
    t = await makeBridge();
    await assertRefused("developer", [path_(await linkTo(t.fx.root))]);
  });

  test("a symlink to the main checkout's .git is a 400", async () => {
    t = await makeBridge();
    await assertRefused("developer", [path_(await linkTo(path.join(t.fx.root, ".git")))]);
  });

  test("a path under a symlink to the main checkout that reaches .git is a 400, even where the target does not exist yet", async () => {
    t = await makeBridge();
    const link = await linkTo(t.fx.root);
    await assertRefused("developer", [path_(`${link}/.git/refs/heads`)]);
  });

  test("a symlink to a governed directory is a 400", async () => {
    t = await makeBridge();
    const wf = path.join(t.fx.root, ".github", "workflows");
    await mkdir(wf, { recursive: true });
    await assertRefused("developer", [path_(await linkTo(wf))]);
  });

  test("a symlink to a home path of the refused list is a 400", async () => {
    t = await makeBridge();
    await assertRefused("developer", [path_(await linkTo(homedir()))]);
  });

  test("a symlink to an ordinary directory is still allowed", async () => {
    t = await makeBridge();
    const other = await mkdtemp(path.join(tmpdir(), "den-grant-other-"));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: [path_(await linkTo(other))] });
    assert.equal(res.status, 201, res.text);
  });
});

describe("low finding: GitHub hosts are not grantable yet (the wall is the boundary; Bash rules do not parse quoting)", () => {
  for (const host of ["github.com", "api.github.com", "uploads.github.com", "gist.github.com"]) {
    test(`a host grant on ${host} is a 400`, async () => {
      t = await makeBridge();
      await assertRefused("developer", [host_(host)]);
    });
  }

  test("a GitHub host among good grants refuses the whole task", async () => {
    t = await makeBridge();
    await assertRefused("security", [host_("api.example.com"), host_("api.github.com")]);
  });

  test("a host that merely contains the name is still allowed", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: [host_("notgithub.example.com")] });
    assert.equal(res.status, 201, res.text);
  });
});

// agent-os/04 (ADR 0021 decisions 2 to 5): the role ceilings, and how the adapter compiles one into the inline settings.
//
// PINNED INTERFACE (what these tests hold the developer to; anything not named here is the developer's to choose):
//   apps/bridge/agents/ceilings.json     one data file, a JSON object keyed by role name. Exactly four keys: scout, developer,
//                                       qa, security. A role with no key (designer, architect, product, herald, orchestrator)
//                                       has no ceiling. The shape of each value is the developer's.
//   compileCeiling(role, { worktree })  exported from ./claude-adapter.mjs, pure. Returns null (or undefined) for a role with
//                                       no ceiling; otherwise an options object that, spread into buildClaudeArgs, gives
//                                       the recorded settings. The option names it returns are not pinned: these tests only
//                                       compose  buildClaudeArgs({ sessionId, agent, ...compileCeiling(agent, { worktree }) }).
//   buildClaudeArgs                     unchanged for every call that does not spread a ceiling in (the agent-os/01 tests
//                                       in claude-adapter.test.mjs keep passing).
//
// The recorded settings (ADR 0021 amendment 1, and the spike's finding that Write in the worktree still asks):
//   - sandbox: the wall block with an EMPTY host list, for every role with a ceiling (no role has a host yet)
//   - permissions.deny: the four deny rules stay, so git push and gh pr create are still refused with the wall on
//   - permissions.allow: Bash for every role with the wall on (den-mvp/27: every shell command is sandboxed and an
//     unsandboxed one is refused, so a Bash request protects nothing; the deny rules and the sandbox do the refusing),
//     plus Write and Edit inside the worktree for the roles that write (developer, qa, security); none for scout. Rules use the adapter's absolute-path form, the same as the ticket Read rule: `Write(/${worktree}/**)`.
//   - a worktree the adapter cannot write as a rule (not plain absolute segments) is a TypeError.
// Expected values below are hand-written literals, never computed with the code under test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ROLES } from "./policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const adapter = await import("./claude-adapter.mjs").catch(() => ({}));
const need = (name) => {
  assert.equal(typeof adapter[name], "function", `claude-adapter.mjs must export the function ${name}`);
  return adapter[name];
};

const SID = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const WT = "/work/den/.claude/worktrees/den-fx-01-abcd1234";
const TICKET = "/work/den/.scratch/fx/issues/01-thing.md";
const DENY = ["Write(.claude/**)", "Edit(.claude/**)", "Bash(git push:*)", "Bash(gh pr create:*)"];
const WALL_NO_HOSTS = {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  network: { allowedDomains: [], strictAllowlist: true },
};
// den-mvp outcome 1: every role has a ceiling. Bao (the chief of staff and its desk key) writes nothing; the rest write in their worktree.
// team-and-den-ux/02 (ADR 0029) adds code-reviewer, release-manager, sre and technical-writer, each writing only in its worktree.
const WRITERS = ["architect", "code-reviewer", "designer", "developer", "product", "qa", "release-manager", "security", "sre", "technical-writer"];
const CEILING_ROLES = ["architect", "chief-of-staff", "code-reviewer", "designer", "developer", "orchestrator", "product", "qa", "release-manager", "security", "sre", "technical-writer"];
const NO_WRITE_ROLES = ["chief-of-staff", "orchestrator"];

const argvFor = (agent, extra = {}, worktree = WT) =>
  need("buildClaudeArgs")({ sessionId: SID, agent, ...(need("compileCeiling")(agent, { worktree }) ?? {}), ...extra });
const settingsOf = (argv) => JSON.parse(argv[argv.indexOf("--settings") + 1]);
const sorted = (xs) => [...xs].sort();
const noFs = (sandbox) => ({ ...sandbox, filesystem: undefined });

describe("ceilings.json: one data file beside policy.mjs", () => {
  const ceilings = () => JSON.parse(readFileSync(path.join(HERE, "ceilings.json"), "utf8"));

  test("it gives every one of the fourteen roles a ceiling", () => {
    const data = ceilings();
    assert.ok(data !== null && typeof data === "object" && !Array.isArray(data), "a JSON object keyed by role");
    assert.deepEqual(Object.keys(data).sort(), CEILING_ROLES);
    for (const role of CEILING_ROLES) assert.ok(ROLES.includes(role), `${role} is a known role`);
    for (const role of CEILING_ROLES) assert.ok(data[role] !== null && typeof data[role] === "object" && !Array.isArray(data[role]), `${role} has an object`);
  });
});

describe("compileCeiling: the four ceilings", () => {
  for (const role of CEILING_ROLES) {
    test(`${role}: the wall is on with an empty host list, and the four deny rules stay`, () => {
      const settings = settingsOf(argvFor(role));
      assert.deepEqual(noFs(settings.sandbox), noFs(WALL_NO_HOSTS)); // agent-os/02: sandbox.filesystem (governance denyWrite) may now ride along
      for (const rule of DENY) assert.ok(settings.permissions.deny.includes(rule), `deny keeps ${rule}`);
    });
  }

  for (const role of WRITERS) {
    test(`${role}: Bash, and Write and Edit inside the worktree are allowed, and nothing else is`, () => {
      const settings = settingsOf(argvFor(role));
      assert.deepEqual(sorted(settings.permissions.allow), sorted(["Bash", `Write(/${WT}/**)`, `Edit(/${WT}/**)`]));
    });

    test(`${role}: the ticket Read rule stays beside the worktree rules`, () => {
      const settings = settingsOf(argvFor(role, { ticketFile: TICKET }));
      assert.deepEqual(sorted(settings.permissions.allow), sorted(["Bash", `Read(/${TICKET})`, `Write(/${WT}/**)`, `Edit(/${WT}/**)`]));
      assert.deepEqual(noFs(settings.sandbox), noFs(WALL_NO_HOSTS)); // agent-os/02: sandbox.filesystem (governance denyWrite) may now ride along
    });
  }

  test("chief-of-staff: no Write or Edit allow at all (read the project and the web, no write)", () => {
    const withTicket = settingsOf(argvFor("chief-of-staff", { ticketFile: TICKET }));
    assert.deepEqual(sorted(withTicket.permissions.allow), ["Bash", `Read(/${TICKET})`]);
    const bare = settingsOf(argvFor("chief-of-staff"));
    assert.deepEqual(bare.permissions.allow, ["Bash"]);
  });

  test("no ceiling adds a network host, a wildcard or a broader path than the worktree", () => {
    for (const role of CEILING_ROLES) {
      const settings = settingsOf(argvFor(role, { ticketFile: TICKET }));
      assert.deepEqual(settings.sandbox.network.allowedDomains, [], role);
      for (const rule of settings.permissions.allow ?? []) {
        assert.ok(rule === "Bash" || rule === `Read(/${TICKET})` || rule === `Write(/${WT}/**)` || rule === `Edit(/${WT}/**)`, `${role}: unexpected allow ${rule}`);
      }
    }
  });

  // den-mvp/27 (live probe 2026-10-14, real CLI, haiku): with the wall on, `cd <wt>/sub && cat > f <<'EOF'` and a heredoc into
  // $TMPDIR still raised a request although autoAllowBashIfSandboxed was set; allowing Bash ended them, while a write outside the
  // worktree stayed "Read-only file system" and git push and gh pr create stayed denied. Deny rules win over this allow.
  test("Bash is allowed outright only behind the wall, and every deny rule stays", () => {
    for (const role of CEILING_ROLES) {
      const settings = settingsOf(argvFor(role));
      assert.ok(settings.permissions.allow.includes("Bash"), role);
      assert.equal(settings.sandbox.allowUnsandboxedCommands, false, role);
      for (const rule of DENY) assert.ok(settings.permissions.deny.includes(rule), `${role} keeps ${rule}`);
    }
    const plain = settingsOf(need("buildClaudeArgs")({ sessionId: SID, agent: "developer" }));
    assert.ok(!(plain.permissions.allow ?? []).includes("Bash"), "without the wall a shell command stays a request");
  });

  test("the argv outside --settings is the plain template: the ceiling touches the settings value only", () => {
    for (const role of CEILING_ROLES) {
      const plain = need("buildClaudeArgs")({ sessionId: SID, agent: role });
      const walled = argvFor(role);
      const at = plain.indexOf("--settings");
      assert.deepEqual(walled.filter((_, i) => i !== at + 1), plain.filter((_, i) => i !== at + 1), role);
    }
  });

  test("a worktree the adapter cannot write as a plain rule is a TypeError, not a looser rule", () => {
    const bad = ["relative/path", "/work/../etc", "/work/./x", "/has space/wt", "/glob/*/wt", "/brace/{a,b}", "/paren/(x)", "/work/wt\n", "", "/", 42, null];
    for (const worktree of bad) {
      for (const role of WRITERS) {
        assert.throws(() => argvFor(role, {}, worktree), TypeError, `${role} with worktree ${JSON.stringify(worktree)}`);
      }
    }
  });
});

describe("compileCeiling: no role is left without a ceiling (den-mvp outcome 1)", () => {
  test("every known role compiles to a wall, and the two that write nothing get no Write or Edit allow", () => {
    assert.deepEqual(sorted(CEILING_ROLES), sorted(ROLES));
    assert.deepEqual(sorted([...WRITERS, ...NO_WRITE_ROLES]), sorted(ROLES));
    for (const role of ROLES) {
      const settings = settingsOf(argvFor(role, { ticketFile: TICKET }));
      assert.equal(settings.sandbox?.enabled, true, `${role} starts behind the wall`);
      assert.equal(settings.sandbox.failIfUnavailable, true, role);
    }
    for (const role of NO_WRITE_ROLES) {
      assert.deepEqual(settingsOf(argvFor(role, { ticketFile: TICKET })).permissions.allow, ["Bash", `Read(/${TICKET})`], role);
      assert.throws(() => need("compileCeiling")(role, { worktree: WT, grants: [{ kind: "host", value: "example.com" }] }), TypeError, `${role} takes no grants`);
    }
  });
});

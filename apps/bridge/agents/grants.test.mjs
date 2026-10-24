// agent-os/02 (ADR 0021 decisions 3 to 5, amendment 1; skill-sources Track C): task grants, the governance deny list,
// forbid-beats-permit, the bypass forms, and the host-name hardening, all at the adapter's pure seam.
//
// PINNED INTERFACE (anything not named here is the developer's to choose):
//   compileCeiling(role, { worktree, grants })   grants is an array of { kind: "host" | "path", value } (at most 6), the same
//                                                fixed shape POST /tasks takes. Anything outside the shape is a TypeError, never a
//                                                looser rule. chief-of-staff takes no grant at all (read-only role): any grant is a TypeError.
//   host grant   -> sandbox.network.allowedDomains = the ceiling's hosts plus the grant's (strictAllowlist stays), and a read
//                   limit: with at least one host the settings carry sandbox.filesystem.denyRead (non-empty) or
//                   permissions.blockReadsOutsideWorkingDirectories === true. No host without a read limit (security review of
//                   agent-os/01). With no host grant, the settings carry no read limit requirement (agent-os/04 tests stay true).
//   path grant   -> permissions.allow gains Write(//<path>/**) and Edit(//<path>/**) (the adapter's absolute form) and
//                   sandbox.filesystem.allowWrite contains the path. "~/x" paths are accepted and compile to a rule naming them.
//   governance   -> every ceiling role's compiled settings DENY (a) writes to the guardrail and CI paths below, both as
//                   Write/Edit rules in permissions.deny and as sandbox.filesystem.denyWrite entries (so a shell write is
//                   refused too), and (b) the governance commands below as Bash deny rules. buildClaudeArgs WITHOUT a ceiling is
//                   unchanged (claude-adapter.test.mjs keeps passing): governance rides only on compileCeiling's options.
//   forbid beats permit -> no grant lifts a deny. A grant that would is either a TypeError or leaves every deny in place.
//                   ONE stated exception (ticket: "Security may write CI paths only under a task grant"): for security alone,
//                   a path grant that covers a CI path lifts the deny on exactly the CI paths it covers, never a guardrail path.
//   buildClaudeArgs wall hosts: IP literals (any dotted-number form), localhost, localhost.* , *.localhost, and private or
//                   link-local names (.local .internal .lan .home.arpa) are a TypeError, and so is a sparse hosts array.
//
// The bypass-form check uses a reference matcher written HERE (see bashDenied). It reads a Bash deny rule `Bash(prefix:*)` as a
// prefix match and `Bash(a*b)` as a glob, and applies every deny rule to the WHOLE command string, the worst case where the CLI does
// not split on newlines, $(), backticks or <(). A rule set that refuses under that reading cannot be walked past by wrapping.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const adapter = await import("./claude-adapter.mjs").catch(() => ({}));
const need = (name) => {
  assert.equal(typeof adapter[name], "function", `claude-adapter.mjs must export the function ${name}`);
  return adapter[name];
};

const SID = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const WT = "/work/den/.claude/worktrees/den-fx-01-abcd1234";
const FOUR = ["Write(.claude/**)", "Edit(.claude/**)", "Bash(git push:*)", "Bash(gh pr create:*)"];
const ROLES_WITH_GRANTS = ["developer", "qa", "security"];
const CI_PATHS = [".github/workflows/ci.yml", ".github/workflows/sub/deploy.yaml", ".github/CODEOWNERS", ".gitlab-ci.yml", "Jenkinsfile"];
const GUARDRAIL_PATHS = ["apps/bridge/agents/ceilings.json", ".claude/settings.json", ".claude/agents/developer.md"];
const GOVERNANCE_COMMANDS = ["git push origin HEAD", "git push origin main", "gh pr create --fill", "gh pr review 12 --approve", "gh pr merge 12", "gh issue close 5", "gh release create v1.0"];

const compile = (role, grants, extra = {}) => need("compileCeiling")(role, { worktree: WT, ...(grants === undefined ? {} : { grants }), ...extra });
const argvFor = (role, grants) => need("buildClaudeArgs")({ sessionId: SID, agent: role, ...compile(role, grants) });
const settingsOf = (argv) => JSON.parse(argv[argv.indexOf("--settings") + 1]);
const settingsFor = (role, grants) => settingsOf(argvFor(role, grants));
const sorted = (xs) => [...xs].sort();

// ---- reference matchers (test-local, independent of the code under test) ----
const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
const pathGlob = (p) =>
  new RegExp(`^${esc(p).replace(/\*\*\//g, "\u0001").replace(/\*\*/g, "\u0002").replace(/\*/g, "[^/]*").replace(/\u0001/g, "(?:.*/)?").replace(/\u0002/g, ".*")}$`);
function bashDenied(deny, command) {
  return deny.some((rule) => {
    const m = /^Bash\((.*)\)$/s.exec(rule);
    if (!m) return false;
    const body = m[1];
    if (body.endsWith(":*") && !body.slice(0, -2).includes("*")) return command.startsWith(body.slice(0, -2));
    if (body.includes("*")) return new RegExp(`^${esc(body).replace(/\*/g, "[\\s\\S]*")}$`).test(command);
    return command === body;
  });
}
function fileDenied(settings, file) {
  const abs = `${WT}/${file}`;
  const byRule = (settings.permissions.deny ?? []).some((rule) => {
    const m = /^(?:Write|Edit)\((.*)\)$/s.exec(rule);
    if (!m) return false;
    return m[1].startsWith("//") ? pathGlob(m[1].slice(1)).test(abs) : pathGlob(m[1].replace(/^\.\//, "")).test(file);
  });
  const byFs = (settings.sandbox?.filesystem?.denyWrite ?? []).some((entry) => {
    const e = entry.replace(/\/\*\*$/, "").replace(/\/$/, "");
    return [file, abs].some((f) => f === e || f.startsWith(`${e}/`)) || pathGlob(e).test(file);
  });
  return byRule && byFs;
}
const writeToolDenied = (settings, file) => {
  const abs = `${WT}/${file}`;
  return ["Write", "Edit"].every((tool) =>
    (settings.permissions.deny ?? []).some((rule) => {
      const m = new RegExp(`^${tool}\\((.*)\\)$`, "s").exec(rule);
      return m && (m[1].startsWith("//") ? pathGlob(m[1].slice(1)).test(abs) : pathGlob(m[1].replace(/^\.\//, "")).test(file));
    }));
};

describe("task grants compile into the recorded settings", () => {
  test("a host grant joins the allow-list, keeps strictAllowlist, and brings a read limit", () => {
    for (const role of ROLES_WITH_GRANTS) {
      const s = settingsFor(role, [{ kind: "host", value: "registry.npmjs.org" }, { kind: "host", value: "api.example.com" }]);
      assert.deepEqual(sorted(s.sandbox.network.allowedDomains), ["api.example.com", "registry.npmjs.org"], role);
      assert.equal(s.sandbox.network.strictAllowlist, true, role);
      assert.equal(s.sandbox.enabled, true);
      assert.equal(s.sandbox.allowUnsandboxedCommands, false);
      const readLimit = (s.sandbox.filesystem?.denyRead ?? []).length > 0 || s.permissions.blockReadsOutsideWorkingDirectories === true;
      assert.ok(readLimit, `${role}: a host is listed only with a read limit in place`);
      for (const rule of FOUR) assert.ok(s.permissions.deny.includes(rule), `${role}: deny keeps ${rule}`);
    }
  });

  test("a repeated host is listed once", () => {
    const s = settingsFor("developer", [{ kind: "host", value: "api.example.com" }, { kind: "host", value: "api.example.com" }]);
    assert.deepEqual(s.sandbox.network.allowedDomains, ["api.example.com"]);
  });

  test("a path grant adds Write and Edit for that path, the sandbox allowWrite, and nothing else", () => {
    for (const role of ROLES_WITH_GRANTS) {
      const s = settingsFor(role, [{ kind: "path", value: "/srv/shared/data" }]);
      assert.deepEqual(sorted(s.permissions.allow), sorted(["Bash", `Write(/${WT}/**)`, `Edit(/${WT}/**)`, "Write(//srv/shared/data/**)", "Edit(//srv/shared/data/**)"]), role);
      assert.ok((s.sandbox.filesystem?.allowWrite ?? []).includes("/srv/shared/data"), `${role}: sandbox.filesystem.allowWrite names the path`);
      assert.deepEqual(s.sandbox.network.allowedDomains, [], `${role}: a path grant lists no host`);
    }
  });

  test("a ~/ path grant is accepted and the compiled rules name it", () => {
    const s = settingsFor("developer", [{ kind: "path", value: "~/notes/den" }]);
    assert.ok(JSON.stringify(s).includes("~/notes/den"));
  });

  test("no grant is the same as today's ceiling (no extra allow, host or read limit)", () => {
    for (const grants of [undefined, []]) {
      const s = settingsFor("developer", grants);
      assert.deepEqual(sorted(s.permissions.allow), sorted(["Bash", `Write(/${WT}/**)`, `Edit(/${WT}/**)`]));
      assert.deepEqual(s.sandbox.network.allowedDomains, []);
    }
  });

  test("a ceiling with no grants has no sandbox.filesystem.allowWrite (qa verify bounce 1, finding 2)", () => {
    for (const role of ["chief-of-staff", ...ROLES_WITH_GRANTS]) {
      for (const grants of role === "chief-of-staff" ? [undefined, []] : [undefined, [], [{ kind: "host", value: "registry.npmjs.org" }]]) {
        const s = settingsFor(role, grants);
        assert.equal(s.sandbox.filesystem?.allowWrite, undefined, `${role}: no allowWrite without a path grant`);
      }
    }
  });

  test("grants touch the settings value only: the rest of the argv is the plain template", () => {
    const plain = need("buildClaudeArgs")({ sessionId: SID, agent: "developer" });
    const walled = argvFor("developer", [{ kind: "host", value: "api.example.com" }, { kind: "path", value: "/srv/shared/data" }]);
    const at = plain.indexOf("--settings");
    assert.deepEqual(walled.filter((_, i) => i !== at + 1), plain.filter((_, i) => i !== at + 1));
    assert.equal(walled.filter((a) => a.includes("api.example.com") || a.includes("/srv/shared/data")).length, 1, "only the --settings value carries a grant");
  });

  test("chief-of-staff takes no grant: read-only means read-only", () => {
    for (const grant of [{ kind: "host", value: "api.example.com" }, { kind: "path", value: "/srv/shared/data" }]) {
      assert.throws(() => compile("chief-of-staff", [grant]), TypeError, JSON.stringify(grant));
    }
  });
});

describe("a grant outside the fixed shape is a TypeError, never a looser rule", () => {
  const HOST = (value) => [{ kind: "host", value }];
  const PATH = (value) => [{ kind: "path", value }];
  const badHosts = [
    "127.0.0.1", "127.1", "0x7f.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "localhost", "LOCALHOST", "localhost.localdomain", "foo.localhost",
    "printer.local", "db.internal", "metadata.google.internal", "router.lan", "nas.home.arpa", "https://example.com", "example.com:443", "example.com/path",
    "*.example.com", "exa mple.com", "example.com\n", "-x.example.com", "", "nodots", 42, null,
  ];
  for (const value of badHosts) test(`host ${JSON.stringify(value)}`, () => assert.throws(() => compile("developer", HOST(value)), TypeError));

  const badPaths = ["relative/dir", "./x", "../x", "/a/../b", "/a/./b", "~", "~/../x", "/", "/a/*", "/a/**", "/a/{b,c}", "/a b", "/a\n", "/a/(x)", "/a/[x]", "/a/?", "/a/!x", "", 7, null];
  for (const value of badPaths) test(`path ${JSON.stringify(value)}`, () => assert.throws(() => compile("developer", PATH(value)), TypeError));

  test("the list itself: not an array, sparse, a seventh grant, an extra key, an unknown kind, a non-object", () => {
    const sparse = [];
    sparse[2] = { kind: "host", value: "api.example.com" };
    const six = Array.from({ length: 6 }, (_, i) => ({ kind: "host", value: `h${i}.example.com` }));
    assert.doesNotThrow(() => compile("developer", six), "six is allowed");
    const bad = [
      "api.example.com", { kind: "host", value: "api.example.com" }, sparse, [...six, { kind: "host", value: "h6.example.com" }],
      [{ kind: "host", value: "api.example.com", flag: "--dangerously-skip-permissions" }], [{ kind: "url", value: "https://example.com" }], [{ kind: "host" }],
      ["api.example.com"], [null],
    ];
    for (const grants of bad) assert.throws(() => compile("developer", grants), TypeError, JSON.stringify(grants));
  });

  test("a hostile grant never reaches argv outside --settings, even if it somehow compiled", () => {
    for (const value of ["--dangerously-skip-permissions", "x.com --allow-dangerously-skip-permissions", "$(touch /tmp/x).com"]) {
      let argv;
      try { argv = argvFor("developer", HOST(value)); } catch (e) { assert.ok(e instanceof TypeError); continue; }
      assert.equal(argv.some((a) => a.includes("dangerously")), false);
    }
  });
});

describe("the wall's host list is names only (security review of agent-os/01)", () => {
  const wall = (hosts) => need("buildClaudeArgs")({ sessionId: SID, agent: "developer", wall: { hosts } });
  for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "0x7f.0.0.1", "localhost", "localhost.localdomain", "foo.localhost", "printer.local", "db.internal", "router.lan", "nas.home.arpa"]) {
    test(`buildClaudeArgs refuses ${host}`, () => assert.throws(() => wall([host]), TypeError));
  }
  test("a sparse hosts array is refused", () => {
    const sparse = [];
    sparse[2] = "api.example.com";
    assert.throws(() => wall(sparse), TypeError);
    assert.throws(() => wall(new Array(3)), TypeError);
  });
  test("plain names still pass", () => assert.doesNotThrow(() => wall(["registry.npmjs.org", "api.example.com"])));
});

describe("the ceilings deny the governance paths and commands (one test per entry)", () => {
  for (const role of ["developer", "qa", "chief-of-staff"]) {
    for (const file of [...CI_PATHS, ...GUARDRAIL_PATHS]) {
      test(`${role}: write to ${file} is denied (Write, Edit and a shell write)`, () => {
        const s = settingsFor(role);
        assert.ok(writeToolDenied(s, file), "Write and Edit deny rules");
        assert.ok(fileDenied(s, file), "and sandbox.filesystem.denyWrite");
      });
    }
  }
  for (const file of GUARDRAIL_PATHS) {
    test(`security: write to ${file} is denied`, () => assert.ok(fileDenied(settingsFor("security"), file)));
  }
  for (const file of CI_PATHS) {
    test(`security with no grant: write to ${file} is denied`, () => assert.ok(fileDenied(settingsFor("security"), file)));
  }
  for (const role of [...ROLES_WITH_GRANTS, "chief-of-staff"]) {
    for (const command of GOVERNANCE_COMMANDS) {
      test(`${role}: "${command}" is denied`, () => assert.ok(bashDenied(settingsFor(role).permissions.deny, command)));
    }
  }
  test("the four original deny rules stay beside the governance ones", () => {
    for (const role of [...ROLES_WITH_GRANTS, "chief-of-staff"]) for (const rule of FOUR) assert.ok(settingsFor(role).permissions.deny.includes(rule), `${role} ${rule}`);
  });
  test("a role with no ceiling is untouched: buildClaudeArgs alone still gives only the four deny rules", () => {
    const s = settingsOf(need("buildClaudeArgs")({ sessionId: SID, agent: "architect" }));
    assert.deepEqual(s.permissions.deny, FOUR);
  });
  test("security may write a CI path only under a task grant that covers it, and never a guardrail path", () => {
    const withGrant = settingsFor("security", [{ kind: "path", value: `${WT}/.github/workflows` }]);
    assert.equal(writeToolDenied(withGrant, ".github/workflows/ci.yml"), false, "the grant covers this CI path");
    assert.equal(fileDenied(withGrant, ".github/workflows/ci.yml"), false, "and the shell write too");
    for (const file of [".github/CODEOWNERS", ".gitlab-ci.yml", "Jenkinsfile", ...GUARDRAIL_PATHS]) assert.ok(fileDenied(withGrant, file), `${file} stays denied`);
    const other = settingsFor("security", [{ kind: "path", value: "/srv/shared/data" }]);
    assert.ok(fileDenied(other, ".github/workflows/ci.yml"), "an unrelated grant lifts nothing");
  });
});

describe("forbid beats permit: no grant shape lifts a deny", () => {
  const GRANTS = [
    [{ kind: "host", value: "github.com" }], [{ kind: "host", value: "api.github.com" }],
    [{ kind: "path", value: WT }], [{ kind: "path", value: `${WT}/.claude` }], [{ kind: "path", value: `${WT}/.github` }],
    [{ kind: "path", value: `${WT}/apps/bridge/agents` }], [{ kind: "path", value: `${WT}/apps/bridge/agents/ceilings.json` }],
    [{ kind: "path", value: "/work/den" }], [{ kind: "path", value: "/srv/shared/data" }], [{ kind: "path", value: "~/projects/x" }],
    [{ kind: "host", value: "github.com" }, { kind: "path", value: `${WT}/.claude` }],
  ];
  for (const role of ROLES_WITH_GRANTS) {
    GRANTS.forEach((grants, i) => {
      test(`${role}, grant set ${i} (${grants.map((g) => `${g.kind}:${g.value}`).join(" + ")})`, () => {
        let s;
        try { s = settingsFor(role, grants); } catch (e) { assert.ok(e instanceof TypeError, "a refused grant is a TypeError"); return; }
        const covered = (file) => grants.some((g) => g.kind === "path" && (`${WT}/${file}`.startsWith(`${g.value}/`) || `${WT}/${file}` === g.value));
        for (const file of GUARDRAIL_PATHS) assert.ok(fileDenied(s, file) && writeToolDenied(s, file), `${role}: ${file} stays denied`);
        for (const file of CI_PATHS) {
          if (role === "security" && covered(file)) continue; // the one stated exception
          assert.ok(fileDenied(s, file) && writeToolDenied(s, file), `${role}: ${file} stays denied`);
        }
        for (const command of GOVERNANCE_COMMANDS) assert.ok(bashDenied(s.permissions.deny, command), `${role}: ${command} stays denied`);
        for (const rule of FOUR) assert.ok(s.permissions.deny.includes(rule), rule);
      });
    });
  }
});

describe("bypass forms: the compiled rules refuse each wrapped governance command", () => {
  const WRAPS = [
    ["plain", (c) => c], ["newline between commands", (c) => `echo ok\n${c}`], ["newline after", (c) => `${c}\necho ok`], ["semicolon", (c) => `true; ${c}`],
    ["and-list", (c) => `true && ${c}`], ["pipe", (c) => `echo x | ${c}`], ["$(...)", (c) => `echo $(${c})`], ["backticks", (c) => `echo \`${c}\``],
    ["<(...)", (c) => `cat <(${c})`], ["subshell", (c) => `(${c})`], ["bash -c", (c) => `bash -c '${c}'`],
  ];
  const BASES = ["git push origin HEAD", "gh pr create --fill", "gh pr merge 12", "gh pr review 12 --approve", "gh issue close 5", "gh release create v1.0"];
  for (const role of [...ROLES_WITH_GRANTS, "chief-of-staff"]) {
    for (const base of BASES) {
      for (const [name, wrap] of WRAPS) {
        test(`${role}: ${name} around "${base}"`, () => assert.ok(bashDenied(settingsFor(role).permissions.deny, wrap(base)), JSON.stringify(wrap(base))));
      }
    }
    for (const command of ["git -c core.hooksPath=/dev/null commit -m x", "git -c core.hooksPath=/dev/null push origin HEAD", "git -c core.hooksPath=/dev/null -c user.name=a commit -m x"]) {
      test(`${role}: "${command}" is refused`, () => assert.ok(bashDenied(settingsFor(role).permissions.deny, command)));
    }
    test(`${role}: ordinary work is not swept up (npm test, git status, node --test, git commit)`, () => {
      const deny = settingsFor(role).permissions.deny;
      for (const ok of ["npm test", "git status", "node --test apps/bridge", "git commit -m 'add tests'", "git diff --stat"]) assert.equal(bashDenied(deny, ok), false, ok);
    });
  }
});

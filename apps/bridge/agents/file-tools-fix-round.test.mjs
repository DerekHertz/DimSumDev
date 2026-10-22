// hardening/01 fix round (code review + qa verify of 8f79015). Three findings, each pinned at its seam:
//   1. A leading `~` or `~/` in a file tool's path is expanded against the home folder before it is judged (the CLI expands it too),
//      so `~/.ssh/id_rsa` is outside the worktree and is denied, at the function and at the host.
//   2. blockReadsOutsideWorkingDirectories and additionalDirectories come back to agents with a way out only; the shell read limit
//      (denyRead/allowRead) still covers every agent with a worktree.
//   3. Glob and Grep with a `path` outside the worktree are denied like the other file tools; no path means the cwd, which is inside.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { makeBridge, until } from "./host-test-helpers.mjs";
import { buildClaudeArgs, compileCeiling, fileToolRefusal } from "./claude-adapter.mjs";

const HOME = "/home/u";
const WT = "/home/u/den/.claude/worktrees/den-x-01-abcd1234";
const refusal = (tool, input, extra = {}) => fileToolRefusal({ tool, input, worktree: WT, home: HOME, ...extra });
const KEY = { Read: "file_path", Write: "file_path", Edit: "file_path", NotebookEdit: "notebook_path" };

describe("fileToolRefusal: a leading ~ is the home folder", () => {
  for (const tool of Object.keys(KEY)) {
    test(`${tool}: ~, ~/x, ~/.ssh/id_rsa and ~/ with .. are refused`, () => {
      for (const given of ["~", "~/", "~/x", "~/.ssh/id_rsa", "~/../etc/passwd", "~/den/../.ssh/id_rsa"]) {
        assert.match(refusal(tool, { [KEY[tool]]: given }) ?? "", /outside/, `${tool} on ${given}`);
      }
    });

    test(`${tool}: a ~ path that lands inside the worktree is allowed, and the refusal names the expanded path`, () => {
      assert.equal(refusal(tool, { [KEY[tool]]: `~/den/.claude/worktrees/den-x-01-abcd1234/src/a.mjs` }), null);
      assert.match(refusal(tool, { [KEY[tool]]: "~/x" }), /\/home\/u\/x/);
    });

    test(`${tool}: ~ with no home to expand against fails closed; ~name and a ~ inside a name are ordinary segments`, () => {
      assert.match(fileToolRefusal({ tool, input: { [KEY[tool]]: "~/x" }, worktree: WT }) ?? "", /Refused/);
      assert.equal(refusal(tool, { [KEY[tool]]: "~name/x" }), null, "a relative name that starts with ~ is a file in the worktree");
      assert.equal(refusal(tool, { [KEY[tool]]: "src/~/x" }), null);
    });
  }

  test("a ~ grant still counts as inside, and a ~ path under it is allowed", () => {
    assert.equal(refusal("Write", { file_path: "~/notes/a.txt" }, { grantPaths: ["~/notes"] }), null);
    assert.match(refusal("Write", { file_path: "~/other/a.txt" }, { grantPaths: ["~/notes"] }) ?? "", /outside/);
  });
});

describe("fileToolRefusal: Glob and Grep judge their path", () => {
  for (const tool of ["Glob", "Grep"]) {
    test(`${tool}: a path outside the worktree is refused (absolute, .., ~, a sibling prefix)`, () => {
      for (const p of ["/etc", HOME, `${HOME}/.ssh`, "/home/u/den", `${WT}/../other`, "../../..", "~", "~/.ssh", `${WT}-evil`]) {
        assert.match(refusal(tool, { path: p, pattern: "*" }) ?? "", /outside the worktree/, `${tool} on ${p}`);
      }
    });

    test(`${tool}: a path inside the worktree, or no path (the cwd), is not refused`, () => {
      for (const input of [{ pattern: "*" }, { path: WT, pattern: "*" }, { path: `${WT}/src`, pattern: "*" }, { path: "src", pattern: "*" }]) {
        assert.equal(refusal(tool, input), null, JSON.stringify(input));
      }
    });

    test(`${tool}: a path that is not a plain string is refused; the ticket-file exception is for Read only`, () => {
      for (const p of ["", 7, {}, "a\0b"]) assert.match(refusal(tool, { path: p, pattern: "*" }) ?? "", /Refused/, JSON.stringify(p));
      const ticket = "/home/u/den/.scratch/fx/issues/01-a.md";
      assert.match(refusal(tool, { path: ticket, pattern: "*" }, { ticketFile: ticket }) ?? "", /outside/);
    });
  }
});

describe("the file-tool limit in the settings belongs to an agent with a way out", () => {
  const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const ROOT = "/home/u/den";
  const TICKET = `${ROOT}/.scratch/den/issues/01-x.md`;
  const settingsFor = (role, options = {}) => {
    const argv = buildClaudeArgs({ sessionId: SID, agent: role, ticketFile: TICKET, ...compileCeiling(role, { worktree: WT, root: ROOT, mainGit: `${ROOT}/.git`, home: HOME, toolchain: "/home/u/.nvm/node", ...options }) });
    return JSON.parse(argv[argv.indexOf("--settings") + 1]);
  };

  test("a worktree agent with no way out gets neither key, but keeps the shell read limit", () => {
    for (const role of ["developer", "qa", "security", "code-reviewer", "technical-writer"]) {
      const s = settingsFor(role);
      assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, undefined, role);
      assert.equal(s.permissions.additionalDirectories, undefined, role);
      assert.deepEqual(s.sandbox.filesystem.denyRead, ["~/"], `${role}: the shell stays limited`);
      assert.ok(s.permissions.allow.includes(`Read(/${TICKET})`), `${role}: its own ticket is still one allow`);
    }
  });

  test("a granted host, or a remote connection, brings both keys", () => {
    for (const options of [{ grants: [{ kind: "host", value: "registry.npmjs.org" }] }, { remote: true }]) {
      const s = settingsFor("developer", options);
      assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
      assert.deepEqual(s.permissions.additionalDirectories, [`${ROOT}/.scratch/den/issues`]);
    }
  });

  test("wayOut is only accepted as true, and only with the read limit", () => {
    assert.throws(() => buildClaudeArgs({ sessionId: SID, agent: "developer", wall: { hosts: [] }, readLimit: true, wayOut: "yes" }), TypeError);
    assert.throws(() => buildClaudeArgs({ sessionId: SID, agent: "developer", wall: { hosts: [] }, wayOut: true }), TypeError);
  });
});

describe("at the host, a ~ path and a Glob or Grep path outside the worktree are denied", () => {
  let t;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });
  let n = 0;
  async function boot() {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "developer", text: "Tidy the notes." });
    assert.equal(res.status, 201, res.text);
    return { rec: t.fake.spawns[0], agentId: (await t.state()).agents[0].id };
  }
  const pending = async (agentId) => ((await t.state()).approvals ?? []).filter((a) => a.agentId === agentId && a.state === "pending");
  async function assertDenied(ctx, tool, input, what) {
    const requestId = `fix-${(n += 1)}`;
    ctx.rec.emit({ type: "permission-request", requestId, tool, input });
    const decision = await until(() => ctx.rec.decisions.find((d) => d.requestId === requestId), { what: `the host's answer to ${what}` });
    assert.equal(decision.allow, false, `${what}: denied`);
    assert.match(decision.reason ?? "", /outside the worktree/, what);
    assert.deepEqual(await pending(ctx.agentId), [], `${what}: not held for the user`);
  }

  for (const tool of Object.keys(KEY)) {
    test(`${tool}: ~, ~/x, ~/.ssh/id_rsa and ~/ with .. are denied`, async () => {
      const ctx = await boot();
      for (const given of ["~", "~/x", "~/.ssh/id_rsa", "~/../escape.txt"]) await assertDenied(ctx, tool, { [KEY[tool]]: given }, `${tool} on ${given}`);
    });
  }

  for (const tool of ["Glob", "Grep"]) {
    test(`${tool}: a path outside the worktree is denied`, async () => {
      const ctx = await boot();
      for (const p of [os.homedir(), "~", "~/.ssh", "/etc", path.dirname(ctx.rec.args.cwd), `${ctx.rec.args.cwd}-evil`]) await assertDenied(ctx, tool, { path: p, pattern: "*" }, `${tool} on ${p}`);
    });
  }

  test("a sibling ticket's Read is denied by the host rule, with no way out and no grant", async () => {
    const ctx = await boot();
    await assertDenied(ctx, "Read", { file_path: path.join(path.dirname(ctx.rec.args.ticketFile), "99-someone-elses.md") }, "Read of a sibling ticket");
  });
});

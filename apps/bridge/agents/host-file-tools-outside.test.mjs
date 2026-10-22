// hardening/01 (ADR 0021 l.107), approach A (user, 2026-10-22): the deny lives in the host's answer to a permission request.
// When the CLI raises a can_use_tool request for Read, Write or Edit on a path outside the agent's worktree, the host answers
// deny with a clear reason, at once, and never makes it a question for the user. Everything else the host answers exactly
// as before: a path inside the worktree, a granted path, the agent's own ticket file (Read), a connection's tools from the
// library catalog (a read allowed, a write asked), and Bash, WebFetch and the rest (asked).
//
// At the startBridge seam with the fake runtime: the worktree is the spawn's cwd, the ticket file and the grants are the spawn's
// args, and the host's answer is the record's decide() calls (record.decisions). An "asked as before" case is an approval
// held for the user with no decision recorded.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeBridge, until } from "./host-test-helpers.mjs";
import { parseCatalog } from "../library/catalog.mjs";
import { createLibrary } from "../library/library.mjs";

const GRANT = "/srv/shared/data";
let t;
let dirs = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

let n = 0;
const nextId = () => `req-${(n += 1)}`;

// A developer task with a path grant: { rec, agentId, cwd (the worktree), ticket }.
async function boot(options) {
  t = await makeBridge(options);
  const res = await t.post("/tasks", { role: "developer", text: "Tidy the notes.", grants: [{ kind: "path", value: GRANT }] });
  assert.equal(res.status, 201, res.text);
  const rec = t.fake.spawns[0];
  return { rec, agentId: (await t.state()).agents[0].id, cwd: rec.args.cwd, ticket: rec.args.ticketFile };
}
const pending = async (agentId) => ((await t.state()).approvals ?? []).filter((a) => a.agentId === agentId && a.state === "pending");

// The host denied the call: one decision for that request, allow false, a reason that names the problem, and no approval.
async function assertDenied(ctx, tool, input, what) {
  const requestId = nextId();
  const before = (await pending(ctx.agentId)).length;
  ctx.rec.emit({ type: "permission-request", requestId, tool, input });
  const decision = await until(() => ctx.rec.decisions.find((d) => d.requestId === requestId), { what: `the host's answer to ${what}` });
  assert.equal(decision.allow, false, `${what}: denied`);
  assert.match(decision.reason ?? "", /outside/i, `${what}: the reason says the path is outside`);
  assert.match(decision.reason ?? "", /worktree/i, `${what}: the reason names the worktree`);
  assert.equal((await pending(ctx.agentId)).length, before, `${what}: not held for the user`);
}
// Not denied: the request is held for the user as it always was, and the host recorded no answer for it.
async function assertAsked(ctx, tool, input, what) {
  const requestId = nextId();
  const before = (await pending(ctx.agentId)).length;
  ctx.rec.emit({ type: "permission-request", requestId, tool, input });
  await until(async () => (await pending(ctx.agentId)).length === before + 1, { what: `${what} to be held for the user` });
  assert.equal(ctx.rec.decisions.find((d) => d.requestId === requestId), undefined, `${what}: the host answered nothing`);
}

describe("Read, Write and Edit outside the worktree are denied by the host", () => {
  for (const tool of ["Read", "Write", "Edit"]) {
    test(`${tool}: a file under $HOME, ~/.ssh, the main checkout, a sibling worktree and /etc/passwd are each denied`, async () => {
      const ctx = await boot();
      const outside = {
        "a file under $HOME": path.join(os.homedir(), "den-secret-notes.txt"),
        "~/.ssh": path.join(os.homedir(), ".ssh", "id_rsa"),
        "the main checkout": path.join(t.fx.root, "package.json"),
        "a sibling worktree": path.join(path.dirname(ctx.cwd), "den-other-01-deadbeef", "src", "a.mjs"),
        "/etc/passwd": "/etc/passwd",
      };
      for (const [what, file_path] of Object.entries(outside)) await assertDenied(ctx, tool, { file_path, ...(tool === "Write" ? { content: "x" } : {}) }, `${tool} on ${what}`);
    });

    test(`${tool}: a path that climbs out of the worktree with .., a relative one that does, and a sibling that shares the worktree's prefix are denied`, async () => {
      const ctx = await boot();
      const tricks = {
        "an absolute path with ..": `${ctx.cwd}/../../../escape.txt`,
        "a .. in the middle": `${ctx.cwd}/src/../../escape.txt`,
        "a relative path with ..": "../../escape.txt",
        "the worktree's name plus a suffix": `${ctx.cwd}-evil/x`,
      };
      for (const [what, file_path] of Object.entries(tricks)) await assertDenied(ctx, tool, { file_path }, `${tool} on ${what}`);
    });

    test(`${tool}: a path inside the worktree is not denied (asked as before)`, async () => {
      const ctx = await boot();
      for (const file_path of [`${ctx.cwd}/src/a.mjs`, `${ctx.cwd}/src/../b.mjs`, "src/a.mjs"]) await assertAsked(ctx, tool, { file_path }, `${tool} on ${file_path}`);
    });
  }

  test("Write and Edit on a granted path are not denied (asked as before)", async () => {
    const ctx = await boot();
    for (const tool of ["Write", "Edit"]) await assertAsked(ctx, tool, { file_path: `${GRANT}/notes.txt` }, `${tool} on a granted path`);
  });

  test("Read of the agent's own ticket file is not denied; a Write or Edit of it is", async () => {
    const ctx = await boot();
    assert.match(ctx.ticket, /\.scratch\/[^/]+\/issues\/[^/]+\.md$/, "the spawn names the ticket file");
    await assertAsked(ctx, "Read", { file_path: ctx.ticket }, "Read of the ticket file");
    for (const tool of ["Write", "Edit"]) await assertDenied(ctx, tool, { file_path: ctx.ticket }, `${tool} of the ticket file`);
  });

  test("a Read of another ticket's file on the board is denied: only the agent's own is allowed", async () => {
    const ctx = await boot();
    await assertDenied(ctx, "Read", { file_path: path.join(path.dirname(ctx.ticket), "99-someone-elses.md") }, "Read of another ticket file");
  });
});

describe("everything else is answered as before", () => {
  test("Bash and WebFetch are asked, whatever path or address they name", async () => {
    const ctx = await boot();
    await assertAsked(ctx, "Bash", { command: `cat ${os.homedir()}/.ssh/id_rsa` }, "Bash outside the worktree");
    await assertAsked(ctx, "WebFetch", { url: "https://example.org/" }, "WebFetch");
  });
});

describe("a connection's tools are still the library's to answer (regression guards)", () => {
  const CATALOG = parseCatalog({
    connections: [{ name: "docs", title: "Docs", purpose: "Look things up.", url: "https://docs.example.com/mcp", credential: "none", roles: ["architect"], tools: { find: "read", save: "change" } }],
  });
  async function bootLibrary() {
    const denRoot = await mkdtemp(path.join(os.tmpdir(), "den-outside-"));
    dirs.push(denRoot);
    await mkdir(path.join(denRoot, ".claude", "agents"), { recursive: true });
    await writeFile(path.join(denRoot, ".claude", "agents", "architect.md"), "---\nname: architect\ntools: Read, mcp__docs\n---\nbody\n");
    t = await makeBridge({ library: createLibrary({ catalog: CATALOG, denRoot, stateDir: path.join(denRoot, "state") }) });
    const { agent } = (await t.dispatch("architect")).body;
    return { rec: t.fake.spawns[0], agentId: agent.id };
  }

  test("a read tool is allowed without a question, even with a path-looking input", async () => {
    const ctx = await bootLibrary();
    const requestId = nextId();
    ctx.rec.emit({ type: "permission-request", requestId, tool: "mcp__docs__find", input: { file_path: "/etc/passwd", query: "proxy" } });
    const decision = await until(() => ctx.rec.decisions.find((d) => d.requestId === requestId), { what: "the answer" });
    assert.equal(decision.allow, true);
    assert.deepEqual(await pending(ctx.agentId), []);
  });

  test("a write tool is asked, not refused and not allowed", async () => {
    const ctx = await bootLibrary();
    await assertAsked(ctx, "mcp__docs__save", { text: "hi" }, "the write tool");
  });

  test("a file tool outside the worktree is denied for a role that has a library too", async () => {
    const ctx = await bootLibrary();
    await assertDenied({ ...ctx, cwd: ctx.rec.args.cwd }, "Write", { file_path: "/etc/passwd" }, "Write on /etc/passwd");
  });
});

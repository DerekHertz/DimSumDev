import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { createHost } from "./host.mjs";
import { createFakeRuntime } from "./runtime.mjs";
import { createWorkspaces } from "./workspace.mjs";
import { DISPATCH_REF, makeBridge, seedSessions, until } from "./host-test-helpers.mjs";
import { addProject } from "../projects.mjs";

test("target-project prompts name the trusted control recipe and the selected board ticket as a worktree note", async () => {
  const control = await makeStateFixture({ git: true });
  const target = await makeStateFixture({ git: true });
  const runtime = createFakeRuntime();
  const host = createHost({ root: control.root, runtime, policy: { killGraceMs: 30 }, projects: {
    active: async () => "acme",
    get: async (slug) => slug === "acme" ? { slug, root: target.root, workspaces: createWorkspaces(target.root) } : null,
  } });
  try {
    await host.ready;
    const result = await host.start({ role: "architect", ref: DISPATCH_REF });
    assert.equal(result.status, 201);
    const { args } = runtime.spawns[0];
    const recipe = path.join(control.root, ".claude/agents/architect.md");
    assert.equal(args.project.recipeFile, recipe);
    assert.ok(args.prompt.includes(`Read ${recipe} `));
    assert.ok(args.prompt.includes(".den/ticket.md"), "a target's ticket is the note in the worktree");
    assert.ok(!args.prompt.includes(".scratch"));
    assert.equal(args.ticketFile, undefined);
  } finally {
    for (const record of runtime.spawns) record.exit({ code: 1 });
    await host.shutdown();
    await target.cleanup();
    await control.cleanup();
  }
});

test("a target-project run publishes its completion handoff on the captured board", async () => {
  const state = await makeStateFixture({ empty: true });
  const target = await makeStateFixture({ git: true });
  execFileSync("git", ["-C", target.root, "remote", "add", "origin", target.root], { stdio: "pipe" });
  const t = await makeBridge({ denState: state.root });
  try {
    assert.deepEqual(await addProject(state.root, { slug: "acme", path: target.root, board: { kind: "markdown" } }), { ok: true });
    assert.equal((await t.post("/projects/active", { slug: "acme" })).status, 200);
    const started = await t.post("/agents", { role: "architect", ref: DISPATCH_REF, project: "acme" });
    assert.equal(started.status, 201);
    t.fake.spawns[0].emit({ type: "text", text: "Target project report" });
    t.fake.spawns[0].emit({ type: "done", ok: true });
    const prefix = started.body.agent.id.slice(2, 10);
    const filesAt = (root) => readdir(path.join(root, ".scratch/fx/handoffs")).catch(() => []);
    const file = await until(async () => (await filesAt(target.root)).find((name) => name.includes(prefix)), { what: "the target project's handoff" });
    assert.ok((await readFile(path.join(target.root, ".scratch/fx/handoffs", file), "utf8")).includes(started.body.agent.id));
    assert.ok(!(await filesAt(t.fx.root)).some((name) => name.includes(prefix)));
  } finally {
    await t.close();
    await target.cleanup();
    await state.cleanup();
  }
});

test("same-named tickets in distinct projects retain distinct shared capacity reservations", async () => {
  const den = await makeStateFixture({ git: true });
  const acme = await makeStateFixture({ git: true });
  let active = "den";
  const runtime = createFakeRuntime();
  const host = createHost({ root: den.root, runtime, policy: { killGraceMs: 30 }, projects: {
    active: async () => active,
    get: async (slug) => {
      const root = slug === "den" ? den.root : slug === "acme" ? acme.root : null;
      return root ? { slug, root, workspaces: createWorkspaces(root) } : null;
    },
  } });
  try {
    await host.ready;
    assert.equal((await host.start({ ref: DISPATCH_REF, role: "architect" })).status, 201);
    // Exercise host authority even if a registry changes independently of the HTTP switch guard.
    active = "acme";
    assert.equal((await host.start({ ref: DISPATCH_REF, role: "developer" })).status, 201);
    const capacity = host.capacity([], "acme");
    assert.equal(capacity.live, 2);
    assert.equal(capacity.room, 0);
    assert.deepEqual(capacity.refs.map(({ ref, project }) => ({ ref, project })), [{ ref: DISPATCH_REF, project: "den" }, { ref: DISPATCH_REF, project: "acme" }]);
    assert.equal((await host.start({ ref: "fx/03-ready-p1", role: "technical-writer" })).status, 429);
    assert.equal(runtime.spawns.length, 2);
  } finally {
    for (const record of runtime.spawns) record.exit({ code: 1 });
    await host.shutdown();
    await acme.cleanup();
    await den.cleanup();
  }
});

test("snapshot history trimming cannot reattribute an older project's legacy conversation", async () => {
  const fx = await makeStateFixture({ git: true });
  const at = "2026-10-01T09:00:00.000Z";
  const sessionId = "08376463-453a-4135-a7df-4ee921c22e86";
  const rows = Array.from({ length: 201 }, (_, n) => {
    const agentId = `c-${n.toString(16).padStart(16, "0")}`;
    return [{ ts: at, event: "spawn", agentId, ref: DISPATCH_REF, role: "architect", sessionId, project: n === 0 ? "acme" : "den" }, { ts: at, event: "end", agentId, ref: DISPATCH_REF, state: "done" }];
  }).flat();
  await seedSessions(fx.root, rows);
  const dir = path.join(fx.root, ".scratch/_run/conversations");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "architect.jsonl"), JSON.stringify({ runId: rows[0].agentId, ref: DISPATCH_REF, id: 1, at, kind: "message", role: "agent", text: "acme only" }) + "\n");
  const host = createHost({ root: fx.root, projects: {
    active: async () => "den",
    get: async (slug) => ["den", "acme"].includes(slug) ? { slug, root: fx.root, workspaces: createWorkspaces(fx.root) } : null,
  } });
  try {
    await host.ready;
    assert.equal(host.snapshot().length, 200);
    assert.deepEqual((await host.conversation("architect", { project: "den" })).entries, []);
    assert.deepEqual((await host.conversation("architect", { project: "acme" })).entries.map((e) => e.text), ["acme only"]);
  } finally {
    await host.shutdown();
    await fx.cleanup();
  }
});

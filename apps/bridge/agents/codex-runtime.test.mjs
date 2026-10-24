// den-revival/03 slice 1b: the Codex runtime on the host launch path, over the stub app-server (no Codex binary, login or account call).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexRuntime } from "./codex-runtime.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";
import { makeStateFixture } from "../bridge-fixture.mjs";
import { makeBridge, until } from "./host-test-helpers.mjs";

const STUB = fileURLToPath(new URL("./codex-stub.mjs", import.meta.url));
const SECRET = "chatgpt-login-secret-do-not-leak";
const recipe = (role) => `name = "${role}"\nmodel = "gpt-stub-1"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = '''\nJob: be the ${role}.\n'''\n`;
const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function setup({ login = true, mode = "ok", over = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-runtime-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const control = path.join(dir, "control");
  const cwd = path.join(control, "worktree");
  for (const d of [`${home}/.codex`, `${control}/.codex/agents`, cwd]) mkdirSync(d, { recursive: true });
  if (login) writeFileSync(`${home}/.codex/auth.json`, JSON.stringify({ token: SECRET }), { mode: 0o600 });
  for (const role of ["developer", "qa"]) writeFileSync(`${control}/.codex/agents/${role}.toml`, recipe(role));
  const runtime = createCodexRuntime({ env: { HOME: home, PATH: process.env.PATH }, launcher: unconfinedLauncher(), controlRoot: control, native: { codexBin: process.execPath, nativeHelper: STUB }, codexArgs: [STUB, mode], ...over });
  const ids = { sessionId: "11111111-1111-4111-8111-111111111111", runId: "c-0123456789abcdef" };
  const spawn = async (more = {}) => {
    const proc = await runtime.spawn({ role: "developer", cwd, prompt: "echo hello-from-codex-$((40+2))", ...ids, ...more });
    cleanups.push(async () => { proc.signal("SIGKILL"); await proc.exited; });
    return proc;
  };
  const store = (id = ids.sessionId) => `${home}/.local/state/den/credentials/codex/${id}/native`;
  return { dir, home, cwd, control, runtime, spawn, store, ids };
}

const collect = async (proc, until = "done") => {
  const got = [];
  for await (const event of proc.events) { got.push(event); if (event.type === until) break; }
  return got;
};

test("a direct run returns the shell output and the acknowledged thread, with the model from the role file", async () => {
  const t = setup();
  const proc = await t.spawn();
  assert.equal(proc.runtimeSessionId, "thread-1");
  const events = await collect(proc);
  assert.equal(events.find((e) => e.type === "model").model, "gpt-stub-1");
  assert.equal(events.find((e) => e.type === "tool-result").text, "hello-from-codex-42\n");
  assert.equal(events.at(-1).ok, true);
  proc.closeInput();
  const end = await proc.exited;
  assert.ok(end.code !== undefined);
});

test("each role gets its own profile: a writer writes its worktree, a reader only reads it", async () => {
  const t = setup();
  const dev = await t.spawn();
  const devConfig = readFileSync(`${t.store()}/config.toml`, "utf8");
  assert.match(devConfig, /default_permissions = "den-developer"/);
  assert.match(devConfig, new RegExp(`"${t.cwd}" = "write"`));
  assert.match(devConfig, /model = "gpt-stub-1"/);
  dev.closeInput();
  await dev.exited;
  const qaDir = setup();
  const qa = await qaDir.spawn({ role: "qa" });
  const qaConfig = readFileSync(`${qaDir.store()}/config.toml`, "utf8");
  assert.match(qaConfig, /default_permissions = "den-qa"/);
  assert.doesNotMatch(qaConfig, new RegExp(`"${qaDir.cwd}" = "write"`));
  assert.match(qaConfig, new RegExp(`"${qaDir.cwd}" = "read"`));
  qa.closeInput();
  await qa.exited;
});

test("the login is copied into the private native store and never into the worktree or the config", async () => {
  const t = setup();
  const proc = await t.spawn();
  const copy = `${t.store()}/auth.json`;
  assert.equal(readFileSync(copy, "utf8"), JSON.stringify({ token: SECRET }));
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(`${t.store()}/config.toml`, "utf8"), new RegExp(SECRET));
  assert.match(readFileSync(`${t.store()}/config.toml`, "utf8"), /"[^"]*\/native" = "deny"/);
  proc.closeInput();
  await proc.exited;
});

test("no login means no start, and the reason never contains the login", async () => {
  const t = setup({ login: false });
  const check = await t.runtime.preflight();
  assert.equal(check.ok, false);
  assert.match(check.reason, /Codex login/);
  await assert.rejects(t.runtime.spawn({ role: "developer", cwd: t.cwd, prompt: "x", ...t.ids }), (err) => err.name === "EnforcementError" && !err.message.includes(SECRET));
});

test("a model the caller names that differs from the role file is refused", async () => {
  const t = setup();
  await assert.rejects(t.runtime.spawn({ role: "developer", cwd: t.cwd, prompt: "x", model: "gpt-other", ...t.ids }), /model/);
});

test("a flood of events is drained at once, so a slow consumer never closes the app-server", async () => {
  const t = setup({ mode: "flood" });
  const proc = await t.spawn({ prompt: "ignored" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const events = await collect(proc);
  assert.equal(events.filter((e) => e.type === "text").length, 400);
  assert.equal(events.at(-1).ok, true);
});

test("a stop ends a run and resolves exited", async () => {
  const t = setup();
  const proc = await t.spawn({ prompt: "sleep 30" });
  proc.signal("SIGKILL");
  const end = await proc.exited;
  assert.ok(end.signal !== null || end.code !== null);
});

test("one direct task to a Codex resident returns a result in the den", async () => {
  const t = setup();
  const fx = await makeStateFixture({ git: true });
  cleanups.push(() => fx.cleanup());
  mkdirSync(`${fx.root}/.codex/agents`, { recursive: true });
  writeFileSync(`${fx.root}/.codex/agents/sre.toml`, recipe("sre"));
  const codex = createCodexRuntime({ env: { HOME: t.home, PATH: process.env.PATH }, launcher: unconfinedLauncher(), controlRoot: fx.root, native: { codexBin: process.execPath, nativeHelper: STUB }, codexArgs: [STUB, "ok"] });
  const bridge = await makeBridge({ noRuntime: true, root: fx.root, extra: { runtimes: { codex } } });
  cleanups.push(() => bridge.close());
  const res = await bridge.post("/tasks", { role: "sre", text: "echo hello-from-codex-$((40+2))", runtime: "codex" });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.agent.runtime, "codex");
  await until(async () => (await bridge.agent(res.body.agent.id))?.state === "done", { ms: 8000, what: "the Codex run to finish" });
});

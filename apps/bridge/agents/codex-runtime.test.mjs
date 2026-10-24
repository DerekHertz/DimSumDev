// den-revival/03 slice 1b: the Codex runtime on the host launch path, over the stub app-server (no Codex binary, login or account call).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexRuntime } from "./codex-runtime.mjs";
import { runtimeOptions } from "../server.mjs";
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
  for (const role of ["developer", "chief-of-staff"]) writeFileSync(`${control}/.codex/agents/${role}.toml`, recipe(role));
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

test("each role gets its own profile: a writer writes its worktree, a role with no write ceiling only reads it", async () => {
  const t = setup();
  const dev = await t.spawn();
  const devConfig = readFileSync(`${t.store()}/config.toml`, "utf8");
  assert.match(devConfig, /default_permissions = "den-developer"/);
  assert.match(devConfig, new RegExp(`"${t.cwd}" = "write"`));
  assert.match(devConfig, /model = "gpt-stub-1"/);
  dev.closeInput();
  await dev.exited;
  const qaDir = setup();
  const qa = await qaDir.spawn({ role: "chief-of-staff" });
  const qaConfig = readFileSync(`${qaDir.store()}/config.toml`, "utf8");
  assert.match(qaConfig, /default_permissions = "den-chief-of-staff"/);
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

const ended = async (proc) => { proc.closeInput(); await proc.exited; };

test("a login the run refreshed is written back to the user's file, whole and private, and an unchanged one is left alone", async () => {
  const t = setup();
  const user = `${t.home}/.codex/auth.json`;
  const quiet = await t.spawn();
  utimesSync(user, 1, 1);
  await ended(quiet);
  assert.equal(statSync(user).mtimeMs, 1000);
  const refreshed = JSON.stringify({ token: SECRET, refresh: "rotated" });
  const proc = await t.spawn();
  writeFileSync(`${t.store()}/auth.json`, refreshed);
  await ended(proc);
  assert.equal(readFileSync(user, "utf8"), refreshed);
  assert.equal(statSync(user).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(path.dirname(user)), ["auth.json"]);
});

test("a login cut off half-written is not copied over the user's file", async () => {
  const t = setup();
  const proc = await t.spawn();
  writeFileSync(`${t.store()}/auth.json`, '{"token": "cut-o');
  await ended(proc);
  assert.equal(readFileSync(`${t.home}/.codex/auth.json`, "utf8"), JSON.stringify({ token: SECRET }));
});

test("a login the host changed during the run is not overwritten, and no temp file is left behind", async () => {
  const t = setup();
  const user = `${t.home}/.codex/auth.json`;
  const proc = await t.spawn();
  writeFileSync(`${t.store()}/auth.json`, JSON.stringify({ token: SECRET, refresh: "rotated" }));
  const hostLogin = JSON.stringify({ token: "logged-in-again-on-the-host" });
  writeFileSync(user, hostLogin);
  await ended(proc);
  assert.equal(readFileSync(user, "utf8"), hostLogin);
  assert.deepEqual(readdirSync(path.dirname(user)), ["auth.json"]);
});

test("a write-back that fails leaves no temp login in the user's directory", async () => {
  const t = setup();
  const user = `${t.home}/.codex/auth.json`;
  const proc = await t.spawn();
  writeFileSync(`${t.store()}/auth.json`, JSON.stringify({ token: SECRET, refresh: "rotated" }));
  rmSync(user);
  mkdirSync(`${user}/kept`, { recursive: true });
  await ended(proc);
  assert.deepEqual(readdirSync(path.dirname(user)), ["auth.json"]);
});

test("a role that is not a plain role name is refused before any file is probed", async () => {
  const t = setup();
  await assert.rejects(t.runtime.spawn({ role: "../agents/developer", cwd: t.cwd, prompt: "x", ...t.ids }), (err) => err.name === "TypeError" && /role/.test(err.message));
});

test("secrets in the agent's text, commands and output are masked before they become events", async () => {
  const KEY = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  const t = setup();
  const proc = await t.spawn({ prompt: `echo ${KEY}` });
  const events = await collect(proc);
  assert.ok(events.some((e) => e.type === "tool-result" && /masked/.test(e.text)));
  assert.ok(!JSON.stringify(events).includes(KEY.slice(4)), JSON.stringify(events));
  await ended(proc);
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

test("the Codex runtime is registered only with DEN_CODEX=1, and then beside Claude's", async () => {
  const claude = { id: "claude" };
  assert.deepEqual(await runtimeOptions({ env: {}, claude, root: "/unused" }), { runtime: claude });
  assert.deepEqual(await runtimeOptions({ env: { DEN_CODEX: "0" }, claude, root: "/unused" }), { runtime: claude });
  const t = setup();
  const on = await runtimeOptions({ env: { DEN_CODEX: "1", HOME: t.home, PATH: process.env.PATH }, claude, root: t.control });
  assert.equal(on.runtime, undefined);
  assert.equal(on.runtimes.claude, claude);
  assert.equal(on.runtimes.codex.id, "codex");
});

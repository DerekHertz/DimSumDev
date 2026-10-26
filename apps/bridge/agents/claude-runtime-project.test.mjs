// den-mvp/48: a spawn with a target project sends the committed guide text and the den: plugin flags.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { until } from "./host-test-helpers.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const SESSION = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

test("a target project: den: flags, empty setting sources, and the guide ahead of the prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "den-proj-root-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "den-proj-cwd-"));
  const git = (...a) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  git("init", "-q");
  await writeFile(path.join(root, "CLAUDE.md"), "TARGET GUIDE");
  git("add", "CLAUDE.md");
  git("commit", "-qm", "x");
  const stub = await makeStub({ mode: "hang" });
  const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: cwd, DEN_CLAUDE_BIN: stub.bin } });
  const proc = await runtime.spawn({ role: "developer", cwd, prompt: "do the thing", sessionId: SESSION, project: { control: false, root, pluginDir: "/den/.claude" } });
  cleanups.push(async () => {
    try { proc.signal("SIGKILL"); } catch {}
    const gc = await stub.grandchildPid();
    if (gc && alive(gc)) process.kill(gc, "SIGKILL");
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await until(async () => (await stub.start()) !== undefined, { what: "the child to start" });
  const argv = (await stub.start()).argv;
  const flag = (f) => argv[argv.indexOf(f) + 1];
  assert.equal(flag("--setting-sources"), "");
  assert.equal(flag("--plugin-dir"), "/den/.claude");
  assert.equal(flag("--agent"), "den:developer");
  await until(async () => (await stub.stdinLines()).length > 0, { what: "the prompt line" });
  const text = (await stub.stdinLines())[0].message.content;
  assert.match(text, /TARGET GUIDE/);
  assert.ok(text.endsWith("do the thing"));
});

// multi-project/04, items 1 and 3: the guide is framed as untrusted, an oversize one is refused in the prompt, and a resume does not repeat it.
async function firstPrompt({ guide, resume, control = false, name = "CLAUDE.md" }) {
  const root = await mkdtemp(path.join(tmpdir(), "den-proj-root-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "den-proj-cwd-"));
  const git = (...a) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  git("init", "-q");
  await writeFile(path.join(root, name), guide);
  git("add", name);
  git("commit", "-qm", "x");
  const stub = await makeStub({ mode: "hang" });
  const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: cwd, DEN_CLAUDE_BIN: stub.bin } });
  const proc = await runtime.spawn({ role: "developer", cwd, prompt: "do the thing", sessionId: SESSION, ...(resume ? { resume: true } : {}), project: { control, root, pluginDir: "/den/.claude" } });
  cleanups.push(async () => {
    try { proc.signal("SIGKILL"); } catch {}
    const gc = await stub.grandchildPid();
    if (gc && alive(gc)) process.kill(gc, "SIGKILL");
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await until(async () => (await stub.stdinLines()).length > 0, { what: "the prompt line" });
  return (await stub.stdinLines())[0].message.content;
}

test("the guide is framed as untrusted project knowledge in the prompt", async () => {
  const text = await firstPrompt({ guide: "TARGET GUIDE" });
  assert.match(text, /untrusted project knowledge/);
  assert.match(text, /<project-guide>\nTARGET GUIDE\n<\/project-guide>/);
});

test("an oversize guide is not sent; the prompt says why, and AGENTS.md is not read in its place", async () => {
  const text = await firstPrompt({ guide: "x".repeat(64 * 1024 + 1) });
  assert.match(text, /was not loaded: CLAUDE.md is \d+ bytes, over the 64 KiB cap/);
  assert.doesNotMatch(text, /xxxx/);
});

test("a resumed session's prompt does not repeat the guide", async () => {
  const text = await firstPrompt({ guide: "TARGET GUIDE", resume: true });
  assert.equal(text, "do the thing");
});

test("the den's own run keeps its old prompt: the plain guide header, and the guide again on resume", async () => {
  const old = "Project guide (CLAUDE.md, committed at HEAD):\n\nDEN GUIDE\n\ndo the thing";
  assert.equal(await firstPrompt({ guide: "DEN GUIDE", control: true }), old);
  assert.equal(await firstPrompt({ guide: "DEN GUIDE", control: true, resume: true }), old);
});

test("a target run refuses a toolchain path inside the control checkout when control is reached through a symlink", async () => {
  const real = await mkdtemp(path.join(tmpdir(), "den-ctl-real-"));
  const holder = await mkdtemp(path.join(tmpdir(), "den-ctl-link-"));
  const root = await mkdtemp(path.join(tmpdir(), "den-proj-root-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "den-proj-cwd-"));
  cleanups.push(async () => { for (const d of [real, holder, root, cwd]) await rm(d, { recursive: true, force: true }); });
  const link = path.join(holder, "control");
  await symlink(real, link);
  const runtime = createClaudeRuntime({ launcher: unconfinedLauncher(), controlRoot: link, env: { PATH: process.env.PATH, HOME: cwd } });
  const project = { control: false, root, pluginDir: "/den/.claude", toolchain: [path.join(real, "node_modules")] };
  await assert.rejects(runtime.spawn({ role: "developer", cwd, prompt: "x", sessionId: SESSION, project }), (e) => e instanceof TypeError && /control checkout/.test(e.message));
});

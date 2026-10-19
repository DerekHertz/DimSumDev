// den-mvp/33: a den-held connection token goes to a 0600 file under the den's credentials folder, never into argv,
// and the file is removed when the run ends. With no valid token the connection is left out and the run still starts.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { until } from "./host-test-helpers.mjs";
import { makeStub, alive } from "./claude-stub.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { unconfinedLauncher } from "./launcher-test-helpers.mjs";

const SESSION = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const TOKEN = ["ghp_", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"].join("");
const GITHUB = { name: "github", url: "https://api.githubcopilot.com/mcp/readonly", credential: "den", headers: { "X-MCP-Toolsets": "repos" } };
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function start({ token, connections = [GITHUB] } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "den-cred-home-"));
  const credDir = path.join(home, ".local", "state", "den", "credentials");
  if (token !== undefined) {
    await mkdir(credDir, { recursive: true });
    await writeFile(path.join(credDir, "github.token"), `${token}\n`);
  }
  const stub = await makeStub({ mode: "hang" });
  const cwd = await mkdtemp(path.join(tmpdir(), "den-cred-cwd-"));
  const runtime = createClaudeRuntime({ controlRoot: "/", launcher: unconfinedLauncher(), env: { PATH: process.env.PATH, HOME: home, DEN_CLAUDE_BIN: stub.bin } });
  const proc = await runtime.spawn({ role: "developer", cwd, prompt: "go", sessionId: SESSION, connections });
  cleanups.push(async () => {
    try { proc.signal("SIGKILL"); } catch {}
    const gc = await stub.grandchildPid();
    if (gc && alive(gc)) process.kill(gc, "SIGKILL");
    await rm(home, { recursive: true, force: true });
  });
  await until(async () => (await stub.start()) !== undefined, { what: "the child to start" });
  const argv = (await stub.start()).argv;
  return { argv, credDir, proc, home };
}
const configOf = (argv) => argv.filter((a, i) => argv[i - 1] === "--mcp-config");

test("a saved token goes to a 0600 file, appears in no argv, and the file is removed when the run ends", async () => {
  const { argv, credDir, proc } = await start({ token: TOKEN });
  assert.ok(!argv.join("\n").includes(TOKEN), "the token is in no argv");
  const files = configOf(argv).filter((f) => f.startsWith(`${credDir}/run/`));
  assert.equal(files.length, 1);
  assert.equal((await stat(files[0])).mode & 0o777, 0o600);
  assert.ok(readFileSync(files[0], "utf8").includes(TOKEN));
  proc.signal("SIGKILL");
  await until(async () => !existsSync(files[0]), { what: "the config file to be removed" });
});

test("a missing token leaves the connection out and the run still starts", async () => {
  const { argv, credDir } = await start({});
  assert.ok(argv.includes("--session-id") || argv.length > 0);
  assert.ok(!argv.join("\n").includes("githubcopilot"), "the connection is left out");
  assert.equal(existsSync(path.join(credDir, "run")), false);
});

test("an invalid token is treated as missing", async () => {
  const { argv, credDir } = await start({ token: "not a token" });
  assert.ok(!argv.join("\n").includes("githubcopilot"));
  assert.equal(existsSync(path.join(credDir, "run")), false);
});

test("a launch failure removes the config file", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "den-cred-home-"));
  const credDir = path.join(home, ".local", "state", "den", "credentials");
  await mkdir(credDir, { recursive: true });
  await writeFile(path.join(credDir, "github.token"), TOKEN);
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const launcher = { ...unconfinedLauncher(), launch: async () => { throw new Error("no launch"); } };
  const runtime = createClaudeRuntime({ controlRoot: "/", launcher, env: { PATH: process.env.PATH, HOME: home, DEN_CLAUDE_BIN: "claude" } });
  const cwd = await mkdtemp(path.join(tmpdir(), "den-cred-cwd-"));
  await assert.rejects(runtime.spawn({ role: "developer", cwd, prompt: "go", sessionId: SESSION, connections: [GITHUB] }), /no launch/);
  assert.deepEqual(await readdir(path.join(credDir, "run")), []);
});

test("governance closes the credentials folder, which covers the token and the run config", async () => {
  const paths = JSON.parse(readFileSync(new URL("./governance.json", import.meta.url), "utf8")).credentialPaths;
  for (const p of ["~/.local/state/den/credentials/github.token", "~/.local/state/den/credentials/run/x.json"]) {
    assert.ok(paths.some((d) => p === d || p.startsWith(`${d}/`)), `${p} is denied`);
  }
});

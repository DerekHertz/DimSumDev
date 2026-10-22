import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const moduleUrl = new URL("./codex-runtime.mjs", import.meta.url);
const runtimeModule = existsSync(moduleUrl) ? await import(moduleUrl) : {};
const SESSION = "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b10";
const CONTROL = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MODEL = "gpt-6.1-sol";
const STUB = String.raw`import {createInterface} from 'node:readline';
const mode=process.argv[2];
let n=0;
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
const input=createInterface({input:process.stdin});
input.on('line',line=>{const m=JSON.parse(line);if(!m.method||!m.id)return;
let result;
if(m.method==='initialize')result={userAgent:'codex-subprocess-fixture/0.163.0'};
else if(m.method==='model/list')result={data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null};
else if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:mode==='replace'?'replacement':m.params.threadId??'opaque-native-thread'},model:m.params.model,cwd:m.params.cwd,activePermissionProfile:{id:m.params.permissions}};
else if(m.method==='turn/start'){
 result={turn:{id:'turn-'+(++n),status:'inProgress'}};
 out({id:m.id,result});
 if(mode==='crash'){process.exitCode=7;input.close();process.stdin.destroy();return;}
 if(mode==='flood')process.stderr.write('x'.repeat(2000000));
 if(mode==='reply')setImmediate(()=>{out({method:'item/completed',params:{threadId:'opaque-native-thread',turnId:result.turn.id,item:{id:'reply-1',type:'agentMessage',text:'bounded subprocess result'}}});out({method:'turn/completed',params:{threadId:'opaque-native-thread',turn:{id:result.turn.id,status:'completed'}}});});
 return;
}else if(m.method==='turn/steer')result={turnId:'turn-'+n};
else result={};
out({id:m.id,result});
});`;

async function fixture(t, mode = "reply") {
  assert.equal(typeof runtimeModule.createCodexRuntime, "function", "the standalone production Codex CellRuntime is missing");
  const root = await mkdtemp("/tmp/den-codex-runtime-fixture-");
  const worktree = `${root}/worktree`, accountHome = `${root}/account`, stateRoot = `${accountHome}/.local/state/den/credentials/codex`, auth = `${root}/dummy-auth.json`;
  await mkdir(`${worktree}/src`, { recursive: true });
  await mkdir(`${root}/main-git`);
  await writeFile(`${worktree}/src/app.mjs`, "export const fixture = true;\n");
  await writeFile(auth, "dummy-provider-marker", { mode: 0o600 });
  await writeFile(`${root}/stub.mjs`, STUB);
  const launches = [], groups = [];
  const launcher = {
    enforced: true, scopedWrites: true,
    limits: { storage: { jobMiB: 1, outputMiB: 1 } },
    async preflight() { return { ok: true }; },
    async active(id) { return groups.some(group => group.id === id && !group.dead); },
    async launch(input) {
      launches.push(input);
      const child = spawn(process.execPath, [`${root}/stub.mjs`, mode], { env: input.env, stdio: ["pipe", "pipe", "pipe"] });
      const group = { id: input.id, unit: `fixture-${input.id}.scope`, kills: 0, dead: false,
        kill() { this.kills++; child.kill("SIGKILL"); }, exhausted() { return null; },
        async settled() { if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve)); this.dead = true; return true; } };
      groups.push(group);
      return { child, group };
    },
  };
  t.after(async () => { for (const group of groups) { group.kill(); await group.settled(); } await rm(root, { recursive: true, force: true }); });
  const runtime = runtimeModule.createCodexRuntime({ controlRoot: CONTROL, stateRoot, scratchRoot: `${root}/shell`, launcher, codexBin: process.execPath, bwrapBin: process.execPath, authFile: auth, env: { HOME: accountHome, PATH: "/usr/bin:/bin", OPENAI_API_KEY: "must-not-inherit", DEN_RUN_TOKEN: "must-not-inherit" } });
  const args = { role: "developer", cwd: worktree, project: { root: worktree, recipeFile: `${CONTROL}/.codex/agents/developer.toml` }, mainGit: `${root}/main-git`, sessionId: SESSION, runId: "c-0123456789abcdef", prompt: "Inspect the fixture." };
  return { runtime, args, root, worktree, stateRoot, launches, groups, auth, setMode(next) { mode = next; } };
}

test("standalone runtime acknowledges a native session and returns real subprocess results behind trusted launcher", async t => {
  const f = await fixture(t);
  const proc = await f.runtime.spawn(f.args);
  assert.equal(f.runtime.id, "codex");
  assert.equal(proc.runtimeSessionId, "opaque-native-thread");
  const events = [];
  for await (const event of proc.events) { events.push(event); if (event.type === "done") { proc.closeInput(); break; } }
  const exited = await proc.exited;
  assert.equal(exited.cleanupConfirmed, true);
  assert.ok(events.some(event => event.type === "reply" && event.text === "bounded subprocess result"));
  assert.ok(events.some(event => event.type === "model" && event.model === MODEL));
  assert.equal(f.launches[0].id, f.args.runId);
  assert.equal(f.launches[0].env.OPENAI_API_KEY, undefined);
  assert.equal(f.launches[0].env.DEN_RUN_TOKEN, undefined);
  assert.equal(f.launches[0].env.CODEX_HOME.startsWith(f.stateRoot), true);
  assert.ok(f.launches[0].args.includes("--strict-config"));
  assert.equal((await stat(f.launches[0].env.CODEX_HOME)).mode & 0o777, 0o700);
  assert.equal(await readFile(f.auth, "utf8"), "dummy-provider-marker");
});

test("exact native resume uses the protected persistent store and a new resource identity", async t => {
  const f = await fixture(t, "hang");
  const first = await f.runtime.spawn(f.args);
  first.signal("SIGKILL"); await first.exited;
  const second = await f.runtime.spawn({ ...f.args, runId: "c-fedcba9876543210", resume: true, runtimeSessionId: first.runtimeSessionId });
  assert.equal(second.runtimeSessionId, first.runtimeSessionId);
  assert.equal(f.launches[1].env.CODEX_HOME, f.launches[0].env.CODEX_HOME);
  assert.notEqual(f.launches[1].id, f.launches[0].id);
  second.signal("SIGKILL"); assert.equal((await second.exited).cleanupConfirmed, true);
  await assert.rejects(f.runtime.spawn({ ...f.args, resume: true, runtimeSessionId: "foreign-thread" }), /recorded native identity/);
  assert.equal(f.launches.length, 2);
});

test("forged model or recipe, missing authentication and missing resource enforcement refuse before launch", async t => {
  const f = await fixture(t);
  for (const input of [{ ...f.args, model: "gpt-6-luna" }, { ...f.args, project: { root: f.worktree, recipeFile: `${f.worktree}/.codex/agents/developer.toml` } }]) {
    await assert.rejects(f.runtime.spawn(input), /trusted role/);
  }
  const noAuth = runtimeModule.createCodexRuntime({ controlRoot: CONTROL, stateRoot: f.stateRoot, launcher: { enforced: true, scopedWrites: true, preflight: async () => ({ ok: true }) } });
  await assert.rejects(noAuth.spawn(f.args), /protected authentication/);
  assert.equal(f.launches.length, 0);
});

test("native crash settles its whole group and reports failure without fallback", async t => {
  const f = await fixture(t, "crash");
  const proc = await f.runtime.spawn(f.args);
  const exited = await proc.exited;
  assert.equal(exited.code, 7);
  assert.equal(exited.cleanupConfirmed, true);
  assert.ok(f.groups[0].kills > 0);
  assert.equal(f.launches.length, 1);
});

test("tree read owners use no product write scope and retain bridge-only delegation credentials", async t => {
  const f = await fixture(t, "hang");
  const proc = await f.runtime.spawn({ ...f.args, role: "orchestrator", model: MODEL, effort: "high", project: { root: f.worktree, recipeFile: `${CONTROL}/.codex/agents/orchestrator.toml` }, tree: { depth: 0, logicalRole: "orchestrator", execution: { mode: "read" } }, treeCredential: { url: "http://127.0.0.1:4317", token: "t".repeat(43) } });
  assert.deepEqual(f.launches[0].writeScope, { worktree: f.worktree, paths: [] });
  assert.equal(JSON.stringify(f.launches[0]).includes("t".repeat(43)), false);
  proc.signal("SIGKILL"); await proc.exited;
});

test("a tree code runner retains exact admitted file writes and its lower configured model tier", async t => {
  const f = await fixture(t, "hang");
  const proc = await f.runtime.spawn({ ...f.args, role: "runner", model: "gpt-6-luna", effort: "low", project: { root: f.worktree, recipeFile: `${CONTROL}/.codex/agents/runner.toml` }, tree: { depth: 2, logicalRole: "runner", execution: { mode: "code", scopes: ["src/app.mjs"] } }, treeCredential: { url: "http://127.0.0.1:4317", token: "t".repeat(43) } });
  assert.deepEqual(f.launches[0].writeScope, { worktree: f.worktree, paths: [`${f.worktree}/src/app.mjs`] });
  const config = await readFile(`${f.launches[0].env.CODEX_HOME}/config.toml`, "utf8");
  assert.match(config, /model = "gpt-6-luna"/);
  assert.match(config, /model_reasoning_effort = "low"/);
  proc.signal("SIGKILL"); await proc.exited;
});

test("replacement native resume IDs fail before model work and settle the new resource group", async t => {
  const f = await fixture(t, "hang");
  const proc = await f.runtime.spawn(f.args);
  proc.signal("SIGKILL"); await proc.exited;
  f.setMode("replace");
  await assert.rejects(f.runtime.spawn({ ...f.args, runId: "c-fedcba9876543210", resume: true, runtimeSessionId: proc.runtimeSessionId }), /thread acknowledgement/);
  assert.equal(f.groups[1].dead, true);
  assert.equal(f.launches.length, 2);
});

test("uncertain resource settlement keeps the session locked against reuse", async t => {
  const f = await fixture(t, "hang");
  const proc = await f.runtime.spawn(f.args);
  const settle = f.groups[0].settled.bind(f.groups[0]);
  f.groups[0].settled = async () => { await settle(); return false; };
  proc.signal("SIGKILL");
  assert.equal((await proc.exited).cleanupConfirmed, false);
  await assert.rejects(f.runtime.spawn({ ...f.args, runId: "c-fedcba9876543210", resume: true, runtimeSessionId: proc.runtimeSessionId }), /active.*resource group/);
  assert.equal(f.launches.length, 1);
});

test("aggregate native stderr output is bounded and whole-group cleanup remains confirmed", async t => {
  const f = await fixture(t, "flood");
  const proc = await f.runtime.spawn(f.args);
  const exited = await proc.exited;
  assert.equal(exited.resourceLimit, "output");
  assert.equal(exited.cleanupConfirmed, true);
  assert.equal(f.launches.length, 1);
});

test("direct writable roles admit only their detached git metadata and shared objects", async t => {
  const f = await fixture(t, "hang");
  await mkdir(`${f.args.mainGit}/objects`);
  await mkdir(`${f.args.mainGit}/worktrees/owned`, { recursive: true });
  await writeFile(`${f.args.mainGit}/worktrees/owned/HEAD`, "a".repeat(40) + "\n");
  await writeFile(`${f.worktree}/.git`, `gitdir: ${f.args.mainGit}/worktrees/owned\n`);
  const proc = await f.runtime.spawn(f.args);
  const config = await readFile(`${f.launches[0].env.CODEX_HOME}/config.toml`, "utf8");
  assert.ok(config.includes(`"${f.args.mainGit}/objects" = "write"`));
  assert.ok(config.includes(`"${f.args.mainGit}/worktrees/owned" = "write"`));
  assert.ok(config.includes(`"${f.args.mainGit}/refs" = "read"`));
  assert.ok(!config.includes(`"${f.args.mainGit}/worktrees" = "write"`));
  proc.signal("SIGKILL"); await proc.exited;
  await writeFile(`${f.worktree}/.git`, `gitdir: ${f.args.mainGit}/refs\n`);
  await assert.rejects(f.runtime.spawn({ ...f.args, sessionId: "0b8f1c1e-5c1a-4c0e-9a55-3f2d9e7a4b11" }), /exact detached git metadata/);
  assert.equal(f.launches.length, 1);
});

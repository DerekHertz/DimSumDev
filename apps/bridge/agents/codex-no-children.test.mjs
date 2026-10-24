import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import { compileCodexPermissions, renderCodexConfig } from "./codex-permissions.mjs";
import { findCodexNative } from "./codex-sandbox-plan.mjs";

// A fake model captures the real CLI's advertised tools. No account or model call.
async function advertisedTools(native, enableAgents) {
  const root = mkdtempSync(`${os.tmpdir()}/den-no-child-`);
  for (const dir of ["work", "native", "home"]) mkdirSync(`${root}/${dir}`, { mode: 0o700 });
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: {
      id: "resp_fixture", object: "response", status: "completed", output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } })}\n\n`);
  });
  let child;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const compiled = compileCodexPermissions({ profileId: "fixture", worktree: `${root}/work`, nativeStore: `${root}/native`,
      policy: { version: 1, readRoots: [`${root}/work`], writeRoots: [], readOnlyPaths: [], denyPaths: [], denyCommands: [], hosts: [] } });
    writeFileSync(`${root}/native/config.toml`, renderCodexConfig({ ...compiled.config,
      model: "gpt-6.1-sol", model_provider: "fixture",
      model_providers: { fixture: { name: "fixture", base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: "responses", requires_openai_auth: false } },
      ...(enableAgents ? { agents: { enabled: true } } : {}),
    }));
    child = spawn(native.codexBin, ["exec", "--skip-git-repo-check", "--ephemeral", "--json", "Reply OK."], {
      cwd: `${root}/work`, env: { PATH: process.env.PATH, HOME: `${root}/home`, CODEX_HOME: `${root}/native`, LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 1, "the fake model must receive exactly one native request");
    return requests[0].input.filter(item => item.type === "additional_tools").flatMap(item => item.tools)
      .flatMap(namespace => (namespace.tools ?? []).map(tool => `${namespace.name}.${tool.name}`));
  } finally {
    child?.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

test("compiled profile removes native delegation tools before the model receives them", { timeout: 40000 }, async t => {
  const native = findCodexNative();
  if (native.reason) return t.skip(native.reason);
  const control = await advertisedTools(native, true);
  assert.ok(control.includes("collaboration.spawn_agent"), "positive control must expose the original bug");
  const bounded = await advertisedTools(native, false);
  for (const name of ["spawn_agent", "followup_task", "send_message", "interrupt_agent", "list_agents", "wait_agent"]) {
    assert.ok(!bounded.includes(`collaboration.${name}`), `${name} must be unavailable before execution`);
  }
  assert.ok(bounded.includes("functions.exec"), "ordinary sandboxed shell access stays available");
});

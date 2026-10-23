// hardening/12 fix round: the default docker adapter (ADR 0031 decision 1) runs /usr/bin/docker against the user's rootless socket,
// never the first `docker` on PATH (Docker Desktop's can win). The exec seam is injected, so no real docker runs here.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDocker, ensureAgentImage, readPins } from "./agent-image.mjs";

const DIGEST = `sha256:${"ab12".repeat(16)}`;

describe("createDocker: the default adapter", () => {
  const harness = ({ env = {}, socket = true, uid = 1000 } = {}) => {
    const calls = [];
    const exec = async (file, args, opts) => (calls.push({ file, args, opts }), { ok: true, out: "x\n", err: "" });
    const docker = createDocker({ env, exec, uid, exists: () => socket });
    return { calls, docker };
  };

  test("runs /usr/bin/docker, not docker from PATH", async () => {
    const { calls, docker } = harness({ env: { PATH: "/opt/desktop/bin:/usr/bin" } });
    await docker(["version"]);
    assert.equal(calls[0].file, "/usr/bin/docker");
    assert.deepEqual(calls[0].args, ["version"]);
  });

  test("points DOCKER_HOST at the rootless socket under XDG_RUNTIME_DIR", async () => {
    const { calls, docker } = harness({ env: { XDG_RUNTIME_DIR: "/run/user/4242" } });
    await docker(["info"]);
    assert.equal(calls[0].opts.env.DOCKER_HOST, "unix:///run/user/4242/docker.sock");
  });

  test("falls back to /run/user/<uid> without XDG_RUNTIME_DIR", async () => {
    const { calls, docker } = harness({ uid: 1234 });
    await docker(["info"]);
    assert.equal(calls[0].opts.env.DOCKER_HOST, "unix:///run/user/1234/docker.sock");
  });

  test("an explicit DOCKER_HOST in the caller's env is kept", async () => {
    const { calls, docker } = harness({ env: { DOCKER_HOST: "unix:///custom/d.sock", XDG_RUNTIME_DIR: "/run/user/1" } });
    await docker(["info"]);
    assert.equal(calls[0].opts.env.DOCKER_HOST, "unix:///custom/d.sock");
  });

  test("a missing socket is a failed call that names the socket, and docker is not run", async () => {
    const { calls, docker } = harness({ socket: false, env: { XDG_RUNTIME_DIR: "/run/user/7" } });
    const out = await docker(["version"]);
    assert.equal(out.ok, false);
    assert.match(out.err, /\/run\/user\/7\/docker\.sock/);
    assert.deepEqual(calls, []);
  });

  test("only build gets the long timeout; probes get the short one", async () => {
    const { calls, docker } = harness();
    await docker(["build", "--quiet", "."]);
    await docker(["version"]);
    await docker(["image", "inspect", "sha256:1"]);
    assert.equal(calls[0].opts.timeout, 900_000);
    assert.ok(calls[1].opts.timeout <= 120_000 && calls[2].opts.timeout <= 120_000);
  });

  test("ensureAgentImage skips with the socket in the reason when there is none", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "agent-image-sock-"));
    try {
      const file = path.join(tmp, "Dockerfile");
      await writeFile(file, `FROM node:22@${DIGEST}\nRUN npm install -g @anthropic-ai/claude-code@2.1.293\n`);
      const docker = createDocker({ env: { XDG_RUNTIME_DIR: "/run/user/7" }, exec: async () => assert.fail("docker must not run"), exists: () => false });
      const out = await ensureAgentImage({ dockerfile: file, stateDir: tmp, docker });
      assert.match(out.skipped, /\/run\/user\/7\/docker\.sock/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("ensureAgentImage record and readPins hardening", () => {
  test("a recorded imageId that is not a sha256 id is treated as no record (never handed to docker)", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "agent-image-rec-"));
    try {
      const file = path.join(tmp, "Dockerfile");
      await writeFile(file, `FROM node:22@${DIGEST}\nRUN npm install -g @anthropic-ai/claude-code@2.1.293\n`);
      await writeFile(path.join(tmp, "agent-image.json"), JSON.stringify({ key: "k", imageId: "--rm; evil" }));
      const calls = [];
      const docker = async (args) => (calls.push(args), args[0] === "build" ? { ok: true, out: `sha256:${"1".repeat(64)}\n`, err: "" } : { ok: true, out: "", err: "" });
      const out = await ensureAgentImage({ dockerfile: file, stateDir: tmp, docker });
      assert.equal(out.built, true);
      assert.equal(calls.some((a) => a.includes("--rm; evil")), false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("the CLI version is read from the ARG or install line, not from a comment", () => {
    const text = `FROM node:22@${DIGEST}\n# was @anthropic-ai/claude-code@1.0.0, bump with ARG CLAUDE_CODE_VERSION=1.1.1\nARG CLAUDE_CODE_VERSION=2.1.300\nRUN npm install -g @anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}\n`;
    assert.equal(readPins(text).cliVersion, "2.1.300");
    const onlyComment = `FROM node:22@${DIGEST}\n# npm install -g @anthropic-ai/claude-code@2.1.293\nRUN echo hi\n`;
    assert.throws(() => readPins(onlyComment), /claude|cli|version/i);
  });
});

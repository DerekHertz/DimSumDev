// hardening/12: den:install and den:update build the agent image (apps/bridge/agents/image/Dockerfile, in the release being installed)
// into the rootless daemon when its Dockerfile changed, and record the image id in the release as releases/<sha12>/agent-image.json
// ({ imageId, key, ... }). Same harness as den-service.test.mjs: a temporary origin and state folder, the systemd calls, the build box
// and `npm ci` faked, plus a fake `docker` passed as createDen({ docker }): docker(args) -> { ok, out, err }. The daemon is probed with
// `docker version` or `docker info`. The real run is the user's.
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDen, DenServiceError } from "./den-service.mjs";
import { createReleases } from "../build/releases.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const LOCK = '{"name":"x","lockfileVersion":3,"packages":{}}\n';
const DOCKERFILE_PATH = "apps/bridge/agents/image/Dockerfile";
const dockerfile = (cli) => `FROM node:22-bookworm-slim@sha256:${"ab12".repeat(16)}\nRUN npm install -g @anthropic-ai/claude-code@${cli}\n`;

const fakeBox = (calls) => ({
  async build({ folder }) {
    calls.push(folder);
    await mkdir(path.join(folder, "apps/ui/dist"), { recursive: true });
    await writeFile(path.join(folder, "apps/ui/dist/index.html"), "ui");
    return { ok: true, files: 1, bytes: 2, tail: "" };
  },
});

describe("den:install and den:update build the agent image", () => {
  let tmp, origin, checkout, state, unitDir, lines, sysCalls, boxCalls, dockerCalls, builds, daemon, buildOk, images;
  const commit = async (files, message) => {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(origin, rel)), { recursive: true });
      await writeFile(path.join(origin, rel), text);
    }
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "--allow-empty", "-m", message);
    git(checkout, "fetch", "-q");
    git(checkout, "reset", "-q", "--hard", "origin/main");
    return git(origin, "rev-parse", "HEAD");
  };
  const fakeDocker = async (args) => {
    dockerCalls.push(args);
    if (!daemon) return { ok: false, out: "", err: "Cannot connect to the Docker daemon" };
    if (args[0] === "version" || args[0] === "info") return { ok: true, out: "27.0.0\n", err: "" };
    if (args[0] === "build") {
      if (!buildOk) return { ok: false, out: "", err: "npm ERR! network" };
      builds.push(args);
      const id = `sha256:${String(builds.length).padStart(64, "0")}`;
      images.add(id);
      return { ok: true, out: `${id}\n`, err: "" };
    }
    const ref = args.at(-1);
    if (/^sha256:/.test(ref)) return images.has(ref) ? { ok: true, out: `${ref}\n`, err: "" } : { ok: false, out: "", err: "No such image" };
    return images.size ? { ok: true, out: `${[...images].at(-1)}\n`, err: "" } : { ok: false, out: "", err: "No such image" };
  };
  const den = (over = {}) => createDen({
    env: { HOME: tmp, PATH: "/usr/bin:/bin" }, say: (line) => lines.push(line), node: "/usr/bin/node", repo: checkout, stateDir: state, unitDir,
    bus: { env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" } }, bwrap: "/usr/bin/bwrap",
    systemctl: async (args) => (sysCalls.push(args.join(" ")), { ok: true, out: "", err: "" }),
    answers: async () => true,
    docker: fakeDocker,
    releases: createReleases({ stateDir: state, repo: checkout, main: "origin/main", box: fakeBox(boxCalls), npm: async (cwd) => { await mkdir(path.join(cwd, "node_modules")); } }),
    ...over,
  });
  const record = (sha) => JSON.parse(readFileSync(path.join(state, "releases", sha.slice(0, 12), "agent-image.json"), "utf8"));
  const current = () => readlinkSync(path.join(state, "bridge", "current")).split("/").pop();

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "den-image-"));
    origin = path.join(tmp, "origin");
    await mkdir(origin);
    git(tmp, "init", "-q", "-b", "main", origin);
    await writeFile(path.join(origin, "package-lock.json"), LOCK);
    await writeFile(path.join(origin, "package.json"), '{"name":"x"}\n');
    await writeFile(path.join(origin, "src.txt"), "c1\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "c1");
    git(tmp, "clone", "-q", origin, path.join(tmp, "checkout"));
    checkout = path.join(tmp, "checkout");
  });
  beforeEach(async () => {
    state = path.join(tmp, `state-${Math.random().toString(36).slice(2)}`);
    unitDir = path.join(tmp, `units-${Math.random().toString(36).slice(2)}`);
    lines = [];
    sysCalls = [];
    boxCalls = [];
    dockerCalls = [];
    builds = [];
    images = new Set();
    daemon = true;
    buildOk = true;
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  test("install builds the image once and records its id in the release", async () => {
    const sha = await commit({ [DOCKERFILE_PATH]: dockerfile("2.1.293") }, "the image");
    await den().install();
    assert.equal(builds.length, 1);
    const saved = record(sha);
    assert.equal(saved.imageId, `sha256:${"1".padStart(64, "0")}`);
    assert.equal(typeof saved.key, "string");
    assert.ok(lines.some((l) => /agent image/i.test(l) && l.startsWith("> ")), "the plan has an agent image step");
  });

  test("update builds nothing when the new release has the same Dockerfile, and records the same id in it", async () => {
    const first = await commit({ [DOCKERFILE_PATH]: dockerfile("2.1.293") }, "the image");
    await den().install();
    const second = await commit({ "src.txt": "c2\n" }, "a change that is not the image");
    await den().update("--main");
    assert.notEqual(second, first);
    assert.equal(builds.length, 1, "no second docker build");
    assert.equal(record(second).imageId, record(first).imageId);
    assert.equal(record(second).key, record(first).key);
  });

  test("update builds again when the CLI pin changed, records the new id in the new release only", async () => {
    const first = await commit({ [DOCKERFILE_PATH]: dockerfile("2.1.293") }, "the image");
    await den().install();
    const second = await commit({ [DOCKERFILE_PATH]: dockerfile("2.1.294") }, "bump the CLI");
    await den().update("--main");
    assert.equal(builds.length, 2);
    assert.notEqual(record(second).imageId, record(first).imageId);
    assert.notEqual(record(second).key, record(first).key);
    assert.equal(record(first).imageId, `sha256:${"1".padStart(64, "0")}`, "the older release keeps the id it ran with");
  });

  test("update builds again when another line of the Dockerfile changed", async () => {
    await commit({ [DOCKERFILE_PATH]: dockerfile("2.1.293") }, "the image");
    await den().install();
    await commit({ [DOCKERFILE_PATH]: `${dockerfile("2.1.293")}RUN apt-get install -y curl\n` }, "another line");
    await den().update("--main");
    assert.equal(builds.length, 2);
  });

  test("a failed image build fails the update before the links switch or the service restarts", async () => {
    const first = await commit({ [DOCKERFILE_PATH]: dockerfile("2.1.293") }, "the image");
    await den().install();
    await commit({ [DOCKERFILE_PATH]: dockerfile("2.1.294") }, "bump the CLI");
    sysCalls.length = 0;
    buildOk = false;
    await assert.rejects(den().update("--main"), (err) => err instanceof DenServiceError && /image/i.test(err.message) && /network/.test(err.message));
    assert.equal(current(), first.slice(0, 12), "the running release is untouched");
    assert.deepEqual(sysCalls.filter((c) => c.startsWith("restart")), []);
  });

  test("a host with no docker daemon installs and updates anyway; the image step says it was skipped", async () => {
    daemon = false;
    const sha = await commit({ [DOCKERFILE_PATH]: dockerfile("2.1.293") }, "the image");
    await den().install();
    assert.equal(builds.length, 0);
    assert.equal(existsSync(path.join(state, "releases", sha.slice(0, 12), "agent-image.json")), false);
    assert.ok(lines.some((l) => /skipped/i.test(l) && /docker|daemon/i.test(l)), lines.join("\n"));
    assert.equal(current(), sha.slice(0, 12));
    await commit({ "src.txt": "c3\n" }, "later");
    await den().update("--main");
  });

  test("a release without the Dockerfile skips the image step without calling docker at all", async () => {
    git(origin, "rm", "-q", "--ignore-unmatch", DOCKERFILE_PATH);
    git(origin, "commit", "-q", "--allow-empty", "-m", "no image yet");
    git(checkout, "fetch", "-q");
    git(checkout, "reset", "-q", "--hard", "origin/main");
    const calls = [];
    await den({ docker: async (args) => (calls.push(args), { ok: false, out: "", err: "docker must not be called" }) }).install();
    assert.deepEqual(calls, []);
  });
});

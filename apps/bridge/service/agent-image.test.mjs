// hardening/12 (ADR 0031 decision 2): the agent image is a Dockerfile in the repo, its base pinned by digest and the Claude CLI at one
// version, built into the rootless daemon only when that Dockerfile (the CLI pin lives in it) changed. Everything here is offline: the
// docker CLI is a fake `docker(args) -> { ok, out, err }`, the same seam den-service.mjs takes. Interface under test, from
// ./agent-image.mjs:
//   readPins(dockerfileText) -> { baseImage, baseDigest, cliVersion }     throws AgentImageError for an unpinned base or CLI
//   imageKey(dockerfileText) -> string                                    a hash: equal text gives an equal key, any change a new one
//   planImage({ dockerfileText, recorded, present }) -> { build, reason, key }
//        recorded: { key, imageId } | null (the last build), present: whether the daemon still has recorded.imageId
//   ensureAgentImage({ dockerfile, stateDir, docker, say? }) -> { built, imageId, key } | { skipped: reason }
//        probes the daemon with `docker version` or `docker info`; no daemon is skipped, not an error. Builds with `docker build`
//        against that Dockerfile and reads the id back. Remembers the last build in stateDir so a second call can skip.
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentImageError, ensureAgentImage, imageKey, planImage, readPins } from "./agent-image.mjs";

const REAL_DOCKERFILE = fileURLToPath(new URL("../agents/image/Dockerfile", import.meta.url));
const DIGEST = `sha256:${"ab12".repeat(16)}`;
const dockerfile = ({ from = `node:22-bookworm-slim@${DIGEST}`, cli = "2.1.293", extra = "" } = {}) =>
  `FROM ${from}\nRUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates\nRUN npm install -g @anthropic-ai/claude-code@${cli}\n${extra}USER node\n`;

describe("the Dockerfile in the repo", () => {
  test("exists at apps/bridge/agents/image/Dockerfile", () => {
    assert.equal(existsSync(REAL_DOCKERFILE), true);
  });

  test("every FROM is pinned by a sha256 digest (and none says latest)", () => {
    const froms = readFileSync(REAL_DOCKERFILE, "utf8").split("\n").filter((l) => /^\s*FROM\s/i.test(l));
    assert.ok(froms.length >= 1);
    for (const line of froms) {
      assert.match(line, /@sha256:[0-9a-f]{64}(\s|$)/, line);
      assert.doesNotMatch(line, /:latest/, line);
    }
  });

  test("it pins the Claude CLI to an exact version and reads back as a base digest plus a version", () => {
    const pins = readPins(readFileSync(REAL_DOCKERFILE, "utf8"));
    assert.match(pins.baseDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(pins.cliVersion, /^\d+\.\d+\.\d+$/);
  });
});

describe("readPins", () => {
  test("reads the base image, its digest and a CLI version written in the install line", () => {
    assert.deepEqual(readPins(dockerfile()), { baseImage: "node:22-bookworm-slim", baseDigest: DIGEST, cliVersion: "2.1.293" });
  });

  test("reads the CLI version from an ARG the install line uses", () => {
    const text = `FROM node:22-bookworm-slim@${DIGEST}\nARG CLAUDE_CODE_VERSION=2.1.300\nRUN npm install -g @anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}\n`;
    assert.equal(readPins(text).cliVersion, "2.1.300");
  });

  test("refuses a base that is a tag only, or latest, or no tag at all", () => {
    for (const from of ["node:22-bookworm-slim", "node:latest", "node", `node:22@sha256:${"a".repeat(63)}`, "node:22@sha1:abc"]) {
      assert.throws(() => readPins(dockerfile({ from })), (err) => err instanceof AgentImageError && /digest/i.test(err.message), from);
    }
  });

  test("refuses a CLI that is not pinned to a version", () => {
    for (const cli of ["latest", "next", "^2.1.0", ""]) {
      assert.throws(() => readPins(dockerfile({ cli })), (err) => err instanceof AgentImageError && /claude|cli|version/i.test(err.message), cli);
    }
    const bare = `FROM node:22@${DIGEST}\nRUN npm install -g @anthropic-ai/claude-code\n`;
    assert.throws(() => readPins(bare), AgentImageError);
  });
});

describe("imageKey", () => {
  test("is the same for the same Dockerfile", () => {
    assert.equal(imageKey(dockerfile()), imageKey(dockerfile()));
  });

  test("changes when only the CLI pin changes", () => {
    assert.notEqual(imageKey(dockerfile({ cli: "2.1.293" })), imageKey(dockerfile({ cli: "2.1.294" })));
  });

  test("changes when only the base digest changes", () => {
    const other = `sha256:${"cd34".repeat(16)}`;
    assert.notEqual(imageKey(dockerfile()), imageKey(dockerfile({ from: `node:22-bookworm-slim@${other}` })));
  });

  test("changes when any other Dockerfile line changes", () => {
    assert.notEqual(imageKey(dockerfile()), imageKey(dockerfile({ extra: "RUN apt-get install -y curl\n" })));
  });
});

describe("planImage: rebuild only when the CLI pin or the Dockerfile changed", () => {
  const text = dockerfile();
  const key = imageKey(text);

  test("no earlier build: build", () => {
    assert.equal(planImage({ dockerfileText: text, recorded: null, present: false }).build, true);
  });

  test("the recorded build has this Dockerfile's key and the daemon still has it: no build", () => {
    const plan = planImage({ dockerfileText: text, recorded: { key, imageId: "sha256:1" }, present: true });
    assert.equal(plan.build, false);
    assert.equal(plan.key, key);
  });

  test("the CLI pin changed: build", () => {
    const recorded = { key: imageKey(dockerfile({ cli: "2.1.292" })), imageId: "sha256:1" };
    assert.equal(planImage({ dockerfileText: text, recorded, present: true }).build, true);
  });

  test("the Dockerfile changed: build", () => {
    const recorded = { key: imageKey(dockerfile({ extra: "RUN true\n" })), imageId: "sha256:1" };
    assert.equal(planImage({ dockerfileText: text, recorded, present: true }).build, true);
  });

  test("same key but the daemon no longer has the image (pruned): build", () => {
    assert.equal(planImage({ dockerfileText: text, recorded: { key, imageId: "sha256:1" }, present: false }).build, true);
  });
});

describe("ensureAgentImage", () => {
  let tmp, state, file, calls, builds, images, daemon, buildOk, lines;
  const fakeDocker = async (args) => {
    calls.push(args);
    if (args[0] === "version" || args[0] === "info") return daemon ? { ok: true, out: "27.0.0\n", err: "" } : { ok: false, out: "", err: "Cannot connect to the Docker daemon" };
    if (!daemon) return { ok: false, out: "", err: "Cannot connect to the Docker daemon" };
    if (args[0] === "build") {
      if (!buildOk) return { ok: false, out: "", err: "npm ERR! 404" };
      builds.push(args);
      const id = `sha256:${String(builds.length).padStart(64, "0")}`;
      images.add(id);
      return { ok: true, out: `${id}\n`, err: "" };
    }
    // `docker image inspect --format {{.Id}} <ref>` or `docker inspect ...`: the id of the newest build, or failure for an image the daemon lost.
    const ref = args.at(-1);
    const known = [...images];
    if (/^sha256:/.test(ref)) return images.has(ref) ? { ok: true, out: `${ref}\n`, err: "" } : { ok: false, out: "", err: `No such image: ${ref}` };
    return known.length ? { ok: true, out: `${known.at(-1)}\n`, err: "" } : { ok: false, out: "", err: `No such image: ${ref}` };
  };
  const ensure = () => ensureAgentImage({ dockerfile: file, stateDir: state, docker: fakeDocker, say: (l) => lines.push(l) });

  beforeEach(async () => {
    tmp ??= await mkdtemp(path.join(tmpdir(), "agent-image-"));
    state = await mkdtemp(path.join(tmp, "state-"));
    file = path.join(await mkdtemp(path.join(tmp, "ctx-")), "Dockerfile");
    await writeFile(file, dockerfile());
    calls = [];
    builds = [];
    images = new Set();
    daemon = true;
    buildOk = true;
    lines = [];
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  test("the first call builds the Dockerfile and returns the image id and the key", async () => {
    const out = await ensure();
    assert.equal(out.built, true);
    assert.equal(builds.length, 1);
    assert.ok(builds[0].join(" ").includes(path.dirname(file)), "docker build is pointed at the Dockerfile's folder or file");
    assert.equal(out.imageId, `sha256:${"1".padStart(64, "0")}`);
    assert.equal(out.key, imageKey(dockerfile()));
  });

  test("a second call with the same Dockerfile builds nothing and returns the same id", async () => {
    const first = await ensure();
    const again = await ensure();
    assert.equal(builds.length, 1);
    assert.equal(again.built, false);
    assert.equal(again.imageId, first.imageId);
  });

  test("a bumped CLI pin builds again and returns a new id", async () => {
    const first = await ensure();
    await writeFile(file, dockerfile({ cli: "2.1.294" }));
    const next = await ensure();
    assert.equal(builds.length, 2);
    assert.equal(next.built, true);
    assert.notEqual(next.imageId, first.imageId);
  });

  test("another changed Dockerfile line builds again", async () => {
    await ensure();
    await writeFile(file, dockerfile({ extra: "RUN apt-get install -y curl\n" }));
    await ensure();
    assert.equal(builds.length, 2);
  });

  test("an image the daemon lost is built again even though the Dockerfile is the same", async () => {
    await ensure();
    images.clear();
    const out = await ensure();
    assert.equal(builds.length, 2);
    assert.equal(out.built, true);
  });

  test("a Dockerfile with an unpinned base is refused before docker is asked to build", async () => {
    await writeFile(file, dockerfile({ from: "node:22-bookworm-slim" }));
    await assert.rejects(ensure(), AgentImageError);
    assert.equal(builds.length, 0);
  });

  test("a failed build throws, names the reason, and keeps the last good image as the recorded one", async () => {
    const good = await ensure();
    await writeFile(file, dockerfile({ cli: "2.1.999" }));
    buildOk = false;
    await assert.rejects(ensure(), (err) => err instanceof AgentImageError && /404/.test(err.message));
    buildOk = true;
    await writeFile(file, dockerfile());
    const back = await ensure();
    assert.equal(back.built, false, "the failed attempt did not replace the record");
    assert.equal(back.imageId, good.imageId);
  });

  test("no daemon is skipped with a reason, not an error, and nothing is built", async () => {
    daemon = false;
    const out = await ensure();
    assert.match(String(out.skipped), /docker|daemon/i);
    assert.equal(out.imageId, undefined);
    assert.equal(builds.length, 0);
  });
});

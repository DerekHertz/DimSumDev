// hardening/12 (ADR 0031 decision 2): the agent image. A Dockerfile in the repo pins its base by digest and the Claude CLI at one version;
// den:install and den:update build it into the rootless daemon only when that Dockerfile (the CLI pin lives in it) changed.
// `docker(args)` -> { ok, out, err } is injected, so everything here is testable offline. Nothing under apps/bridge routes imports this.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class AgentImageError extends Error {}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const RECORD = "agent-image.json";

/** The base image, its digest and the CLI version a Dockerfile pins. Throws for a base without a sha256 digest or a CLI without an exact version. */
export function readPins(text) {
  let base;
  for (const line of text.split("\n")) {
    if (!/^\s*FROM\s/i.test(line)) continue;
    const ref = line.trim().split(/\s+/).slice(1).find((word) => !word.startsWith("--"));
    const [baseImage, baseDigest] = String(ref).split("@");
    if (!DIGEST.test(baseDigest ?? "")) throw new AgentImageError(`the base image ${JSON.stringify(ref)} is not pinned by a sha256 digest (name@sha256:<64 hex>)`);
    base ??= { baseImage, baseDigest };
  }
  if (!base) throw new AgentImageError("the Dockerfile has no FROM line (a base image pinned by digest)");
  const install = text.match(/@anthropic-ai\/claude-code(?:@(\S*))?/);
  let cliVersion = install?.[1] ?? "";
  const arg = cliVersion.match(/^\$\{?(\w+)\}?$/);
  if (arg) cliVersion = text.match(new RegExp(`^\\s*ARG\\s+${arg[1]}=(\\S+)`, "m"))?.[1] ?? "";
  if (!SEMVER.test(cliVersion)) throw new AgentImageError(`the Claude CLI is not pinned to an exact version (got ${JSON.stringify(cliVersion)}); use @anthropic-ai/claude-code@X.Y.Z`);
  return { ...base, cliVersion };
}

/** A hash of the Dockerfile text: a CLI bump or any other line changes it. */
export const imageKey = (text) => createHash("sha256").update(text).digest("hex");

/** Build when nothing was recorded, the recorded key is another Dockerfile's, or the daemon lost the image. */
export function planImage({ dockerfileText, recorded, present }) {
  const key = imageKey(dockerfileText);
  if (!recorded) return { build: true, reason: "no earlier build", key };
  if (recorded.key !== key) return { build: true, reason: "the Dockerfile (or the CLI pin in it) changed", key };
  if (!present) return { build: true, reason: "the daemon no longer has the image", key };
  return { build: false, reason: "the Dockerfile is unchanged", key };
}

const tail = (text) => String(text).trim().slice(-500);

/** Build the Dockerfile if the plan says so. Returns { built, imageId, key } or { skipped: reason } (no Dockerfile, or no reachable daemon). */
export async function ensureAgentImage({ dockerfile, stateDir, docker, say = () => {} }) {
  let text;
  try {
    text = await readFile(dockerfile, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { skipped: `no Dockerfile at ${dockerfile}` };
    throw err;
  }
  readPins(text);
  if (!(await docker(["version", "--format", "{{.Server.Version}}"])).ok) return { skipped: "no docker daemon answers (docker version failed)" };

  const recordFile = path.join(stateDir, RECORD);
  const recorded = JSON.parse(await readFile(recordFile, "utf8").catch(() => "null"));
  const present = recorded?.imageId ? (await docker(["image", "inspect", "--format", "{{.Id}}", recorded.imageId])).ok : false;
  const plan = planImage({ dockerfileText: text, recorded, present });
  if (!plan.build) return { built: false, imageId: recorded.imageId, key: plan.key };

  say(`  building the agent image: ${plan.reason}`);
  const built = await docker(["build", "--quiet", "--tag", `den-agent:${plan.key.slice(0, 12)}`, "--file", dockerfile, path.dirname(dockerfile)]);
  if (!built.ok) throw new AgentImageError(`agent image build failed: ${tail(built.err || built.out)}`);
  const imageId = built.out.trim().split("\n").at(-1);
  if (!/^sha256:[0-9a-f]+$/.test(imageId)) throw new AgentImageError(`agent image build printed no image id: ${tail(built.out)}`);
  await mkdir(stateDir, { recursive: true });
  await writeFile(recordFile, `${JSON.stringify({ key: plan.key, imageId })}\n`);
  return { built: true, imageId, key: plan.key };
}

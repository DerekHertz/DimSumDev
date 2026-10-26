// trust-ladder/03: the verify/fix loop through the bridge entry point. The Profile (agents/profile.mjs) sets how many
// independent qa verify passes a candidate gets (verifiers per class) and the loop cap; flipping it needs no restart.
// Expected counts are literals from an injected table, not a recomputation of the code under test.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeBridge, until, FEATURE } from "../agents/host-test-helpers.mjs";
import { createProfile } from "../agents/profile.mjs";

const REF = `${FEATURE}/08-plain`;
const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=fx", "-c", "user.email=fx@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();

const common = { maxConcurrent: 2, leafTier: "haiku", splitAboveTokens: null };
const TABLE = {
  lean: { ...common, verifiers: { standard: 1, riskPath: 1, ui: 1 }, verifierLoopCap: 2 },
  full: { ...common, verifiers: { standard: 1, riskPath: 4, ui: 3 }, verifierLoopCap: 4 },
};

function fakeGitHost(root) {
  const h = { files: ["a.txt"], pr: null, remote: null };
  return Object.assign(h, {
    mainSha: async () => git(root, "rev-parse", "HEAD"),
    descends: async ({ base, sha }) => git(root, "merge-base", base, sha) === base,
    changed: async () => h.files,
    addsSecret: async () => false,
    conflicts: async () => [],
    risk: async () => ({ clean: true, hits: [] }),
    push: async (a) => void (h.remote = a),
    findPr: async () => (h.pr ? { ...h.pr } : null),
    openPr: async () => void (h.pr = { number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", sha: h.remote.sha }),
    prState: async () => ({ ...h.pr, mergeable: "MERGEABLE", checks: [{ name: "test", done: true, ok: true }] }),
    waitChecks: async () => {},
    merge: async () => void (h.pr.state = "MERGED"),
  });
}

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function setup(name, files) {
  let host;
  const profile = createProfile({ table: TABLE });
  await profile.set(name);
  const t = await makeBridge({ gitHost: (root) => (host = fakeGitHost(root)), extra: { profile } });
  cleanups.push(() => t.close());
  host.files = files;
  const job = async () => (await t.state()).deliveries?.at(-1);
  // Works every spawn in turn until the delivery stops; reply(role, n, rec) is the agent's last message (n counts that role's runs).
  const drive = async (reply) => {
    const seen = {};
    const roles = [];
    const from = t.fake.spawns.length;
    for (;;) {
      const next = await until(async () => {
        if (t.fake.spawns.length > from + roles.length) return { rec: t.fake.spawns[from + roles.length] };
        const j = await job();
        return j && j.state !== "running" && !j.live ? { stop: j } : null;
      }, { what: "the next spawn or the end", ms: 5000 });
      if (next.stop) return { roles, job: next.stop };
      const { rec } = next;
      const role = rec.args.role;
      roles.push(role);
      seen[role] = (seen[role] ?? 0) + 1;
      const text = reply?.(role, seen[role], rec) ?? "VERDICT: pass";
      if (role === "developer") {
        writeFileSync(path.join(rec.args.cwd, `dev-${seen[role]}.txt`), "x\n");
        git(rec.args.cwd, "add", "-A");
        git(rec.args.cwd, "commit", "-q", "-m", "work");
      }
      rec.emit({ type: "reply", text });
      rec.emit({ type: "done", ok: true });
    }
  };
  return { ...t, host, profile, job, drive };
}

const count = (roles, role) => roles.filter((r) => r === role).length;

test("lean and full run different verifier counts for the same kind of ticket", async () => {
  const classes = [["a plain code change", ["a.txt"], 1, 1], ["a risk-path change", ["scripts/x.mjs"], 1, 4], ["a UI change", ["apps/ui/panel.txt"], 1, 3]];
  for (const [what, files, lean, full] of classes) {
    for (const [name, want] of [["lean", lean], ["full", full]]) {
      const t = await setup(name, files);
      assert.equal((await t.post("/deliveries", { ref: REF })).status, 201);
      const { roles } = await t.drive();
      assert.equal(count(roles, "qa"), want, `${what} under ${name}: ${roles.join(",")}`);
      await cleanups.pop()();
    }
  }
});

test("flipping the Profile changes the next delivery's verifier count on the same bridge, with no restart", async () => {
  const t = await setup("full", ["apps/ui/panel.txt"]);
  assert.equal((await t.post("/deliveries", { ref: REF })).status, 201);
  assert.equal(count((await t.drive()).roles, "qa"), 3, "the first delivery runs under full");
  await t.profile.set("lean");
  assert.equal((await t.post("/deliveries", { ref: `${FEATURE}/07-bumpable` })).status, 201);
  assert.equal(count((await t.drive()).roles, "qa"), 1, "the second delivery, on the same bridge, reads lean");
});

test("a finding goes to the developer's fix round with its repro steps, and the loop stops at the profile's cap with what still fails", async () => {
  const finding = "Verifier finding: page-error on #save.\nRepro: 1. goto /#code=x 2. click #save";
  for (const [name, cap] of [["lean", 2], ["full", 4]]) {
    const t = await setup(name, ["apps/ui/panel.txt"]);
    await t.post("/deliveries", { ref: REF });
    let fix;
    const { roles, job } = await t.drive((role, n, rec) => {
      if (role === "developer" && n === 2) fix = [rec.args.prompt, readFileSync(path.join(rec.args.cwd, ".den", "findings.md"), "utf8")];
      return role === "qa" ? `${finding}\nVERDICT: bounce` : "VERDICT: pass";
    });
    assert.equal(count(roles, "developer"), cap, `${name}: the developer runs once, then once per fix round the cap allows`);
    assert.equal(job.pause.kind, "failed-twice");
    assert.match(job.pause.reason, new RegExp(`cap of ${cap}`));
    assert.match(job.pause.reason, /page-error on #save/);
    assert.match(fix[1], /Repro: 1\. goto \/#code=x 2\. click #save/, "the fix round reads the repro steps");
    assert.match(fix[0], /verify:ui/, "the fix round is told how to reproduce a verifier finding");
    await cleanups.pop()();
  }
});

test("qa is told to run the verifier for criteria that need the running app, and its evidence is recorded on the ticket", async () => {
  const t = await setup("lean", ["apps/ui/panel.txt"]);
  await t.post("/deliveries", { ref: REF });
  let prompt;
  const outside = path.join(t.fx.root, "outside-secret.png");
  writeFileSync(outside, "not qa's to copy");
  const { job } = await t.drive((role, n, rec) => {
    if (role !== "qa") return "VERDICT: pass";
    prompt = rec.args.prompt;
    const out = path.join(rec.args.cwd, ".verify", "work-queue-1");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "work-queue.png"), "PNGDATA");
    writeFileSync(path.join(out, "perf-trace.json"), "{}");
    return `Ran the flow.\nVerifier evidence:\n- screenshot work-queue: ${out}/work-queue.png\n- perf: load 80 ms, trace .verify/work-queue-1/perf-trace.json\n- leaked: ${outside}\nVERDICT: pass`;
  });
  assert.match(prompt, /npm run verify:ui/);
  assert.match(prompt, /Verifier evidence:/);
  const kept = `.scratch/${FEATURE}/evidence/08-plain`;
  assert.equal(job.verifierEvidence.length, 3);
  assert.match(job.verifierEvidence[0], new RegExp(`^screenshot work-queue: ${kept}/[\\w.-]+work-queue\\.png$`), "the delivery row points at the board copy");
  assert.match(job.verifierEvidence[1], new RegExp(`^perf: load 80 ms, trace ${kept}/[\\w.-]+perf-trace\\.json$`), "a path relative to the worktree is copied too");
  assert.equal(job.verifierEvidence[2], `leaked: ${outside}`, "a file outside qa's worktree is not copied");
  const copy = path.join(t.fx.root, job.verifierEvidence[0].split(": ")[1]);
  assert.equal(readFileSync(copy, "utf8"), "PNGDATA", "the screenshot lives on the board, beside the ticket");
  assert.deepEqual(readdirSync(path.join(t.fx.root, kept)).length, 2, "only the two files in the worktree");
  const ticket = readFileSync(path.join(t.fx.root, ".scratch", FEATURE, "issues", "08-plain.md"), "utf8");
  assert.match(ticket, /qa, [\d-]+:\*\* verifier evidence at [0-9a-f]{12}: .*work-queue\.png/, "the ticket carries a comment naming the copied files");
  const dir = path.join(t.fx.root, ".scratch", FEATURE, "handoffs");
  const qaHandoff = readdirSync(dir).find((f) => /-qa-verify-/.test(f));
  assert.match(readFileSync(path.join(dir, qaHandoff), "utf8"), /perf-trace\.json/, "the handoff on the ticket carries the evidence");
});

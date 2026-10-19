// den-mvp outcome 3 (spec section 8): the delivery log. Append-only, in the bridge's state directory, which is outside
// every agent's worktree (the production entry puts it under the user's state home, outside the repository). Two kinds
// of line: a job's whole record after each change (the last one read wins), and an operation's intent and outcome,
// written before and after a side effect. On replay every field is checked and nothing is copied that is not named
// here; an intent with no outcome leaves the job marked `uncertain`, and the runner looks before it acts again.
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_ID_RE, MODES, REF_RE, ROLES } from "../agents/policy.mjs";
import { PUBLISH_BRANCH_RE } from "../agents/workspace.mjs";

export const JOB_ID_RE = /^d-[0-9a-f]{16}$/;
export const JOB_STATES = ["running", "paused", "merged", "closed"];
export const OPS = ["claim", "release", "push", "pr", "merge", "golive", "resolve"];
const COMMIT_RE = /^[0-9a-f]{40,64}$/;
const END_STATES = ["done", "failed", "terminated"];
const KIND_RE = /^[a-z][a-z-]{0,39}$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const ts = (v) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);
const line = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ").slice(0, max) : null);
const sha = (v) => (typeof v === "string" && COMMIT_RE.test(v) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 && v < 1e6 ? v : 0);
const forSha = (raw, more) => {
  const rest = isObject(raw) && sha(raw.sha) ? more(raw) : null;
  return rest ? { sha: raw.sha, ...rest } : null;
};
const runOf = (raw) => (isObject(raw) && AGENT_ID_RE.test(raw.runId) && ROLES.includes(raw.role) ? { runId: raw.runId, role: raw.role, mode: MODES.includes(raw.mode) ? raw.mode : null } : null);
const lines = (v, n, max) => (Array.isArray(v) ? v.slice(0, n).map((x) => line(x, max)).filter((x) => x !== null) : []);
// den-mvp/34: a local run of ci.yml's checks for this commit, and where its record is.
const TEST_STATES = ["green", "flaky", "red", "skipped", "error"];
const testsOf = (raw) => forSha(raw, (r) => (TEST_STATES.includes(r.state) ? {
  state: r.state, record: typeof r.record === "string" && /^[0-9a-f]{40}\/\d{8}T\d{6}Z(-\d+)?$/.test(r.record) ? r.record : null, reason: line(r.reason, 300),
  failed: lines(r.failed, 20, 300), flaky: lines(r.flaky, 20, 300), commands: lines(r.commands, 5, 200), differences: lines(r.differences, 10, 200),
} : null));
const verdictOf = (raw) => forSha(raw, (r) => (["pass", "bounce"].includes(r.verdict) && AGENT_ID_RE.test(r.runId) ? { runId: r.runId, verdict: r.verdict } : null));

/** A clean job record, or null. Unknown keys are not copied. */
export function validateJob(raw) {
  if (!isObject(raw) || !JOB_ID_RE.test(raw.id) || typeof raw.ref !== "string" || !REF_RE.test(raw.ref) || !JOB_STATES.includes(raw.state) || !sha(raw.base) || !ts(raw.startedAt)) return null;
  const ev = isObject(raw.evidence) ? raw.evidence : {};
  const pause = isObject(raw.pause) && KIND_RE.test(raw.pause.kind) ? { kind: raw.pause.kind, reason: line(raw.pause.reason, 400) ?? "", next: line(raw.pause.next, 300) ?? "" } : null;
  const pr = isObject(raw.pr) && Number.isInteger(raw.pr.number) && raw.pr.number > 0 && raw.pr.number < 1e9 ? { number: raw.pr.number, url: /^https:\/\/[A-Za-z0-9.-]+\/[\w./-]+$/.test(raw.pr.url) ? raw.pr.url : null } : null;
  return {
    id: raw.id, ref: raw.ref, title: line(raw.title, 200) ?? "", type: line(raw.type, 40) ?? "", state: raw.state, visual: raw.visual === true, localChecks: raw.localChecks === true,
    pause: raw.state === "paused" ? pause ?? { kind: "unknown", reason: "", next: "" } : null,
    step: line(raw.step, 40), base: raw.base, branch: typeof raw.branch === "string" && PUBLISH_BRANCH_RE.test(raw.branch) ? raw.branch : null,
    candidate: forSha(raw.candidate, (r) => (AGENT_ID_RE.test(r.runId) ? { runId: r.runId } : {})),
    evidence: {
      qa: verdictOf(ev.qa), security: verdictOf(ev.security),
      risk: forSha(ev.risk, (r) => ({ clean: r.clean === true, hits: count(r.hits), secret: r.secret === true, security: r.security !== false, userMerge: r.userMerge !== false, ciChange: r.ciChange !== false, ui: r.ui === true, files: count(r.files) })),
      // den-mvp/10: a preview that was built (or did not build) for this commit, and the release that went live for it.
      preview: forSha(ev.preview, (r) => ({ ok: r.ok === true })),
      tests: testsOf(ev.tests),
      live: forSha(ev.live, (r) => (r.state === "live" && sha(r.release) ? { state: "live", release: r.release } : null)),
      // What the git host said is asked again on every resume; these two are kept only to show.
      pr: null, ci: null,
      // F29: the dry-run merge with main is asked again too: main may have moved while the job waited.
      sync: null,
      verdict: forSha(ev.verdict, (r) => ({ ok: r.ok === true })),
    },
    bounces: count(raw.bounces), declines: count(raw.declines), findings: typeof raw.findings === "string" ? raw.findings.slice(0, 16000) : null,
    // den-mvp/29: the commit whose timed-out checks were run again, and the commit whose red checks were counted as a bounce.
    ciRerun: sha(raw.ciRerun), ciBounced: sha(raw.ciBounced),
    // F29: the merge-main rounds run so far, and the main commit the running round was asked to merge.
    syncRounds: count(raw.syncRounds), syncTarget: sha(raw.syncTarget),
    live: runOf(raw.live), claimed: raw.claimed === true,
    runs: (Array.isArray(raw.runs) ? raw.runs : []).slice(-50).flatMap((r) => (runOf(r) && END_STATES.includes(r.state) ? [{ ...runOf(r), state: r.state, sha: sha(r.sha) }] : [])),
    pr, startedAt: raw.startedAt, updatedAt: ts(raw.updatedAt) ?? raw.startedAt,
  };
}

export function createJobLog(dir) {
  const file = path.join(dir, "delivery.jsonl");
  let ensured = null;
  let chain = Promise.resolve();
  const ensure = () =>
    (ensured ??= (async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(file, "", { mode: 0o600 });
      await chmod(file, 0o600);
    })().catch((err) => {
      ensured = null;
      throw err;
    }));
  const append = (entry) => {
    const run = chain.then(async () => {
      await ensure();
      await appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    });
    chain = run.catch(() => {});
    return run;
  };
  return {
    file,
    /** The job's whole record. */
    save: (job) => append({ job }),
    /** An operation's intent ("intent") and outcome ("done" | "failed"), around the side effect. */
    op: (jobId, op, phase, detail = {}) => append({ op, phase, jobId, ...detail }),
    /** -> [job], oldest first; a job whose last operation has an intent and no outcome carries `uncertain: <op>`. */
    async replay() {
      const text = await readFile(file, "utf8").catch(() => "");
      const jobs = new Map();
      const open = new Map();
      for (const rawLine of text.split("\n")) {
        if (!rawLine.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (!isObject(parsed)) continue;
        if (parsed.job !== undefined) {
          const job = validateJob(parsed.job);
          if (job) jobs.set(job.id, job);
        } else if (OPS.includes(parsed.op) && JOB_ID_RE.test(parsed.jobId)) {
          if (parsed.phase === "intent") open.set(parsed.jobId, parsed.op);
          else if (open.get(parsed.jobId) === parsed.op) open.delete(parsed.jobId);
        }
      }
      return [...jobs.values()].map((job) => (open.has(job.id) ? { ...job, uncertain: open.get(job.id) } : job));
    },
  };
}

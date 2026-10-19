// organism-infra/140 (ADR 0016 decision 4 and 6.9): the append-only registry at .scratch/_run/sessions.jsonl.
// Two calls: append(event) and replay(). The file is untrusted input (any agent on the account can write it), so
// replay validates every field, drops what fails, and returns plain data only. Nothing read here is ever signalled.
import { mkdir, chmod, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_ID_RE, REF_RE, ROLES, UUID_RE } from "./policy.mjs";
import { workspaceNames } from "./workspace.mjs";
import { readCost, readCount, readModel, readTiers } from "./run-record.mjs";
import { runtimeId, validProject, validRuntimeSession } from "./identity.mjs";

const END_STATES = ["terminated", "done", "failed"];
const MAX_REASON = 200;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validTs = (v) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

// The run record on an end line (den-v1 loop S4): model, tokens by tier, cost and duration. Each is checked on its
// own and left out when it fails, so a line from before the record existed reads as it always did.
function runOf(raw) {
  const tiers = readTiers(raw.usage);
  const [model, costUsd, durationMs] = [readModel(raw.model), readCost(raw.costUsd), readCount(raw.durationMs)];
  return {
    ...(model === null ? {} : { model }),
    ...(tiers ? { usage: { ...tiers, final: raw.usage.final === true } } : {}),
    ...(costUsd === null ? {} : { costUsd }),
    ...(durationMs === null ? {} : { durationMs }),
  };
}

// Returns a clean line or null. Unknown keys (a pid, a command, a cwd) are not copied.
export function validateLine(raw) {
  if (!isObject(raw) || !validTs(raw.ts) || !AGENT_ID_RE.test(raw.agentId) || typeof raw.ref !== "string" || !REF_RE.test(raw.ref)) return null;
  const base = { ts: raw.ts, agentId: raw.agentId, ref: raw.ref };
  if (raw.event === "spawn") {
    if (!ROLES.includes(raw.role) || typeof raw.sessionId !== "string" || !UUID_RE.test(raw.sessionId)) return null;
    const runtime = runtimeId(raw.runtime);
    const project = raw.project === undefined ? "den" : raw.project;
    if (!runtime || !validProject(project)) return null;
    const native = raw.runtimeSessionId === undefined && runtime === "claude" ? raw.sessionId : raw.runtimeSessionId;
    const runtimeSessionId = validRuntimeSession(native) ? native : null;
    const resourceId = raw.resourceId === raw.agentId ? raw.resourceId : undefined;
    // The worktree and branch are kept only when they equal what the bridge derives from this ref and id, so the
    // file cannot make the UI name another path; a line from before worktrees existed has neither.
    // den-mvp outcome 2: a follow-up run works in the worktree of the run that first opened the session (`origin`) and
    // continues the run named by `resumeOf`; its branch is still its own. Both must be bridge-minted ids, or neither is kept.
    const follows = AGENT_ID_RE.test(raw.origin) && AGENT_ID_RE.test(raw.resumeOf) ? { origin: raw.origin, resumeOf: raw.resumeOf } : {};
    const names = { worktree: workspaceNames({ ref: raw.ref, agentId: follows.origin ?? raw.agentId }).worktree, branch: workspaceNames({ ref: raw.ref, agentId: raw.agentId }).branch };
    const own = raw.worktree === names.worktree && raw.branch === names.branch;
    return { ...base, event: "spawn", role: raw.role, sessionId: raw.sessionId, runtime, project, runtimeSessionId, ...(resourceId ? { resourceId } : {}), worktree: own ? names.worktree : null, branch: own ? names.branch : null, ...(own ? follows : {}) };
  }
  if (raw.event === "stop") return { ...base, event: "stop" };
  if (raw.event === "end") {
    if (!END_STATES.includes(raw.state)) return null;
    const reason = typeof raw.reason === "string" ? raw.reason.slice(0, MAX_REASON).replace(/[^\x20-\x7e]/g, "?") : null;
    return { ...base, event: "end", state: raw.state, reason, ...runOf(raw) };
  }
  return null;
}

export function createSessions(root) {
  const dir = path.join(root, ".scratch", "_run");
  const file = path.join(dir, "sessions.jsonl");
  let ensured = null;
  let chain = Promise.resolve();

  // Dir 0700, file 0600, set explicitly so a pre-existing looser mode is tightened too.
  const ensure = () =>
    (ensured ??= (async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await appendFile(file, "", { mode: 0o600 });
      await chmod(file, 0o600);
    })().catch((err) => {
      ensured = null;
      throw err;
    }));

  return {
    file,
    // Appends are serialised so lines land in the order they were issued.
    append(event) {
      const run = chain.then(async () => {
        await ensure();
        await appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
      });
      chain = run.catch(() => {});
      return run;
    },
    // -> [{ agentId, ref, role, sessionId, worktree, branch, origin?, resumeOf?, startedAt, endedAt, state, reason }], oldest first. `state` is the end
    // state, or "terminated" with reason "bridge-restart-unverified" for a spawn that never got an end line. An agent
    // whose end line holds a run record also has those of model, usage, costUsd and durationMs that passed.
    async replay() {
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return [];
      }
      const agents = new Map();
      for (const rawLine of text.split("\n")) {
        if (!rawLine.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          continue;
        }
        const line = validateLine(parsed);
        if (!line) continue;
        if (line.event === "spawn") {
          if (!agents.has(line.agentId)) {
            agents.set(line.agentId, {
              agentId: line.agentId, ref: line.ref, role: line.role, sessionId: line.sessionId, runtime: line.runtime, runtimeSessionId: line.runtimeSessionId, resourceId: line.resourceId, worktree: line.worktree, branch: line.branch,
              ...(line.origin ? { origin: line.origin, resumeOf: line.resumeOf } : {}), ...(line.project ? { project: line.project } : {}),
              startedAt: line.ts, endedAt: null, state: "terminated", reason: "bridge-restart-unverified",
            });
          }
        } else if (line.event === "end") {
          const a = agents.get(line.agentId);
          if (a && !a.ended) {
            const { ts, agentId, ref, event, state, reason, ...run } = line;
            Object.assign(a, { endedAt: ts, state, reason, ended: true, ...run });
          }
        }
      }
      return [...agents.values()].map(({ ended, ...a }) => a);
    },
  };
}

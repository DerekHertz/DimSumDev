// codex-residents/05: the one admission transaction every start path goes through (dispatch, start, direct, delivery,
// follow-up, retry, coordinator, router). It decides, in this order and in one place: the runtime allowlist, the
// coordinator's capability, the canonical file scopes, and then the single attempt per identified work. A durable
// journal (.scratch/_run/admission.jsonl) records the intent before anything spawns and the settlement after the
// attempt ends. An intent with no settlement after a crash is *uncertain*: it blocks every new attempt on that work
// until someone reconciles it. Nothing here ever respawns on its own.
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { RUNTIMES } from "./identity.mjs";

export const COORDINATORS = ["bao", "jiao"];
export const ALLOWLISTS = ["both", "codex", "claude"];
const SCOPE_MAX = 50;
const refuse = (status, error, more = {}) => ({ ok: false, status, error, ...more });

function governedPrefixes() {
  try {
    const g = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "governance.json"), "utf8"));
    return [...(g.ciPaths ?? []), ...(g.guardrailPaths ?? [])]
      .filter((p) => !p.startsWith("~"))
      .map((p) => p.replace(/\/\*\*$/, "").replace(/\/+$/, ""))
      .filter(Boolean);
  } catch {
    // Fail closed: if the table cannot be read, keep the paths that matter most.
    return [".claude", ".git", ".github", ".gitlab-ci.yml", "Jenkinsfile", "apps/bridge/cells"];
  }
}

const within = (rel, base) => rel === base || rel.startsWith(`${base}/`);

export function createAdmission({ root, governed = governedPrefixes() }) {
  const dir = path.join(root, ".scratch", "_run");
  const file = path.join(dir, "admission.jsonl");
  let allow = "both";
  const owners = new Map(); // ref -> { owner, epoch, parent? }
  const runtimes = new Map(); // project/ref -> runtime fixed by the first admitted attempt
  const intents = new Map(); // id -> intent, for those with no settlement
  const held = new Map(); // project/ref -> intent id, attempts admitted in this process
  const uncertainIds = new Set(); // intents found unsettled at replay
  let canonicalRoot;
  let chain = Promise.resolve();
  const keyOf = (project, ref) => `${project}/${ref}`;

  const append = (event) => {
    const run = chain.then(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
    });
    chain = run.catch(() => {});
    return run;
  };

  function apply(e) {
    if (e.event === "setting" && ALLOWLISTS.includes(e.allow)) allow = e.allow;
    else if (e.event === "owner" && typeof e.ref === "string" && COORDINATORS.includes(e.owner) && Number.isSafeInteger(e.epoch)) owners.set(e.ref, { owner: e.owner, epoch: e.epoch, ...(typeof e.parent === "string" ? { parent: e.parent } : {}) });
    else if (e.event === "intent" && typeof e.id === "string" && typeof e.ref === "string" && typeof e.project === "string") {
      intents.set(e.id, e);
      if (RUNTIMES.includes(e.runtime)) runtimes.set(keyOf(e.project, e.ref), e.runtime);
    } else if ((e.event === "settled" || e.event === "reconciled") && intents.has(e.id)) {
      intents.delete(e.id);
      uncertainIds.delete(e.id);
    } else if (e.event === "runtime" && typeof e.key === "string" && RUNTIMES.includes(e.runtime)) runtimes.set(e.key, e.runtime);
  }

  const ready = (async () => {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        apply(JSON.parse(line));
      } catch {
        // a torn or foreign line is skipped
      }
    }
    for (const id of intents.keys()) uncertainIds.add(id);
  })();

  function ownerOf(ref) {
    const rec = owners.get(ref);
    if (!rec) return { owner: "bao", epoch: 0, legacy: true, root: ref };
    if (rec.parent) {
      const up = ownerOf(rec.parent);
      return { owner: up.owner, epoch: up.epoch, root: up.root };
    }
    return { owner: rec.owner, epoch: rec.epoch, root: ref };
  }

  // ---- file scopes --------------------------------------------------------------------------------
  // The canonical form of a path under the root: the deepest existing ancestor is resolved through symlinks and the
  // rest is appended. Returns the path relative to the canonical root, or null when it leaves the root.
  async function canonical(p) {
    canonicalRoot ??= await realpath(root).catch(() => path.resolve(root));
    const abs = path.resolve(canonicalRoot, p);
    let head = abs;
    const tail = [];
    for (;;) {
      try {
        head = await realpath(head);
        break;
      } catch (err) {
        if (err.code !== "ENOENT" && err.code !== "ENOTDIR") return null;
        const up = path.dirname(head);
        if (up === head) return null;
        tail.unshift(path.basename(head));
        head = up;
      }
    }
    const rel = path.relative(canonicalRoot, path.join(head, ...tail)).split(path.sep).join("/");
    if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
    return rel === "" ? "." : rel;
  }
  const isGoverned = (rel) => governed.some((g) => within(rel, g));
  const containsGoverned = (rel) => rel === "." || governed.some((g) => within(g, rel));

  async function checkScopes(scopes) {
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > SCOPE_MAX) return refuse(400, "the work has no known file scope");
    const out = [];
    for (const s of scopes) {
      if (typeof s !== "string" || s === "" || s.includes("\0") || path.isAbsolute(s)) return refuse(400, "a file scope must be a path inside the project");
      const rel = await canonical(s);
      if (rel === null) return refuse(403, "a file scope leaves the project");
      if (isGoverned(rel) || containsGoverned(rel)) return refuse(403, "a file scope reaches a governed path");
      out.push(rel);
    }
    return { ok: true, scopes: [...new Set(out)] };
  }

  // Files a returned run changed (paths relative to its worktree), checked against the scopes it was admitted with.
  async function checkReturned({ scopes, changed }) {
    const bad = [];
    const canonScopes = [];
    for (const s of scopes ?? []) {
      const rel = await canonical(s);
      if (rel !== null) canonScopes.push(rel);
    }
    for (const p of changed ?? []) {
      const rel = typeof p === "string" ? await canonical(p) : null;
      if (rel === null) bad.push({ path: p, why: "outside the project" });
      else if (isGoverned(rel)) bad.push({ path: p, why: "governed path" });
      else if (scopes != null && !canonScopes.some((s) => s === "." || within(rel, s))) bad.push({ path: p, why: "outside the admitted scope" });
    }
    return bad;
  }

  // ---- the transaction ----------------------------------------------------------------------------
  const busyFor = (predicate) => [...intents.values()].filter(predicate);

  async function admit({ ref, project = "den", runtime, entry, role, capability, scopes, unscoped = false }) {
    await ready;
    const key = keyOf(project, ref);
    if (!RUNTIMES.includes(runtime)) return refuse(400, "unknown runtime");
    if (allow !== "both" && allow !== runtime) {
      return refuse(409, `the ${runtime} runtime is not allowed right now (the den allows ${allow} only)`, { paused: true });
    }
    const fixed = runtimes.get(key);
    if (fixed && fixed !== runtime) return refuse(409, `this work was approved on ${fixed}; change its runtime explicitly first`);
    const owner = ownerOf(ref);
    if (capability !== undefined) {
      const c = capability;
      if (!c || !COORDINATORS.includes(c.actor)) return refuse(403, "the capability is not a coordinator's");
      if (c.actor !== owner.owner) return refuse(403, `this ticket belongs to ${owner.owner}`);
      if (c.epoch !== owner.epoch || c.root !== owner.root) return refuse(403, "the capability is stale: the ticket's ownership changed");
    }
    // An entry that declares no scope may say so (`unscoped`): its run is confined to its own worktree, and what it
    // returns is still checked against the governed paths and the project root by checkReturned.
    const checked = unscoped && scopes === undefined ? { ok: true, scopes: null } : await checkScopes(scopes);
    if (checked.ok === false) return checked;

    // From here to the hold there is no await: the one synchronous step.
    if (held.has(key)) return refuse(409, "this ticket already has a live agent");
    if (busyFor((i) => keyOf(i.project, i.ref) === key && uncertainIds.has(i.id)).length > 0) return refuse(409, "an earlier attempt on this work is unconfirmed; reconcile it before starting another");
    const intent = { event: "intent", id: `i-${randomBytes(8).toString("hex")}`, ref, project, runtime, entry, role, owner: owner.owner, epoch: owner.epoch, scopes: checked.scopes };
    held.set(key, intent.id);
    intents.set(intent.id, intent);
    runtimes.set(key, runtime);
    try {
      await append(intent);
    } catch (err) {
      held.delete(key);
      intents.delete(intent.id);
      console.error(`bridge: could not write the admission journal: ${err?.message ?? err}`);
      return refuse(503, "could not record the attempt before starting it");
    }
    return { ok: true, intent };
  }

  async function settle(id, outcome = "ended") {
    const intent = intents.get(id);
    if (!intent) return refuse(404, "no such attempt");
    intents.delete(id);
    uncertainIds.delete(id);
    const key = keyOf(intent.project, intent.ref);
    if (held.get(key) === id) held.delete(key);
    await append({ event: "settled", id, outcome }).catch((err) => console.error(`bridge: could not write the admission journal: ${err?.message ?? err}`));
    return { ok: true };
  }

  async function reconcile(id, outcome) {
    await ready;
    if (!uncertainIds.has(id)) return refuse(404, "no such unconfirmed attempt");
    if (outcome !== "ended" && outcome !== "never-started") return refuse(400, "outcome must be ended or never-started");
    intents.delete(id);
    uncertainIds.delete(id);
    await append({ event: "reconciled", id, outcome });
    return { ok: true };
  }

  // ---- ownership, capability, allowlist ------------------------------------------------------------
  async function approve(ref, { owner, parent } = {}) {
    await ready;
    if (!COORDINATORS.includes(owner)) return refuse(400, `owner must be one of: ${COORDINATORS.join(", ")}`);
    const have = owners.get(ref);
    if (have) return have.owner === owner && have.parent === parent ? { ok: true, ...ownerOf(ref) } : refuse(409, "this ticket already has an owner; transfer it instead");
    if (parent !== undefined && ownerOf(parent).owner !== owner) return refuse(409, "a descendant belongs to its parent's coordinator");
    const rec = { owner, epoch: parent === undefined ? 1 : 0, ...(parent === undefined ? {} : { parent }) };
    owners.set(ref, rec);
    await append({ event: "owner", ref, ...rec });
    return { ok: true, ...ownerOf(ref) };
  }

  async function transfer(ref, to) {
    await ready;
    if (!COORDINATORS.includes(to)) return refuse(400, `owner must be one of: ${COORDINATORS.join(", ")}`);
    const have = owners.get(ref);
    if (have?.parent) return refuse(400, "transfer the root ticket; its descendants follow");
    const now = ownerOf(ref);
    if (now.owner === to) return refuse(409, `${to} already owns this ticket`);
    if (busyFor((i) => ownerOf(i.ref).root === ref).length > 0) return refuse(409, "an attempt is live or unconfirmed; transfer waits for its confirmed end");
    const rec = { owner: to, epoch: now.epoch + 1 };
    owners.set(ref, rec);
    await append({ event: "owner", ref, ...rec });
    return { ok: true, ...ownerOf(ref) };
  }

  const capability = (actor, ref) => {
    const o = ownerOf(ref);
    return { actor, ref, root: o.root, epoch: o.epoch };
  };

  async function setAllowlist(value) {
    await ready;
    if (!ALLOWLISTS.includes(value)) return refuse(400, `runtime allowlist must be one of: ${ALLOWLISTS.join(", ")}`);
    allow = value;
    await append({ event: "setting", allow: value });
    return { ok: true, allow };
  }

  async function changeRuntime(ref, runtime, project = "den") {
    await ready;
    if (!RUNTIMES.includes(runtime)) return refuse(400, "unknown runtime");
    const key = keyOf(project, ref);
    if (held.has(key) || busyFor((i) => keyOf(i.project, i.ref) === key).length > 0) return refuse(409, "an attempt is live or unconfirmed");
    runtimes.set(key, runtime);
    await append({ event: "runtime", key, runtime });
    return { ok: true };
  }

  return {
    ready, admit, settle, reconcile, approve, transfer, capability, ownerOf, setAllowlist, changeRuntime, checkScopes, checkReturned,
    allowlist: () => allow,
    intentOf: (id) => intents.get(id) ?? null,
    active: () => [...held.values()],
    uncertain: () => [...uncertainIds].map((id) => intents.get(id)).filter(Boolean),
    runtimeOf: (ref, project = "den") => runtimes.get(keyOf(project, ref)) ?? null,
  };
}

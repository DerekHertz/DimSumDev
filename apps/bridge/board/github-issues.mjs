// den-mvp/51 (outcome 6 slice 4, ADR 0021 Amendment 5): a project's board kept as GitHub Issues, behind the same
// interface as the markdown board: list, read, create, setStatus, claim, claimForHandoff, handoff, drop, resolve, plus the
// frontier (multi-project/01, ADR 0021 Amendment 7 decision 25). Claims are labels plus a comment, so only a claim comment
// written by the bridge's own login counts, and comment() refuses a body that looks like one.
// Each operation is one narrow `gh` call with a fixed argument list over values checked here, run from the bridge
// with its own git-host login. No agent is given the token, and nothing here returns the environment.
// exec is a test seam with execFile's promise shape: (file, args, options) -> Promise<{ stdout, stderr }>.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoardError } from "../../board/board-service.mjs";
import { orderFrontier } from "../../board/priority.mjs";
import { handoffNote, handoffRecord } from "./handoff-body.mjs";

const execFileP = promisify(execFile);
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const ROLE_RE = /^[a-z][a-z-]{0,30}$/;
const RUN_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]{0,9}$/;
const CLAIM_RE = /^<!-- den-claim role=([a-z][a-z-]{0,30}) run=([A-Za-z0-9._-]{1,64}) -->/;
const LABELS = { human: "den:ready-for-human", agent: "den:ready-for-agent", claim: "den:in-progress", review: "den:in-review" };
const STATUS_LABEL = { "ready-for-human": LABELS.human, "ready-for-agent": LABELS.agent, "in-review": LABELS.review };
const REVIEW_ROLES = new Set(["qa", "security", "code-reviewer"]); // a claim by these keeps a ticket at in-review
const MARKER_RE = /^\s*<!--\s*den-claim/i;
const LIST_TTL_MS = 30_000;
const TYPES = ["feature", "bug", "chore", "docs"];
const FIELDS = "number,title,body,state,labels,comments";

const keyOf = (ref) => /^(.*\/\d+)-/.exec(ref)[1];
const num = (n) => String(n).padStart(2, "0");
const titleSlug = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "") || "ticket";
const oneLine = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max);

export function createGithubIssuesBoard({ repo, project, exec = execFileP, root = process.cwd(), env = process.env, now = Date.now, listTtlMs = LIST_TTL_MS } = {}) {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) throw new TypeError("github board: repo must be owner/repo");
  if (typeof project !== "string" || !SLUG_RE.test(project)) throw new TypeError("github board: bad project slug");
  const quiet = { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  const gh = async (...args) => String((await exec("gh", args, { cwd: root, env: quiet, maxBuffer: 8 * 1024 * 1024 })).stdout);
  const numberOf = (ref) => {
    const m = /^([^/]+)\/(\d{2,})-[a-z0-9-]*$/.exec(String(ref));
    if (!m || m[1] !== project) throw new TypeError("github board: not a ticket of this project");
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n < 1) throw new TypeError("github board: bad ticket number");
    return String(n);
  };
  const run = (v) => { if (typeof v !== "string" || !RUN_RE.test(v)) throw new TypeError("github board: bad run id"); return v; };
  const role = (v) => { if (typeof v !== "string" || !ROLE_RE.test(v)) throw new TypeError("github board: bad role"); return v; };

  // The login the bridge acts as; a claim comment from any other login is ignored. Unknown (never cached) means no claim is trusted.
  let login = "";
  const bridgeLogin = async () => {
    if (!login) login = (await gh("api", "user", "--jq", ".login").catch(() => "")).trim();
    return login;
  };
  const labelNames = (raw) => (raw?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  const holdsClaim = (raw) => labelNames(raw).includes(LABELS.claim) && String(raw.state).toUpperCase() !== "CLOSED";

  // An issue of the host -> a normalized ticket, or null when it carries no den:* label (it is not a ticket).
  const normalize = (raw, trusted = "") => {
    const names = labelNames(raw);
    if (!names.some((n) => n.startsWith("den:"))) return null;
    const closed = String(raw.state).toUpperCase() === "CLOSED";
    const claimed = names.includes(LABELS.claim);
    let holder = null;
    if (claimed && !closed) {
      for (const c of [...(raw.comments ?? [])].reverse()) {
        const m = trusted && c?.author?.login === trusted ? CLAIM_RE.exec(String(c?.body ?? "")) : null;
        if (m) { holder = { role: m[1], run: m[2] }; break; }
      }
    }
    const status = closed ? "resolved" : names.includes(LABELS.review) ? "in-review" : claimed ? "claimed" : names.includes(LABELS.agent) ? "ready-for-agent" : names.includes(LABELS.human) ? "ready-for-human" : "open";
    const blocked = /^Blocked by:[ \t]*(.+)$/im.exec(String(raw.body ?? ""));
    const blockedBy = blocked ? [...blocked[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0).map((n) => `${project}/${num(n)}`) : [];
    const pr = names.find((n) => /^priority:P[1-3]$/.test(n));
    const type = names.find((n) => n.startsWith("type:"))?.slice(5);
    return {
      ref: `${project}/${num(raw.number)}-${titleSlug(raw.title)}`,
      title: oneLine(raw.title, 200), type: TYPES.includes(type) ? type : "feature", status,
      priority: pr ? pr.slice(9) : "P2", blockedBy, holder,
      ...(status === "ready-for-human" ? { text: String(raw.body ?? "") } : {}),
    };
  };

  let chain = Promise.resolve(); // claims run one at a time here: labels are not atomic, so this is the one-holder guarantee
  const serial = (fn) => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };

  const fetchRaw = async (ref) => JSON.parse(await gh("issue", "view", numberOf(ref), "--repo", repo, "--json", FIELDS));
  const toTicket = async (raw) => {
    const t = normalize(raw, holdsClaim(raw) ? await bridgeLogin() : "");
    if (!t) throw new Error("github board: that issue is not a ticket");
    return { ...t, text: String(raw.body ?? "") };
  };
  const read = async (ref) => toTicket(await fetchRaw(ref));
  // The list is cached for a short time so a hub poll and the per-dispatch reads cost the host little; every write made here drops it.
  let cached = null;
  const listAll = async ({ maxAgeMs = listTtlMs } = {}) => {
    if (cached && now() - cached.at < maxAgeMs) return cached.rows;
    const rows = JSON.parse(await gh("issue", "list", "--repo", repo, "--state", "all", "--limit", "200", "--json", FIELDS));
    const raws = Array.isArray(rows) ? rows : [];
    const trusted = raws.some(holdsClaim) ? await bridgeLogin() : "";
    cached = { at: now(), rows: raws.map((r) => normalize(r, trusted)).filter(Boolean) };
    return cached.rows;
  };
  const write = async (...args) => { cached = null; try { return await gh(...args); } finally { cached = null; } };
  // A comment the bridge posts is never shaped like a claim.
  const say = (n, body) => {
    if (MARKER_RE.test(String(body))) throw new TypeError("github board: a comment may not start with the claim marker");
    return write("issue", "comment", n, "--repo", repo, "--body", String(body));
  };
  // The status labels of a ticket: the one asked for on, the others off, and the claim off unless kept.
  const setLabels = (n, status, { dropClaim = true } = {}) => {
    const add = STATUS_LABEL[status];
    if (!add) throw new TypeError("github board: bad status");
    const remove = Object.values(STATUS_LABEL).filter((l) => l !== add);
    if (dropClaim) remove.push(LABELS.claim);
    return write("issue", "edit", n, "--repo", repo, "--add-label", add, "--remove-label", remove.join(","));
  };

  /** Takes the ticket for a run: label plus the claim comment. Throws when someone holds it. */
  const claim = (ref, { role: r, run: id = "bridge" }) => {
    const n = numberOf(ref); role(r); run(id);
    return serial(async () => {
        const raw = await fetchRaw(ref);
        const t = await toTicket(raw);
        if (t.status === "resolved") throw new BoardError("github board: the ticket is resolved");
        if (t.holder || holdsClaim(raw)) throw new BoardError("github board: the ticket is already claimed");
        const leavesReview = labelNames(raw).includes(LABELS.review) && !REVIEW_ROLES.has(r);
        await write("issue", "edit", n, "--repo", repo, "--add-label", LABELS.claim, ...(leavesReview ? ["--remove-label", LABELS.review] : []));
        await write("issue", "comment", n, "--repo", repo, "--body", `<!-- den-claim role=${r} run=${id} -->\nClaimed by ${r} (run ${id}).`);
        return { ...t, status: leavesReview || t.status !== "in-review" ? "claimed" : t.status, holder: { role: r, run: id } };
      });
  };

  return {
    kind: "github-issues",
    root,
    list: listAll,
    read,
    /** A new ticket, waiting on the user unless `ready` is given. -> the ticket */
    async create({ title, body, text, priority = "P2", type = "feature", status, ready = status === "ready-for-agent" }) {
      body = body ?? text ?? "";
      const labels = [ready ? LABELS.agent : LABELS.human];
      if (["P1", "P2", "P3"].includes(priority) && priority !== "P2") labels.push(`priority:${priority}`);
      if (TYPES.includes(type)) labels.push(`type:${type}`);
      const out = await write("issue", "create", "--repo", repo, "--title", oneLine(title, 200) || "ticket", "--body", String(body), "--label", labels.join(","));
      const m = /\/issues\/([1-9][0-9]{0,9})\s*$/.exec(out.trim());
      if (!m) throw new Error("github board: the host did not name the new issue");
      return read(`${project}/${num(Number(m[1]))}-x`);
    },
    claim,
    claimForHandoff: claim,
    async comment(ref, body) { await say(numberOf(ref), body); },
    /** Drops the claim. */
    release(ref) {
      const n = numberOf(ref);
      return serial(async () => { await write("issue", "edit", n, "--repo", repo, "--remove-label", LABELS.claim); });
    },
    /** The user's answer to a ticket at ready-for-human: 'ready-for-agent' approves, 'closed' declines (with the note). */
    async setStatus(ref, status, note = "") {
      const n = numberOf(ref);
      if (status !== "ready-for-agent" && status !== "closed") throw new TypeError("github board: status must be ready-for-agent or closed");
      const t = await read(ref);
      if (t.status !== "ready-for-human") throw new BoardError(`github board: the ticket is ${t.status}, not ready-for-human`);
      if (status === "closed") return void (await write("issue", "close", n, "--repo", repo, "--reason", "not planned", "--comment", oneLine(note, 500) || "Declined"));
      await setLabels(n, "ready-for-agent");
      if (note) await say(n, oneLine(note, 500));
    },
    /** One comment holding the State block and the capped report, then the release at `status` (null leaves the ticket alone). */
    handoff(ref, { status = "in-review", source = "den delivery", ...h }) {
      const n = numberOf(ref);
      return serial(async () => {
        await say(n, handoffRecord(ref, h).body);
        if (status === null) return;
        await setLabels(n, status);
        await say(n, handoffNote({ ...h, source }));
      });
    },
    /** Gives up a claim without a handoff. A status moves the ticket there; none leaves its labels alone. */
    drop(ref, { status, reason }) {
      const n = numberOf(ref);
      return serial(async () => {
        if (status === undefined) await write("issue", "edit", n, "--repo", repo, "--remove-label", LABELS.claim);
        else await setLabels(n, status);
        if (reason) await say(n, oneLine(reason, 500));
      });
    },
    /** Closes the ticket as done, naming the pull request that did it: a number, a pull request URL, or { pr }. */
    async resolve(ref, prArg) {
      const n = numberOf(ref);
      const pr = prArg !== null && typeof prArg === "object" ? prArg.pr : /^\d+$/.test(String(prArg)) ? Number(prArg) : prArg;
      const link = Number.isInteger(pr) && pr > 0 ? `#${pr}` : PR_URL_RE.test(String(pr)) ? String(pr) : null;
      if (!link) throw new TypeError("github board: resolve needs the pull request");
      await write("issue", "edit", n, "--repo", repo, "--remove-label", LABELS.claim);
      await write("issue", "close", n, "--repo", repo, "--reason", "completed", "--comment", `Resolved by ${link}`);
    },
    /** Open, unclaimed, unblocked tickets that wait on an agent, in the den's queue order (priority, then number). */
    async frontier() {
      const all = await listAll();
      const done = new Set(all.filter((t) => t.status === "resolved").map((t) => keyOf(t.ref)));
      const ready = all.filter((t) => t.status === "ready-for-agent" && !t.holder && t.blockedBy.every((b) => done.has(b)));
      return orderFrontier(ready.map((t) => ({ ref: t.ref, priority: t.priority, readySince: "1970-01-01T00:00:00Z" }))).map((o) => o.ref);
    },
  };
}

/** The board of a project from its registry row `board: { kind, repo }`. No row means the den's markdown board. */
export function boardFor(project, board, opts = {}) {
  if (board?.kind === "github-issues") return createGithubIssuesBoard({ ...opts, project: project.slug, repo: board.repo, root: project.root });
  return null;
}

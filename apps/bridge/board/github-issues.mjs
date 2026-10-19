// den-mvp/51 (outcome 6 slice 4, ADR 0021 Amendment 5): a project's board kept as GitHub Issues, behind the same
// interface as the markdown board: list, read, create, claim, comment, release, resolve, plus the frontier.
// Each operation is one narrow `gh` call with a fixed argument list over values checked here, run from the bridge
// with its own git-host login. No agent is given the token, and nothing here returns the environment.
// exec is a test seam with execFile's promise shape: (file, args, options) -> Promise<{ stdout, stderr }>.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { orderFrontier } from "../../board/priority.mjs";

const execFileP = promisify(execFile);
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const ROLE_RE = /^[a-z][a-z-]{0,30}$/;
const RUN_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]{0,9}$/;
const CLAIM_RE = /^<!-- den-claim role=([a-z][a-z-]{0,30}) run=([A-Za-z0-9._-]{1,64}) -->/;
const LABELS = { human: "den:ready-for-human", agent: "den:ready-for-agent", claim: "den:in-progress" };
const TYPES = ["feature", "bug", "chore", "docs"];
const FIELDS = "number,title,body,state,labels,comments";

const keyOf = (ref) => /^(.*\/\d+)-/.exec(ref)[1];
const num = (n) => String(n).padStart(2, "0");
const titleSlug = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "") || "ticket";
const oneLine = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max);

export function createGithubIssuesBoard({ repo, project, exec = execFileP, root = process.cwd(), env = process.env } = {}) {
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

  // An issue of the host -> a normalized ticket, or null when it carries no den:* label (it is not a ticket).
  const normalize = (raw) => {
    const names = (raw?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
    if (!names.some((n) => n.startsWith("den:"))) return null;
    const closed = String(raw.state).toUpperCase() === "CLOSED";
    const claimed = names.includes(LABELS.claim);
    let holder = null;
    if (claimed && !closed) {
      for (const c of [...(raw.comments ?? [])].reverse()) {
        const m = CLAIM_RE.exec(String(c?.body ?? ""));
        if (m) { holder = { role: m[1], run: m[2] }; break; }
      }
    }
    const status = closed ? "resolved" : claimed ? "claimed" : names.includes(LABELS.agent) ? "ready-for-agent" : names.includes(LABELS.human) ? "ready-for-human" : "open";
    const blocked = /^Blocked by:[ \t]*(.+)$/im.exec(String(raw.body ?? ""));
    const blockedBy = blocked ? [...blocked[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0).map((n) => `${project}/${num(n)}`) : [];
    const pr = names.find((n) => /^priority:P[1-3]$/.test(n));
    const type = names.find((n) => n.startsWith("type:"))?.slice(5);
    return {
      ref: `${project}/${num(raw.number)}-${titleSlug(raw.title)}`,
      title: oneLine(raw.title, 200), type: TYPES.includes(type) ? type : "feature", status,
      priority: pr ? pr.slice(9) : "P2", blockedBy, holder,
    };
  };

  let chain = Promise.resolve(); // claims run one at a time here: labels are not atomic, so this is the one-holder guarantee
  const serial = (fn) => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };

  const read = async (ref) => {
    const t = normalize(JSON.parse(await gh("issue", "view", numberOf(ref), "--repo", repo, "--json", FIELDS)));
    if (!t) throw new Error("github board: that issue is not a ticket");
    return t;
  };
  const listAll = async () => {
    const rows = JSON.parse(await gh("issue", "list", "--repo", repo, "--state", "all", "--limit", "200", "--json", FIELDS));
    return (Array.isArray(rows) ? rows : []).map(normalize).filter(Boolean);
  };

  return {
    kind: "github-issues",
    list: listAll,
    read,
    /** A new ticket, waiting on the user unless `ready` is given. -> the ticket */
    async create({ title, body = "", priority = "P2", type = "feature", ready = false }) {
      const labels = [ready ? LABELS.agent : LABELS.human];
      if (["P1", "P2", "P3"].includes(priority) && priority !== "P2") labels.push(`priority:${priority}`);
      if (TYPES.includes(type)) labels.push(`type:${type}`);
      const out = await gh("issue", "create", "--repo", repo, "--title", oneLine(title, 200) || "ticket", "--body", String(body), "--label", labels.join(","));
      const m = /\/issues\/([1-9][0-9]{0,9})\s*$/.exec(out.trim());
      if (!m) throw new Error("github board: the host did not name the new issue");
      return read(`${project}/${num(Number(m[1]))}-x`);
    },
    /** Takes the ticket for a run: label plus the claim comment. Throws when someone holds it. */
    claim(ref, { role: r, run: id }) {
      const n = numberOf(ref); role(r); run(id);
      return serial(async () => {
        const t = await read(ref);
        if (t.status === "resolved") throw new Error("github board: the ticket is resolved");
        if (t.holder || t.status === "claimed") throw new Error("github board: the ticket is already claimed");
        await gh("issue", "edit", n, "--repo", repo, "--add-label", LABELS.claim);
        await gh("issue", "comment", n, "--repo", repo, "--body", `<!-- den-claim role=${r} run=${id} -->\nClaimed by ${r} (run ${id}).`);
        return { ...t, status: "claimed", holder: { role: r, run: id } };
      });
    },
    async comment(ref, body) {
      await gh("issue", "comment", numberOf(ref), "--repo", repo, "--body", String(body));
    },
    /** Drops the claim. */
    release(ref) {
      const n = numberOf(ref);
      return serial(async () => { await gh("issue", "edit", n, "--repo", repo, "--remove-label", LABELS.claim); });
    },
    /** Closes the ticket as done, naming the pull request that did it. */
    async resolve(ref, { pr }) {
      const n = numberOf(ref);
      const link = Number.isInteger(pr) && pr > 0 ? `#${pr}` : PR_URL_RE.test(String(pr)) ? String(pr) : null;
      if (!link) throw new TypeError("github board: resolve needs the pull request");
      await gh("issue", "edit", n, "--repo", repo, "--remove-label", LABELS.claim);
      await gh("issue", "close", n, "--repo", repo, "--reason", "completed", "--comment", `Resolved by ${link}`);
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

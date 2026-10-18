// den-mvp outcome 3 (spec sections 1 and 4): the bridge's own git-host operations. Each is one narrow call with a
// fixed argument list over values the bridge checked (a full commit id, a den branch name, a pull request number);
// there is no general command here and no shell. The credentials are the bridge process's own (the user's git and gh
// login): no agent is given them, and an agent's wall denies `git push` and `gh pr` besides.
// exec is a test seam with execFile's promise shape: (file, args, options) -> Promise<{ stdout, stderr }>.
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { hasSecret } from "../../../scripts/exposure.mjs";
import { PUBLISH_BRANCH_RE } from "../cells/workspace.mjs";

const execFileP = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40,64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DIFF_MAX = 32 * 1024 * 1024;
// A file that is a key or an environment file by its name. `.env.example` and the like hold no values.
const SECRET_FILE_RE = /^(?:\.env(?:\.(?!example$|sample$|template$)[^/]*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519))$/i;
const NO_CHECKS_TRIES = 6; // a new pull request's checks take a moment to be registered
const NO_CHECKS_WAIT_MS = 10000;
const GUARD_TIMEOUT_MS = 5 * 60 * 1000; // the whole guard: static pass, the box start and the rerun's own 60 s limit
const PASSED = ["SUCCESS", "NEUTRAL", "SKIPPED"];

const commit = (v, what) => {
  if (typeof v !== "string" || !COMMIT_RE.test(v)) throw new TypeError(`git host: ${what} must be a full commit id`);
  return v;
};
const branchName = (v) => {
  if (typeof v !== "string" || !PUBLISH_BRANCH_RE.test(v)) throw new TypeError("git host: not a den branch name");
  return v;
};
const prNumber = (v) => {
  if (!Number.isInteger(v) || v < 1 || v > 999999999) throw new TypeError("git host: not a pull request number");
  return String(v);
};
const idOf = (v, what) => {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,19}$/.test(v)) throw new TypeError(`git host: not a ${what} id`);
  return v;
};
const oneLine = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩\u2028\u2029]/g, " ").trim().slice(0, max);

// One check of a pull request, from either shape the git host reports. -> { name, done, ok }
const checkOf = (raw) => {
  if (raw?.__typename === "StatusContext" || raw?.context !== undefined) return { name: oneLine(raw.context, 100), done: raw.state !== "PENDING" && raw.state !== "EXPECTED", ok: raw.state === "SUCCESS" };
  return { name: oneLine(raw?.name, 100), done: raw?.status === "COMPLETED", ok: raw?.status === "COMPLETED" && PASSED.includes(raw?.conclusion) };
};

// den-mvp/29: a check of an open pull request with what the CI watch needs: its job and run ids (from its Actions link)
// and whether it was cancelled (a timeout is a cancel; the job's annotations say which). -> { name, done, ok, cancelled, jobId, runId }
const watchedCheckOf = (raw) => {
  const link = /\/actions\/runs\/([0-9]{1,20})\/job\/([0-9]{1,20})/.exec(String(raw?.detailsUrl ?? ""));
  return { ...checkOf(raw), cancelled: raw?.conclusion === "CANCELLED", runId: link?.[1] ?? null, jobId: link?.[2] ?? null };
};

export function createGitHost(root, { exec = execFileP, remote = "origin", main = "main", riskScript = path.join(root, "scripts", "risk-check.mjs"), guardScript = path.join(root, "scripts", "test-guard.mjs"), env = process.env, waitMs = NO_CHECKS_WAIT_MS } = {}) {
  if (!NAME_RE.test(remote) || !NAME_RE.test(main)) throw new TypeError("git host: bad remote or branch name");
  const quiet = { ...env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  const git = async (...args) => String((await exec("git", ["-C", root, ...args], { env: quiet, maxBuffer: DIFF_MAX })).stdout);
  const gh = async (...args) => String((await exec("gh", args, { cwd: root, env: quiet, maxBuffer: 8 * 1024 * 1024 })).stdout);
  const view = async (number) => {
    const pr = JSON.parse(await gh("pr", "view", prNumber(number), "--json", "number,url,state,headRefOid,mergeable,statusCheckRollup"));
    return {
      number: pr.number, url: oneLine(pr.url, 300), state: ["OPEN", "MERGED", "CLOSED"].includes(pr.state) ? pr.state : "CLOSED",
      sha: COMMIT_RE.test(pr.headRefOid) ? pr.headRefOid : null, mergeable: ["MERGEABLE", "CONFLICTING"].includes(pr.mergeable) ? pr.mergeable : "UNKNOWN",
      checks: (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []).map(watchedCheckOf),
    };
  };
  return {
    /** The remote main branch as it is now: fetched, then read. -> a full commit id. */
    async mainSha() {
      await git("fetch", "--quiet", remote, main);
      return commit((await git("rev-parse", "--verify", `refs/remotes/${remote}/${main}^{commit}`)).trim(), "the main branch");
    },
    /** F29: the files that conflict when `sha` is merged with `main`, from a dry-run merge that touches no checkout. [] when clean. */
    async conflicts({ main: head, sha }) {
      try {
        await git("merge-tree", "--write-tree", "--name-only", "--no-messages", commit(head, "main"), commit(sha, "sha"));
        return [];
      } catch (err) {
        // Exit 1 is "the merge has conflicts": the first line is the tree, then one conflicting path per line.
        if (err?.code !== 1) throw err;
        return [...new Set(String(err.stdout ?? "").split("\n").slice(1).map((l) => l.trim()).filter(Boolean))].slice(0, 50);
      }
    },
    /** Is `sha` built on `base`? A commit made somewhere else in the history is not what the delivery started. */
    async descends({ base, sha }) {
      try {
        await git("merge-base", "--is-ancestor", commit(base, "base"), commit(sha, "sha"));
        return true;
      } catch (err) {
        if (err?.code === 1) return false;
        throw err;
      }
    },
    /** The repository paths a change touches. A rename is listed as both the path it left and the path it took. */
    async changed({ base, sha }) {
      return (await git("diff", "--name-only", "--no-renames", "-z", commit(base, "base"), commit(sha, "sha"))).split("\0").filter(Boolean);
    },
    /**
     * Does the change add a line that looks like a secret, or a file that is named like one? Every commit that would be
     * pushed is read, not the difference of the two ends, so a secret added and then removed is still seen; a binary file
     * is read as text. A secret built from parts at run time is not seen here.
     */
    async addsSecret({ base, sha }) {
      const range = `${commit(base, "base")}..${commit(sha, "sha")}`;
      const each = ["log", "--format=", "--no-color", "--no-ext-diff", "--no-renames", "--diff-merges=first-parent"];
      const names = (await git(...each, "--name-only", "--diff-filter=AM", "-z", range)).split("\0");
      if (names.some((f) => SECRET_FILE_RE.test(f.trim().split("/").pop()))) return true;
      const added = (await git(...each, "--text", "-U0", "-p", range)).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
      return added.some((l) => hasSecret(l));
    },
    /** The scripted risk check, run from the bridge's own checkout on the change. A repository with none reviews every change. */
    async risk({ base, sha }) {
      const range = `${commit(base, "base")}...${commit(sha, "sha")}`;
      if (!(await access(riskScript).then(() => true, () => false))) return { clean: false, hits: ["no scripted risk check here: security reviews the change"] };
      try {
        await exec(process.execPath, [riskScript, range], { cwd: root, env: quiet, maxBuffer: 4 * 1024 * 1024 });
        return { clean: true, hits: [] };
      } catch (err) {
        if (!Number.isInteger(err?.code) || err.code === 0) throw err;
        return { clean: false, hits: String(err.stdout ?? "").split("\n").map((l) => oneLine(l, 300)).filter(Boolean).slice(0, 50) };
      }
    },
    /**
     * den-mvp/70: the test-tamper guard, run from the bridge's own checkout on the change. Its hits go to the verifier; none
     * blocks. The changed tests run only inside bubblewrap (--require-box), under a time limit. A crash (not exit 0 or 1) throws.
     */
    async guard({ base, sha }) {
      const range = `${commit(base, "base")}...${commit(sha, "sha")}`;
      if (!(await access(guardScript).then(() => true, () => false))) return { hits: ["no test guard here: the verifier checks the tests by hand"] };
      const noResult = (why) => ({ hits: [`(guard): the test guard did not give a result (${oneLine(why, 150)}): the verifier checks the tests by hand`] });
      let code = 0;
      let stdout = "";
      let why = "";
      try {
        ({ stdout } = await exec(process.execPath, [guardScript, range, "--json"], { cwd: root, env: quiet, maxBuffer: 4 * 1024 * 1024, timeout: GUARD_TIMEOUT_MS, killSignal: "SIGKILL" }));
      } catch (err) {
        if (err?.killed || err?.signal === "SIGKILL") return { hits: [`(guard): the test guard did not finish in ${GUARD_TIMEOUT_MS / 1000} s: the verifier checks the tests by hand`] };
        code = Number.isInteger(err?.code) ? err.code : -1;
        stdout = err?.stdout;
        why = `exit ${code}: ${String(err?.stderr || err?.message || "")}`;
      }
      // The result is the JSON the script printed alone on stdout; a file name cannot forge it. A failure without one is a hit.
      let result = null;
      try {
        result = JSON.parse(String(stdout ?? ""));
      } catch {}
      const listed = Array.isArray(result?.hits) && result.hits.every((h) => typeof h?.file === "string" && typeof h?.reason === "string");
      if (!listed || (code !== 0 && result.hits.length === 0)) return noResult(why || "no JSON on stdout");
      return { hits: result.hits.map((h) => oneLine(`${h.file}: ${h.reason}`, 300)).slice(0, 50) };
    },
    /** Puts exactly this commit on the remote branch. A branch that has moved elsewhere is not forced. */
    async push({ branch, sha }) {
      await git("push", "--porcelain", remote, `${commit(sha, "sha")}:refs/heads/${branchName(branch)}`);
    },
    /** The pull request of a branch, an open one first. -> { number, url, state, sha } | null */
    async findPr({ branch }) {
      const list = JSON.parse(await gh("pr", "list", "--head", branchName(branch), "--state", "all", "--limit", "10", "--json", "number,url,state,headRefOid"));
      const found = (Array.isArray(list) ? list : []).filter((p) => Number.isInteger(p?.number));
      const pr = found.find((p) => p.state === "OPEN") ?? found.find((p) => p.state === "MERGED") ?? found[0];
      return pr ? { number: pr.number, url: oneLine(pr.url, 300), state: pr.state, sha: COMMIT_RE.test(pr.headRefOid) ? pr.headRefOid : null } : null;
    },
    async openPr({ branch, title, body }) {
      await gh("pr", "create", "--head", branchName(branch), "--base", main, "--title", oneLine(title, 200), "--body", String(body).slice(0, 8000));
    },
    /** -> { number, url, state, sha, mergeable, checks: [{ name, done, ok, cancelled, jobId, runId }] } as the git host reports it now. */
    prState: ({ number }) => view(number),
    /** Resolves once the pull request's checks have finished, whatever they showed; prState then says what they showed. */
    async waitChecks({ number }) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await gh("pr", "checks", prNumber(number), "--watch", "--interval", "15");
          return;
        } catch (err) {
          if (attempt >= NO_CHECKS_TRIES || !/no checks reported/i.test(String(err?.stderr ?? err?.message ?? ""))) return;
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    },
    /**
     * den-mvp/29: every open pull request, from inside the den or not. One call per poll.
     * -> [{ number, url, title, branch, sha, files: [path], checks: [{ name, done, ok, cancelled, jobId, runId }] }]
     */
    async openPrs() {
      const list = JSON.parse(await gh("pr", "list", "--state", "open", "--limit", "50", "--json", "number,url,title,headRefName,headRefOid,files,statusCheckRollup"));
      return (Array.isArray(list) ? list : []).filter((p) => Number.isInteger(p?.number) && COMMIT_RE.test(p?.headRefOid ?? "")).map((p) => ({
        number: p.number, url: oneLine(p.url, 300), title: oneLine(p.title, 200), branch: oneLine(p.headRefName, 200), sha: p.headRefOid,
        files: (Array.isArray(p.files) ? p.files : []).map((f) => String(f?.path ?? "")).filter(Boolean),
        checks: (Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : []).map(watchedCheckOf),
      }));
    },
    /** A job's annotation messages (a timeout says "exceeded the maximum execution time"). */
    async annotations({ jobId }) {
      const list = JSON.parse(await gh("api", `repos/{owner}/{repo}/check-runs/${idOf(jobId, "job")}/annotations`));
      return (Array.isArray(list) ? list : []).map((a) => oneLine(a?.message, 300));
    },
    /** The log lines of a job's failed steps. */
    failedLog: async ({ jobId }) => gh("run", "view", "--job", idOf(jobId, "job"), "--log-failed"),
    /** Runs a workflow run's failed (and cancelled) jobs again, on the same commit. */
    async rerunFailed({ runId }) {
      await gh("run", "rerun", idOf(runId, "run"), "--failed");
    },
    /** The commit a merged pull request left on the main branch. -> a full commit id */
    async mergeCommit({ number }) {
      const pr = JSON.parse(await gh("pr", "view", prNumber(number), "--json", "state,mergeCommit"));
      if (pr?.state !== "MERGED") throw new Error("the pull request is not merged");
      return commit(pr.mergeCommit?.oid, "the merge commit");
    },
    /** den-mvp/45: the newest release tag (v<major>.<minor>.<patch>) reachable from main, or null. */
    async lastTag() {
      await git("fetch", "--quiet", "--tags", remote);
      const tags = (await git("tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--merged", `refs/remotes/${remote}/${main}`, "--sort=-version:refname")).split("\n").map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
      return tags[0] ?? null;
    },
    /** den-mvp/45: the pull requests merged into `sha` since `tag` (null: all). -> [{ number, title, body }] */
    async mergedSince({ tag, sha }) {
      if (tag !== null && !/^v\d+\.\d+\.\d+$/.test(tag)) throw new TypeError("git host: not a release tag");
      const out = await git("log", "--first-parent", "-z", "--format=%s%x1f%b", tag === null ? commit(sha, "sha") : `refs/tags/${tag}..${commit(sha, "sha")}`);
      const prs = [];
      for (const rec of out.split("\0")) {
        const [subject = "", body = ""] = rec.replace(/^\n/, "").split("\x1f");
        const merge = /^Merge pull request #(\d+) from /.exec(subject);
        const squash = /^(.*) \(#(\d+)\)$/.exec(subject);
        if (merge) prs.push({ number: Number(merge[1]), title: oneLine(body.split("\n").find((l) => l.trim()) ?? subject, 200), body });
        else if (squash) prs.push({ number: Number(squash[2]), title: oneLine(squash[1], 200), body });
      }
      return prs;
    },
    /** den-mvp/45: tags `sha` and publishes the GitHub Release for it, in one call. The user's Approve is the only caller. */
    async publishRelease({ version, sha, notes }) {
      if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new TypeError("git host: not a release version");
      await gh("release", "create", version, "--target", commit(sha, "sha"), "--title", version, "--notes", String(notes).slice(0, 20000));
    },
    /** Merges the pull request only while its head is still this commit. */
    async merge({ number, sha }) {
      await gh("pr", "merge", prNumber(number), "--merge", "--match-head-commit", commit(sha, "sha"));
    },
  };
}

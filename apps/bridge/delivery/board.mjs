// den-mvp outcome 3 (spec sections 1 and 4): the board operations of a delivery job, made by the bridge. An agent of a
// delivery step writes nothing on the board; the bridge claims the ticket for the step's role, writes the handoff from
// what it recorded of the run, releases the ticket, and resolves it after the merge is confirmed. Every call names one
// ticket, the job's own, and goes through the board service, so the board's rules (who may release at which status,
// that a release needs a handoff) hold for the bridge too.
import { copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handoffNote, handoffRecord } from "../board/handoff-body.mjs";
import { claim, comment, publishHandoff, release, resolve } from "../../board/board-service.mjs";

const EVIDENCE_FILE_RE = /[^\s,;"'()<>]+\.(?:png|jpe?g|webp|json|txt)\b/gi;
const EVIDENCE_FILES_MAX = 12; // files of one qa run copied to the board
const EVIDENCE_FILE_BYTES = 10_000_000;

export function createDeliveryBoard(root) {
  return {
    /** Claims the ticket for a step's role. Rejects when another agent holds it. */
    claim: (ref, { role, mode }) => claim(root, ref, role, mode ? { mode } : {}),
    /**
     * Writes the step's handoff and releases the ticket at in-review. The State block is the bridge's own record of the
     * run; the agent's last message follows it as a quoted report, and is data to read.
     */
    // den-mvp/23: a Run from the den hands off the same way; `committed: false` says it left no commit, `source` names it.
    // `status: null` publishes the handoff and leaves the ticket alone (a Run holds no claim to release).
    async handoff(ref, { role, mode, runId, sha, branch, verdict, report, committed = true, source = "den delivery", status = "in-review" }) {
      const { name, body } = handoffRecord(ref, { role, mode, runId, sha, branch, verdict, report, committed });
      // The board refuses a draft that lies inside a worktree, so the draft is written in a directory of its own.
      const dir = await mkdtemp(path.join(tmpdir(), "den-handoff-"));
      try {
        const draft = path.join(dir, name);
        await writeFile(draft, body, { mode: 0o600 });
        await publishHandoff(root, ref, draft, { name });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      if (status === null) return;
      await release(root, ref, status, handoffNote({ role, sha, verdict, committed, source }));
    },
    /**
     * trust-ladder/03: the files a qa report names as verifier evidence, copied from qa's worktree (repo-relative `worktree`)
     * into .scratch/<feature>/evidence/<ticket>/, so they outlive the worktree; a comment on the ticket lists them. Only an image,
     * json or txt file that really lies inside that worktree is copied. -> the items, each copied path now the board's.
     */
    async keepEvidence(ref, { worktree, items, sha, runId }) {
      const [feature, ticket] = ref.split("/");
      const home = await realpath(path.join(root, worktree));
      const dest = `.scratch/${feature}/evidence/${ticket}`;
      const copied = [];
      const kept = [];
      for (const item of items) {
        let text = item;
        for (const token of new Set(item.match(EVIDENCE_FILE_RE) ?? [])) {
          const real = await realpath(path.resolve(home, token)).catch(() => null);
          if (!real || !real.startsWith(home + path.sep) || copied.length >= EVIDENCE_FILES_MAX) continue;
          const info = await stat(real);
          if (!info.isFile() || info.size > EVIDENCE_FILE_BYTES) continue;
          const rel = `${dest}/${runId.slice(2, 10)}-${path.basename(real).replace(/[^\w.-]/g, "_")}`;
          await mkdir(path.join(root, dest), { recursive: true });
          await copyFile(real, path.join(root, rel));
          copied.push(rel);
          text = text.split(token).join(rel);
        }
        kept.push(text);
      }
      if (copied.length) await comment(root, ref, `verifier evidence at ${sha.slice(0, 12)}: ${copied.join(", ")}`);
      return kept;
    },
    /** den-v1/15: a den task's ticket is claimed at its end, so the handoff that follows can release it at in-review. */
    claimForHandoff: (ref, { role }) => claim(root, ref, role, role === "qa" ? { mode: "verify" } : {}),
    /** Gives up a step's claim without a handoff: the run failed, was stopped, or left nothing to hand on. */
    drop: (ref, { status, reason }) => release(root, ref, status, reason, status === undefined ? { force: true, keepStatus: true } : { force: true }),
    /** After a confirmed merge. */
    resolve: (ref, pr, note = "merged by the den's delivery") => resolve(root, [ref], { pr: String(pr), note }),
  };
}

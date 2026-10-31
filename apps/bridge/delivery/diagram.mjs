// portable-den/09: the docviz diagram of a delivery's pull request. The bridge runs `docviz pr` itself, on the host, from
// the candidate's checkout: no agent starts the nested claude/codex CLI behind the wall. The steps file is the developer's
// (untrusted text), so it is checked here before docviz reads any file it names.
//   readDiagramSteps(report) -> { steps } | null    the `## Diagram steps` section of a handoff: one ```json block
//   createDocviz({ root, exec?, env? }) -> { available(), run({ worktree, sha, steps, prUrl, title }) -> the comment text }
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { onPath, runDocviz } from "../../../scripts/docviz-pr.mjs";

const execFileP = promisify(execFile);
const ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const PATH_RE = /^(?![/.])(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@.+/-]{1,200}$/;
const SECRET_NAME_RE = /(?:^|\/)(?:\.env(?!\.example$)[^/]*|[^/]*\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519))$/i;
const text = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const marker = (v) => v === undefined || text(v, 200);

const sourceOk = (s) => PATH_RE.test(s?.path ?? "") && !SECRET_NAME_RE.test(s.path) && marker(s.from) && marker(s.to);
const stepOk = (s) => ID_RE.test(s?.id ?? "") && text(s.label, 120) && (s.changed === undefined || typeof s.changed === "boolean") && Array.isArray(s.sources) && s.sources.length >= 1 && s.sources.length <= 4 && s.sources.every(sourceOk);

export function readDiagramSteps(report) {
  if (typeof report !== "string") return null;
  const lines = report.split(/\r?\n/);
  const at = lines.findLastIndex((l) => /^##[ \t]+Diagram steps[ \t]*$/i.test(l));
  if (at < 0) return null;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^##[ \t]/.test(l));
  const section = (end < 0 ? rest : rest.slice(0, end)).join("\n");
  const fence = /```json[ \t]*\n([\s\S]*?)\n```/.exec(section);
  if (!fence) return null;
  try {
    const { steps } = JSON.parse(fence[1]);
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 12 || !steps.every(stepOk) || new Set(steps.map((s) => s.id)).size !== steps.length) return null;
    return { steps: steps.map((s) => ({ id: s.id, label: s.label, ...(s.changed === undefined ? {} : { changed: s.changed }), sources: s.sources.map(({ path: p, from, to }) => ({ path: p, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) })) })) };
  } catch {
    return null;
  }
}

export function createDocviz({ root: control, exec = execFileP, env = process.env } = {}) {
  return {
    available: () => onPath("docviz", env),
    async run({ worktree: relative, sha, steps, prUrl, title }) {
      const worktree = path.resolve(control, relative); // the host names a worktree relative to the control checkout
      const head = String((await exec("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout).trim();
      if (head !== sha) throw new Error("the candidate's checkout is not at the commit the pull request holds");
      const root = await realpath(worktree);
      // A step may only name a file inside the checkout: a symlink out of it is refused.
      for (const s of steps) for (const src of s.sources) {
        const real = await realpath(path.join(root, src.path)).catch(() => null);
        if (!real || !real.startsWith(`${root}${path.sep}`)) throw new Error(`step ${s.id}: ${src.path} is not a file of the checkout`);
      }
      const glossary = await realpath(path.join(root, "CONTEXT.md")).then((p) => (p.startsWith(`${root}${path.sep}`) ? p : undefined), () => undefined);
      const dir = await mkdtemp(path.join(tmpdir(), "docviz-steps-"));
      try {
        const stepsFile = path.join(dir, "steps.json");
        await writeFile(stepsFile, JSON.stringify({ steps }));
        return await runDocviz({ stepsFile, prUrl, title, glossaryFile: glossary, cwd: root, env, exec });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

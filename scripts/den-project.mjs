// den-mvp/49: onboard, list and remove projects the den can run agents in (ADR 0021 Amendment 5).
//   npm run den:project -- add <slug> <path> [--board markdown|github-issues] [--repo owner/name]
//   npm run den:project -- list | remove <slug>
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { verifyProtection } from "../apps/bridge/project-verify.mjs";
import { addProject, createProjects, removeProject } from "../apps/bridge/projects.mjs";

const stateHome = path.isAbsolute(process.env.XDG_STATE_HOME ?? "") ? process.env.XDG_STATE_HOME : path.join(homedir(), ".local", "state");
const denState = path.isAbsolute(process.env.DEN_STATE_DIR ?? "") ? process.env.DEN_STATE_DIR : path.join(stateHome, "den");
const [cmd, ...rest] = process.argv.slice(2);
const list = (name) => rest.flatMap((a, i) => (a === `--${name}` ? [rest[i + 1]] : []));
const flag = (name) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined);
let result;
if (cmd === "add") {
  const [slug, dir] = rest;
  result = await addProject(denState, { slug, path: dir === undefined ? undefined : path.resolve(dir), board: { kind: flag("board") ?? "markdown", repo: flag("repo") }, checks: (flag("checks") ?? "").split(",").filter(Boolean), toolchain: list("toolchain").map((p) => path.resolve(p)), control: process.cwd() });
} else if (cmd === "remove") {
  result = await removeProject(denState, rest[0]);
} else if (cmd === "verify") {
  const row = JSON.parse(await readFile(path.join(denState, "projects.json"), "utf8").catch(() => "{}"))[rest[0]];
  if (!row?.board?.repo) result = { ok: false, reason: "verify needs an onboarded project with a github-issues board (board.repo)" };
  else if (!row.checks?.length) result = { ok: false, reason: "the project has no checks; onboard it with --checks" };
  else {
    const v = await verifyProtection({ repo: row.board.repo, checks: row.checks });
    console.log(v.ok ? `main of ${row.board.repo} requires ${row.checks.join(", ")}` : `main of ${row.board.repo} lacks: ${v.missing.join(", ")}. The user runs (nothing was applied):\n${v.command}`);
    result = { ok: v.ok, reason: "branch protection is incomplete" };
  }
} else if (cmd === "list") {
  for (const p of await createProjects({ control: process.cwd(), denState }).list()) console.log(`${p.active ? "*" : " "} ${p.slug}\t${p.board.kind}\t${p.path}`);
  result = { ok: true };
} else {
  console.error("usage: den:project -- add <slug> <path> [--board kind] [--repo owner/name] [--checks a,b] [--toolchain <path>]... | verify <slug> | list | remove <slug>");
  process.exit(2);
}
if (!result.ok) {
  console.error(`den:project: ${result.reason}`);
  process.exit(1);
}

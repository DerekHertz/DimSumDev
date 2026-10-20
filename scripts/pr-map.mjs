#!/usr/bin/env node
// informative-prs/01: the system map and blast radius for a PR body. prMap() is pure: the map definition
// (docs/system-map.json), the tracked files, the import arrows and the changed paths in; Mermaid text, the
// blast radius and the unmapped paths out. The CLI reads those from git and prints a block ready to paste.
//
// Usage: node scripts/pr-map.mjs [--base <ref>] [--head <ref>]   (default: merge-base of HEAD and origin/main..HEAD)
//
// A module is a file with its tests folded in (rig.test.mjs belongs to rig), or, under one of an area's
// `folders`, each child folder. A module is edited when a changed path is in it, and rippled when a non-test
// file in it imports an edited module, or its area declares a link to an edited area. Ripple is one hop.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_NODES = 25;
export const LEGEND = "Legend: filled = edited · dashed outline = uses an edited part (one hop) · grey = untouched, with its module count · arrows point from a part to what it uses.";
// GitHub draws Mermaid on a light or a dark page; these read on both, and fill, outline and grey differ in shape, not only hue.
const CLASSES = [
  "classDef edited fill:#1f6feb,stroke:#1f6feb,color:#ffffff",
  "classDef rippled fill:none,stroke:#d4a72c,stroke-width:2px,stroke-dasharray:5 3",
  "classDef untouched fill:#8c959f1a,stroke:#8c959f,color:#8c959f",
];

const globRe = (glob) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);
const literalDir = (glob) => {
  const lit = glob.split("*")[0];
  return lit.includes("/") ? lit.slice(0, lit.lastIndexOf("/") + 1) : "";
};

// Every area whose paths match the file; the coverage test wants exactly one.
export function areasOf(map, file) {
  return map.areas.filter((a) => a.paths.some((g) => globRe(g).test(file))).map((a) => a.id);
}

const isTest = (file) => /\.(test|spec)\./.test(path.posix.basename(file));

function moduleOf(area, file) {
  for (const f of area.folders ?? []) {
    if (!file.startsWith(`${f}/`)) continue;
    const child = file.slice(f.length + 1).split("/")[0];
    return `${f}/${child}`;
  }
  const base = path.posix.basename(file);
  const stem = base.startsWith(".") ? base : base.split(".")[0];
  return path.posix.join(path.posix.dirname(file), stem);
}

const label = (s) => s.replace(/"/g, "#quot;");
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function prMap({ map, files, imports, changed }) {
  const areaIndex = new Map(map.areas.map((a, i) => [a.id, i]));
  const byId = new Map(map.areas.map((a) => [a.id, a]));
  const locate = (file) => {
    const id = areasOf(map, file)[0];
    return id ? { area: id, module: moduleOf(byId.get(id), file) } : null;
  };

  // Every module of every area, from the tracked files plus the changed ones (a deleted file is still a change).
  const modules = new Map(map.areas.map((a) => [a.id, new Set()]));
  const where = new Map();
  for (const f of new Set([...files, ...changed])) {
    const at = locate(f);
    if (!at) continue;
    where.set(f, at);
    modules.get(at.area).add(at.module);
  }

  const unmapped = changed.filter((f) => !where.has(f));
  const edited = new Set(changed.filter((f) => where.has(f)).map((f) => where.get(f).module));
  const editedAreas = new Set(changed.filter((f) => where.has(f)).map((f) => where.get(f).area));

  // One hop through imports: a non-test file in another module that imports an edited module.
  const rippled = new Set();
  const arrows = new Set();
  for (const [from, to] of imports) {
    const a = where.get(from), b = where.get(to);
    if (!a || !b || a.module === b.module || !edited.has(b.module) || isTest(from)) continue;
    if (!edited.has(a.module)) rippled.add(a.module);
    arrows.add(`${a.module}\0${b.module}`);
  }
  // One hop through declared links: an area that declares a link to an edited area.
  const linkRippled = new Set(map.links.filter((l) => editedAreas.has(l.to) && !editedAreas.has(l.from)).map((l) => l.from));

  const areaOfModule = new Map([...modules].flatMap(([area, ms]) => [...ms].map((m) => [m, area])));
  const shown = [...edited, ...rippled];
  const opened = new Set(shown.map((m) => areaOfModule.get(m)));
  const state = (id) => (editedAreas.has(id) ? "edited" : opened.has(id) || linkRippled.has(id) ? "rippled" : "untouched");
  const blastRadius = map.areas.map((a) => a.id).filter((id) => state(id) !== "untouched");

  const areaId = (id) => `a_${id.replace(/\W/g, "_")}`;
  const links = map.links.map((l) => `  ${areaId(l.from)} -.->|${label(l.label)}| ${areaId(l.to)}`);
  const restOf = (id) => [...modules.get(id)].filter((m) => !edited.has(m) && !rippled.has(m)).length;
  // The area boxes show on every map, so the limit counts only the parts this change edits or ripples.
  const collapsed = shown.length > MAX_NODES;

  const lines = ["flowchart LR"];
  if (collapsed) {
    for (const a of map.areas) {
      const mine = [...edited].filter((m) => areaOfModule.get(m) === a.id).length;
      lines.push(`  ${areaId(a.id)}["${label(a.id)} · ${mine} of ${modules.get(a.id).size} edited"]:::${state(a.id)}`);
    }
  } else {
    const nodeId = new Map(shown.map((m, i) => [m, `m${i}`]));
    let dirs = 0;
    for (const a of map.areas) {
      if (!opened.has(a.id)) {
        lines.push(`  ${areaId(a.id)}["${label(a.id)} · ${count(modules.get(a.id).size, "module")}"]:::${state(a.id)}`);
        continue;
      }
      lines.push(`  subgraph ${areaId(a.id)}["${label(a.id)}"]`);
      // Group the area's shown modules by folder, relative to where the area's paths start.
      const groups = new Map();
      for (const m of shown.filter((m) => areaOfModule.get(m) === a.id)) {
        const root = literalDir(a.paths[0]); // only the first path's folder is trimmed, so a mirror keeps its own
        const rel = root && m.startsWith(root) ? m.slice(root.length) : m;
        const dir = path.posix.dirname(rel);
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push([m, path.posix.basename(rel)]);
      }
      for (const [dir, ms] of [...groups].sort(([x], [y]) => x.localeCompare(y))) {
        const indent = dir === "." ? "    " : "      ";
        if (dir !== ".") lines.push(`    subgraph d${dirs++}["${label(dir)}"]`);
        for (const [m, name] of ms.sort(([, x], [, y]) => x.localeCompare(y))) lines.push(`${indent}${nodeId.get(m)}["${label(name)}"]:::${edited.has(m) ? "edited" : "rippled"}`);
        if (dir !== ".") lines.push("    end");
      }
      const rest = restOf(a.id);
      if (rest) lines.push(`    ${areaId(a.id)}_rest["+${count(rest, "other module")}"]:::untouched`);
      lines.push("  end");
    }
    for (const arrow of [...arrows].sort()) {
      const [from, to] = arrow.split("\0");
      lines.push(`  ${nodeId.get(from)} --> ${nodeId.get(to)}`);
    }
  }
  lines.push(...links, ...CLASSES.map((c) => `  ${c}`));

  return { mermaid: lines.join("\n"), blastRadius, unmapped, collapsed, legend: LEGEND };
}

// Text from the branch as one markdown code span: the fence is longer than any backtick run inside, so nothing in it can end the span.
export function codeSpan(text) {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  return fence.length === 1 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

// The block a PR body's System map section pastes in, with the blast radius for its Risk section.
// `radius: false` leaves the blast radius line out, for a body that puts it in its Risk section.
export function renderBlock({ mermaid, blastRadius, unmapped, collapsed, legend }, { radius = true } = {}) {
  return [
    "```mermaid",
    mermaid,
    "```",
    "",
    legend,
    ...(collapsed ? [`Collapsed to areas: the change edits or ripples more than ${MAX_NODES} modules, so each area shows its count of edited modules.`] : []),
    ...(unmapped.length ? [`Unmapped: ${unmapped.map(codeSpan).join(", ")} (no area in docs/system-map.json claims these).`] : []),
    "",
    ...(radius ? [`**Blast radius:** ${blastRadius.length ? blastRadius.join(", ") : "none"}`, ""] : []),
  ].join("\n");
}

// --- CLI: read the inputs from git ---

const CODE = /\.(mjs|cjs|js|jsx|ts|tsx)$/;
// shortcut: the clause between import and from is capped at 1000 characters, because an unbounded lazy scan was quadratic on a file of repeated "import"; a longer clause is missed, so raise the cap if a real import list outgrows it.
const IMPORT_RE = /(?:^|[^\w.$])(?:import|export)\s+(?:[^'"`;]{0,1000}?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

// The specifiers a file imports.
export function specifiers(text) {
  // A whitespace run becomes one space first: `\s+` next to the clause class backtracked quadratically on 'import' plus 200k spaces.
  return [...text.replace(/\s+/g, " ").matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]);
}

// The tracked file a specifier names: a relative path, or a workspace package by its name.
export function resolveImport(from, spec, fileSet, packages = {}) {
  let base;
  if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else {
    const name = Object.keys(packages).find((n) => spec === n || spec.startsWith(`${n}/`));
    if (!name) return null;
    base = path.posix.join(packages[name], spec.slice(name.length));
  }
  const exts = ["", ".mjs", ".js", ".jsx", ".ts", ".tsx", ".cjs", ".json"];
  for (const c of [...exts.map((e) => base + e), ...exts.slice(1).map((e) => `${base}/index${e}`)]) if (fileSet.has(c)) return c;
  return null;
}

const PACKAGE_JSON = /^packages\/[^/]+\/package\.json$/;

// The [from, to] import pairs among the tracked files; `text(file)` gives a file's text, or undefined.
export function importsOf(files, text) {
  const fileSet = new Set(files);
  const packages = {};
  for (const pj of files.filter((f) => PACKAGE_JSON.test(f))) {
    const name = JSON.parse(text(pj) ?? "{}").name;
    if (name) packages[name] = path.posix.dirname(pj);
  }
  const imports = [];
  for (const from of files.filter((f) => CODE.test(f))) {
    for (const spec of specifiers(text(from) ?? "")) {
      const to = resolveImport(from, spec, fileSet, packages);
      if (to) imports.push([from, to]);
    }
  }
  return imports;
}

// The map of a tree on disk: the bridge's own checkout, or a release folder (a git archive, so no .git: its files are walked).
// It is main, plus whatever the changed paths add; the candidate's own tree is not read.
export function checkoutMap(cwd, changed) {
  const walk = (dir) => readdirSync(path.join(cwd, dir), { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" || e.name === ".git" ? [] : e.isDirectory() ? walk(path.posix.join(dir, e.name)) : [path.posix.join(dir, e.name)]);
  let files;
  try { files = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); } catch { files = walk("."); }
  const map = JSON.parse(readFileSync(path.join(cwd, "docs/system-map.json"), "utf8"));
  const read = (f) => { try { return readFileSync(path.join(cwd, f), "utf8"); } catch { return undefined; } };
  return prMap({ map, files, imports: importsOf(files, read), changed });
}

function readAt(cwd, ref, paths) {
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd, input: paths.map((p) => `${ref}:${p}`).join("\n") + "\n", maxBuffer: 1 << 30 });
  const texts = new Map();
  let at = 0;
  for (const p of paths) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString();
    at = nl + 1;
    if (header.endsWith("missing")) continue;
    const size = Number(header.split(" ")[2]);
    texts.set(p, out.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return texts;
}

function main(argv) {
  const cwd = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 }).trim();
  // A ref is resolved to a commit id before any other git call sees it, so `--base --output=<path>` can't act as an option.
  const ref = (value) => {
    try { return git("rev-parse", "--verify", "--quiet", "--end-of-options", `${value}^{commit}`); } catch {
      process.stderr.write(`pr-map: ${value} is not a ref\n`);
      process.exit(2);
    }
  };
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? ref(argv[i + 1]) : undefined; };
  const head = arg("--head") ?? "HEAD";
  let base = arg("--base");
  if (!base) {
    try { base = git("merge-base", head, "origin/main"); } catch { base = git("merge-base", head, "main"); }
  }
  const map = JSON.parse(readFileSync(path.join(cwd, "docs/system-map.json"), "utf8"));
  const files = git("ls-tree", "-r", "--name-only", head).split("\n").filter(Boolean);
  const changed = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
  const texts = readAt(cwd, head, files.filter((f) => CODE.test(f) || PACKAGE_JSON.test(f)));
  const imports = importsOf(files, (f) => texts.get(f));
  process.stdout.write(renderBlock(prMap({ map, files, imports, changed })));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

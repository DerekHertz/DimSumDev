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
import { readFileSync, realpathSync } from "node:fs";
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

// The block a PR body's System map section pastes in, with the blast radius for its Risk section.
export function renderBlock({ mermaid, blastRadius, unmapped, collapsed, legend }) {
  return [
    "```mermaid",
    mermaid,
    "```",
    "",
    legend,
    ...(collapsed ? [`Collapsed to areas: the change edits or ripples more than ${MAX_NODES} modules, so each area shows its count of edited modules.`] : []),
    ...(unmapped.length ? [`Unmapped: ${unmapped.map((p) => `\`${p}\``).join(", ")} (no area in docs/system-map.json claims these).`] : []),
    "",
    `**Blast radius:** ${blastRadius.length ? blastRadius.join(", ") : "none"}`,
    "",
  ].join("\n");
}

// --- CLI: read the inputs from git ---

const CODE = /\.(mjs|cjs|js|jsx|ts|tsx)$/;
const IMPORT_RE = /(?:^|[^\w.$])(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

// The specifiers a file imports.
export function specifiers(text) {
  return [...text.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]);
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
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const head = arg("--head") ?? "HEAD";
  let base = arg("--base");
  if (!base) {
    try { base = git("merge-base", head, "origin/main"); } catch { base = git("merge-base", head, "main"); }
  }
  const map = JSON.parse(readFileSync(path.join(cwd, "docs/system-map.json"), "utf8"));
  const files = git("ls-tree", "-r", "--name-only", head).split("\n").filter(Boolean);
  const changed = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
  const fileSet = new Set(files);
  const packages = {};
  for (const pj of files.filter((f) => /^packages\/[^/]+\/package\.json$/.test(f))) {
    const { name } = JSON.parse(readAt(cwd, head, [pj]).get(pj));
    if (name) packages[name] = path.posix.dirname(pj);
  }
  const code = files.filter((f) => CODE.test(f));
  const texts = readAt(cwd, head, code);
  const imports = [];
  for (const [from, text] of texts) {
    for (const spec of specifiers(text)) {
      const to = resolveImport(from, spec, fileSet, packages);
      if (to) imports.push([from, to]);
    }
  }
  process.stdout.write(renderBlock(prMap({ map, files, imports, changed })));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

// informative-prs/01: the PR map draws the system map with a PR's edited parts filled and their direct dependents outlined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prMap, areasOf, renderBlock, MAX_NODES } from "./pr-map.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const MAP = {
  areas: [
    { id: "ui", paths: ["ui/**"], folders: ["ui/assets"] },
    { id: "bridge", paths: ["bridge/**"] },
    { id: "board", paths: ["board/**"] },
    { id: "docs", paths: ["docs/**", "README.md"] },
  ],
  links: [
    { from: "ui", to: "bridge", label: "HTTP" },
    { from: "bridge", to: "board", label: "board CLI" },
  ],
};
const FILES = [
  "ui/app.mjs", "ui/app.test.mjs", "ui/scene/rig.mjs", "ui/scene/rig.test.mjs", "ui/scene/world.mjs", "ui/scene/garden.mjs",
  "ui/assets/pandas/a.glb", "ui/assets/pandas/b.glb", "ui/assets/trees/c.glb",
  "bridge/server.mjs", "bridge/runner.mjs", "board/cli.mjs", "docs/adr.md", "README.md",
];
// [importer, imported]: world and the rig's test use the rig; app uses world; only app's test uses garden.
const IMPORTS = [["ui/scene/world.mjs", "ui/scene/rig.mjs"], ["ui/scene/rig.test.mjs", "ui/scene/rig.mjs"], ["ui/app.test.mjs", "ui/scene/garden.mjs"], ["ui/app.mjs", "ui/scene/world.mjs"], ["bridge/server.mjs", "bridge/runner.mjs"]];
const run = (changed, extra = {}) => prMap({ map: MAP, files: FILES, imports: IMPORTS, changed, ...extra });
// The node line for a label, and the class it carries.
const nodeOf = (mermaid, label) => mermaid.split("\n").find((l) => l.includes(`["${label}`));
const classOf = (mermaid, label) => nodeOf(mermaid, label)?.match(/:::(\w+)/)?.[1];

test("a change in one area opens that area only; the others are one box with their module count", () => {
  const { mermaid } = run(["ui/scene/garden.mjs"]);
  assert.match(mermaid, /subgraph a_ui\["ui"\]/);
  assert.doesNotMatch(mermaid, /subgraph a_bridge/);
  assert.equal(classOf(mermaid, "bridge · 2 modules"), "untouched");
  assert.equal(classOf(mermaid, "board · 1 module"), "untouched");
  assert.equal(classOf(mermaid, "docs · 2 modules"), "untouched");
  assert.equal(classOf(mermaid, "garden"), "edited");
  assert.match(mermaid, /subgraph \w+\["scene"\]/, "modules sit in a subgraph named for their folder");
});

test("an opened area folds its untouched modules into one count", () => {
  const { mermaid } = run(["ui/scene/garden.mjs"]);
  // ui has app, scene/rig, scene/world, scene/garden, assets/pandas, assets/trees: six modules, one edited.
  assert.equal(classOf(mermaid, "+5 other modules"), "untouched");
});

test("a test file folds into the module it tests, and a folder module stands for its files", () => {
  const { mermaid, blastRadius } = run(["ui/scene/rig.test.mjs", "ui/assets/pandas/b.glb"]);
  assert.equal(classOf(mermaid, "rig"), "edited");
  assert.equal(classOf(mermaid, "pandas"), "edited");
  assert.equal(nodeOf(mermaid, "b.glb"), undefined);
  assert.deepEqual(blastRadius, ["ui"], "nothing declares a link into ui");
});

test("ripple is one hop through an import: the importer is outlined, its importer is not", () => {
  const { mermaid } = run(["ui/scene/rig.mjs"]);
  assert.equal(classOf(mermaid, "rig"), "edited");
  assert.equal(classOf(mermaid, "world"), "rippled");
  assert.equal(nodeOf(mermaid, "app"), undefined, "app imports world, two hops from rig: not shown");
  assert.match(mermaid, /m\d+ --> m\d+/, "an arrow runs from world to rig");
});

test("a test that imports an edited module does not mark anything rippled", () => {
  const { mermaid } = run(["ui/scene/garden.mjs"]);
  assert.equal(nodeOf(mermaid, "app"), undefined, "app's test imports garden; app itself does not");
  assert.equal(classOf(run(["ui/scene/world.mjs"]).mermaid, "app"), "rippled");
});

test("ripple is one hop through a declared link: board edited outlines bridge, not ui", () => {
  const { mermaid, blastRadius } = run(["board/cli.mjs"]);
  assert.match(mermaid, /subgraph a_board/);
  assert.match(nodeOf(mermaid, "bridge · 2 modules"), /:::rippled/);
  assert.match(nodeOf(mermaid, "ui · 6 modules"), /:::untouched/);
  assert.match(mermaid, /a_bridge -\.->\|board CLI\| a_board/);
  assert.deepEqual(blastRadius, ["bridge", "board"], "edited and rippled areas, in map order");
});

test("blast radius lists edited and rippled areas in map order", () => {
  assert.deepEqual(run(["docs/adr.md", "bridge/runner.mjs"]).blastRadius, ["ui", "bridge", "docs"]);
  assert.deepEqual(run(["README.md"]).blastRadius, ["docs"]);
});

test("a legend follows the diagram and the block is ready to paste", () => {
  const result = run(["bridge/runner.mjs"]);
  const block = renderBlock(result);
  assert.match(block, /```mermaid\n[\s\S]*\n```\n/);
  assert.match(block, /filled = edited/);
  assert.match(block, /dashed outline = /);
  assert.match(block, /grey = untouched/);
  assert.match(block, /\*\*Blast radius:\*\* ui, bridge/);
  assert.match(block.split("```").at(-1), /filled = edited/, "the legend comes after the diagram");
});

test("classes give each state a distinct fill or outline, not only a color", () => {
  const { mermaid } = run(["bridge/runner.mjs"]);
  assert.match(mermaid, /classDef edited fill:#[0-9a-f]{6},/);
  assert.match(mermaid, /classDef rippled fill:none,[^\n]*stroke-dasharray/);
  assert.match(mermaid, /classDef untouched [^\n]*stroke:#8c959f/);
});

test("past the node limit the map collapses to areas labelled with edited counts, and says so", () => {
  const many = Array.from({ length: MAX_NODES + 5 }, (_, i) => `ui/gen/m${i}.mjs`);
  const result = prMap({ map: MAP, files: [...FILES, ...many], imports: IMPORTS, changed: many });
  assert.equal(result.collapsed, true);
  assert.doesNotMatch(result.mermaid, /subgraph/);
  assert.equal(classOf(result.mermaid, `ui · ${many.length} of ${many.length + 6} edited`), "edited");
  assert.equal(classOf(result.mermaid, "bridge · 0 of 2 edited"), "untouched");
  assert.match(renderBlock(result), /collapsed to areas/i);
  assert.equal(run(["ui/app.mjs"]).collapsed, false);
});

test("a mirror under an area's second path stays in its own labelled folder", () => {
  const map = { areas: [{ id: "roles", paths: [".claude/agents/**", ".codex/agents/**"] }], links: [] };
  const files = [".claude/agents/dev.md", ".codex/agents/dev.toml"];
  const { mermaid } = prMap({ map, files, imports: [], changed: files });
  assert.match(mermaid, /subgraph \w+\["\.codex\/agents"\]\n\s+m\d+\["dev"\]/);
  assert.equal(mermaid.match(/subgraph d/g).length, 1, "the first path's modules sit at the area's top");
});

test("the node limit counts edited and rippled parts, not the area boxes every map shows", () => {
  const areas = Array.from({ length: MAX_NODES }, (_, i) => ({ id: `area${i}`, paths: [`area${i}/**`] }));
  const files = areas.flatMap((a) => [`${a.id}/x.mjs`, `${a.id}/y.mjs`]);
  const changed = areas.slice(0, 5).map((a) => `${a.id}/x.mjs`);
  assert.equal(prMap({ map: { areas, links: [] }, files, imports: [], changed }).collapsed, false);
});

test("a changed path with no area is reported, not dropped", () => {
  const result = run(["stray/file.txt", "ui/app.mjs"]);
  assert.deepEqual(result.unmapped, ["stray/file.txt"]);
  assert.match(renderBlock(result), /Unmapped: `stray\/file\.txt`/);
});

test("a deleted file still shows as edited", () => {
  assert.equal(classOf(run(["ui/scene/gone.mjs"]).mermaid, "gone"), "edited");
});

test("every git-tracked file belongs to exactly one area of the real map", () => {
  const map = JSON.parse(readFileSync(path.join(ROOT, "docs/system-map.json"), "utf8"));
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const unmapped = files.filter((f) => areasOf(map, f).length === 0);
  const doubled = files.filter((f) => areasOf(map, f).length > 1).map((f) => `${f} (${areasOf(map, f).join(", ")})`);
  assert.deepEqual(unmapped, [], `files in no area of docs/system-map.json:\n${unmapped.join("\n")}`);
  assert.deepEqual(doubled, [], `files in more than one area:\n${doubled.join("\n")}`);
});

test("every declared link in the real map joins two areas it declares", () => {
  const map = JSON.parse(readFileSync(path.join(ROOT, "docs/system-map.json"), "utf8"));
  const ids = new Set(map.areas.map((a) => a.id));
  for (const l of map.links) assert.ok(ids.has(l.from) && ids.has(l.to) && l.label, JSON.stringify(l));
});

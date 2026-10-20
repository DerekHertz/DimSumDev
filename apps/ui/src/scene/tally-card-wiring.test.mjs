// den-scene-v1/05: source and stylesheet checks for the expanded Tally card, for the criteria that
// the focused browser scenarios supplement: shared fixture CSS tokens and the removal
// of the old scroll-to-dashboard route. Main-app placement is verified in the Garden & Desk browser tests. Spec: handoffs/05-designer-spec-2.md sections 1, 3, 5, 7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const app = read("../App.jsx");
const css = read("../styles.css");
const chips = read("./ChipLayer.jsx");

test("the removed dashboard sidebar slot is replaced by a Tally rail topic", () => {
  assert.doesNotMatch(app, /openDashboard/, "replaced by open/close/toggle Tally state");
  assert.doesNotMatch(app, /dashboardOpens/);
  assert.doesNotMatch(app, /h-dashboard/, "the Pipeline heading is no longer a sidebar slot");
  assert.doesNotMatch(app, /h-dashboard.*scrollIntoView|dashboard.*scrollTop/, "Tally no longer jumps to an old dashboard sidebar slot");
  assert.doesNotMatch(app, /\["dashboard", "Pipeline"\]/, "the sidebar Pipeline slot is gone");
  const rail = read("../shell/rail-model.mjs");
  assert.match(rail, /id: "tally", label: "Tally", icon: "bars", slot: "topic"/);
  assert.match(read("../shell/Rail.jsx"), /data-rail=\{entry\.id\}/);
  assert.match(read("../shell/Sheet.jsx"), /data-sheet=\{slot\}/);
});

test("the usage meter is off the cards (07 removed it); it lives on the Tally", () => {
  const cards = read("../overlay/Cards.jsx");
  assert.doesNotMatch(app + cards, /Plan usage \(5 h\)/);
  assert.doesNotMatch(app + cards, /<UsageMeter/);
  assert.match(read("./tally-face.mjs"), /usage-meter-model/, "the Tally face still reads the usage model");
});

test("the Dashboard remains mounted once and the rail owns the Tally destination", () => {
  const jsx = (dir) => readdirSync(new URL(dir, import.meta.url)).filter((f) => f.endsWith(".jsx")).map((f) => read(dir + f));
  const all = [...jsx("./"), ...jsx("../panel/"), app].join("\n");
  assert.equal((all.match(/<Dashboard\b/g) ?? []).length, 1, "Dashboard mounted exactly once");
  assert.match(app, /useMetrics/);
  assert.match(read("../shell/rail-model.mjs"), /id: "tally", label: "Tally"/);
  assert.match(read("./TallyCard.jsx"), /role="region" aria-label="Tally metrics"/);
  assert.doesNotMatch(app + chips, /Today's board/);
});

test("the card is a non-modal dialog whose Esc handling stops arrow keys reaching the camera rig", () => {
  const jsx = (dir) => readdirSync(new URL(dir, import.meta.url)).filter((f) => f.endsWith(".jsx")).map((f) => read(dir + f));
  const sources = [...jsx("./"), ...jsx("../panel/"), app].join("\n");
  assert.match(sources, /role="dialog"/);
  assert.match(sources, /aria-modal="false"/);
  assert.match(sources, /stopPropagation/, "keydown is stopped before it reaches main's camera listener");
  assert.match(sources, /Escape/);
});

test("design tokens the card and the bead slide need are in styles.css: --dur-base 240ms, --shadow-panel, --team-steamers", () => {
  assert.match(css, /--dur-base:\s*240ms/);
  assert.match(css, /--shadow-panel:/);
  assert.match(css, /--team-steamers:/);
});

test("the full-window Tally is hosted inside a non-modal topic sheet", () => {
  const all = css + app + chips + readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".jsx")).map((f) => read(`./${f}`)).join("\n");
  assert.match(read("../shell/Sheet.jsx"), /role="dialog" aria-modal="false"/);
  assert.match(all, /TallyBody/);
  assert.doesNotMatch(app, /Your desk/);
});

test("the full-window Tally no longer has the deferred phone bottom-sheet layout", () => {
  assert.doesNotMatch(read("../shell/forest.css"), /\.tally-card[^}]*max-height:\s*85%/);
});

test("the shell sheet supplies the Tally surface instead of positioning a separate floating card", () => {
  assert.match(read("../shell/Sheet.jsx"), /className=\{`den-sheet den-sheet-\$\{slot\}/);
  assert.match(read("../shell/forest.css"), /\.den-sheet/);
});

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

test("App no longer scrolls to the removed dashboard sidebar slot", () => {
  assert.doesNotMatch(app, /openDashboard/, "replaced by open/close/toggle Tally state");
  assert.doesNotMatch(app, /dashboardOpens/);
  assert.doesNotMatch(app, /h-dashboard/, "the Pipeline heading is no longer a sidebar slot");
  assert.doesNotMatch(app, /h-dashboard.*scrollIntoView|dashboard.*scrollTop/, "Tally no longer jumps to an old dashboard sidebar slot");
  assert.doesNotMatch(app, /\["dashboard", "Pipeline"\]/, "the sidebar Pipeline slot is gone");
  assert.match(app, /tallyOpen/);
  assert.match(app, /toggleTally|openTally/);
  assert.match(app, /closeTally/);
});

test("the usage meter is off the cards (07 removed it); it lives on the Tally", () => {
  const cards = read("../overlay/Cards.jsx");
  assert.doesNotMatch(app + cards, /Plan usage \(5 h\)/);
  assert.doesNotMatch(app + cards, /<UsageMeter/);
  assert.match(read("./tally-face.mjs"), /usage-meter-model/, "the Tally face still reads the usage model");
});

test("the Dashboard component is mounted once across the UI sources, and the scene still wires the pill and the abacus click", () => {
  const jsx = (dir) => readdirSync(new URL(dir, import.meta.url)).filter((f) => f.endsWith(".jsx")).map((f) => read(dir + f));
  const all = [...jsx("./"), ...jsx("../panel/"), app].join("\n");
  assert.equal((all.match(/<Dashboard\b/g) ?? []).length, 1, "Dashboard mounted exactly once");
  assert.match(app, /useMetrics/);
  assert.match(chips, /TALLY_ARIA_LABEL/);
  assert.match(chips, /aria-expanded/);
  assert.match(chips, /aria-haspopup/);
  assert.match(chips, /aria-controls/);
  assert.match(chips, /role="meter"/, "hidden meter twins stay in ChipLayer");
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

test("the card reads --scene-bottom-inset with a 0 fallback so 07's overlays can keep it clear", () => {
  const all = css + app + chips + readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".jsx")).map((f) => read(`./${f}`)).join("\n");
  assert.match(all, /var\(--scene-bottom-inset,\s*0px\)/);
});

test("isolated Tally fixtures retain their 640px bottom-sheet rule", () => {
  const media = [...css.matchAll(/@media\s*\(max-width:\s*640px\)\s*\{/g)];
  assert.ok(media.length > 0, "a 640px media query exists");
  const blocks = media.map((m) => {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    return css.slice(start, i);
  });
  const card = blocks.find((b) => /\.tally-card/.test(b));
  assert.ok(card, "a 640px block styles .tally-card");
  assert.match(card, /max-height:\s*85(%|dvh)/);
  assert.match(card, /bottom:/);
});

test("isolated Tally fixtures retain the shared positioned-panel rule; the connected app scopes its desk override", () => {
  const rule = css.match(/\.tally-card\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(rule, ".tally-card rule exists");
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /z-index:/);
  assert.match(rule, /shadow-panel/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chipModel, stackChips, sceneActivityModel } from "./chip-model.mjs";

test('quiet run markers collapse into an inspectable summary while selection and genuine alerts stay visible',()=>{
 const placements=[...Array.from({length:9},(_,i)=>({ref:`f/${i+10}`,pose:'idle'})),
  {ref:'f/20',pose:'done'},{ref:'f/21',pose:'waiting_on_user'},{ref:'f/22',pose:'blocked'},{ref:'f/23',pose:'failed'}];
 const m=sceneActivityModel(placements,'f/12');
 assert.deepEqual(m.markers.map(p=>p.ref),['f/12','f/21','f/22','f/23']);
 assert.equal(m.rows.length,13,'every exact run remains inspectable');
 assert.deepEqual(m.counts,{Queued:9,Done:1,'Needs you':1,Blocked:1,Failed:1});
 assert.equal(sceneActivityModel(placements,null).markers.length,3);
 assert.equal(sceneActivityModel([],null).rows.length,0);
});

// den-v1/01 AC3: the five task states (working, waiting on user, blocked, failed, done) each read by shape or word,
// never by colour alone. The word and tone come from chipModel; the glyph shape comes from the stylesheet rule for
// that tone, so the test reads both.
const STATES = ["working", "waiting_on_user", "blocked", "failed", "done"];
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const glyphShape = (tone) => {
  const rule = css.match(new RegExp(`\\.chip-${tone} \\.chip-glyph\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return [...rule.matchAll(/(border-radius|clip-path|transform)\s*:\s*([^;]+)/g)].map((m) => `${m[1]}:${m[2].trim()}`).join(";");
};
test("each of the five states has its own word and tone, and failed is not shown as Queued", () => {
  const chips = STATES.map((pose) => chipModel({ ref: "f/01-t", pose }));
  assert.equal(new Set(chips.map((c) => c.label)).size, 5);
  assert.equal(new Set(chips.map((c) => c.tone)).size, 5);
  assert.equal(chips[3].label, "Failed");
});
test("each of the five states has a distinct glyph shape in the stylesheet, so colour is never the only cue", () => {
  const shapes = STATES.map((pose) => glyphShape(chipModel({ ref: "f/01-t", pose }).tone));
  for (const [i, s] of shapes.entries()) assert.notEqual(s, "", `${STATES[i]} has no shape rule of its own`);
  assert.equal(new Set(shapes).size, 5, shapes.join(" | "));
});

const cases = [
  ["working", "Working"], ["waiting_on_user", "Needs you"], ["blocked", "Blocked"], ["done", "Done"], ["idle", "Queued"],
];
for (const [pose, label] of cases) {
  test(`chip label for ${pose} is ${label}`, () => {
    const chip = chipModel({ ref: "f/01-t", pose }, "Do the thing");
    assert.equal(chip.label, label);
    assert.equal(chip.ariaLabel, `Do the thing, ${label}`);
  });
}

test("aria label falls back to the ref without a title", () => {
  assert.equal(chipModel({ ref: "f/01-t", pose: "idle" }).ariaLabel, "f/01-t, Queued");
});

test("stackChips leaves separated chips where they are", () => {
  const out = stackChips([{ ref: "a", x: 100, y: 100 }, { ref: "b", x: 400, y: 100 }]);
  assert.deepEqual(out.get("a"), { x: 100, y: 100 });
  assert.deepEqual(out.get("b"), { x: 400, y: 100 });
});

test("stackChips lifts colliding chips so none overlap vertically", () => {
  const items = [{ ref: "a", x: 100, y: 100 }, { ref: "b", x: 105, y: 102 }, { ref: "c", x: 98, y: 99 }];
  const out = stackChips(items, { width: 96, height: 22, gap: 2 });
  const ys = items.map((i) => out.get(i.ref).y).sort((p, q) => p - q);
  assert.ok(ys[1] - ys[0] >= 24 && ys[2] - ys[1] >= 24, `ys ${ys}`);
});

test("stackChips is deterministic regardless of input order", () => {
  const items = [{ ref: "a", x: 100, y: 100 }, { ref: "b", x: 100, y: 100 }];
  const one = stackChips(items);
  const two = stackChips([...items].reverse());
  assert.deepEqual(one.get("a"), two.get("a"));
  assert.deepEqual(one.get("b"), two.get("b"));
});

// den-mvp/88 (ADR 0027 decision 4): the work order file. Pinned format (the ticket leaves it open):
//   a markdown file; the structured part is the "## Order" section, one list item per ticket, in order:
//     - <feature>/<NN>                                  (a short ref: feature and ticket number, no slug)
//     - <feature>/<NN> not-beside: <ref>[, <ref>...]
//   Blank lines are allowed in the section. Any other line in it is an error. Everything outside the section is prose and ignored.
//   parseOrder(text) -> { entries: [{ ref, notBeside: [ref...] }] }; throws OrderError (naming the line) on a bad file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrder, OrderError } from "./order.mjs";

const FILE = `# Work order

Prose first; the router ignores it. - fx/99 is not an entry.

## Order
- fx/71

- fx/88
- fx/85 not-beside: fx/88, fx/86
- fx/05

## Why
- fx/98 is prose under another heading, not an entry.
`;

test("the entries come back in file order with their not-beside notes", () => {
  assert.deepEqual(parseOrder(FILE).entries, [
    { ref: "fx/71", notBeside: [] },
    { ref: "fx/88", notBeside: [] },
    { ref: "fx/85", notBeside: ["fx/88", "fx/86"] },
    { ref: "fx/05", notBeside: [] },
  ]);
});

test("prose outside the Order section never becomes an entry", () => {
  assert.equal(parseOrder(FILE).entries.some((e) => ["fx/99", "fx/98"].includes(e.ref)), false);
});

test("an empty Order section is an order with no entries", () => {
  assert.deepEqual(parseOrder("# x\n\n## Order\n\n## Why\nnothing\n").entries, []);
});

test("a bad file is refused with the line named, never half-read", () => {
  for (const bad of [
    "# no order section\n- fx/1\n",
    "## Order\n- fx/1\n- not a ref\n",
    "## Order\n- fx/1\nfree text in the section\n",
    "## Order\n- fx/1\n- fx/1\n", // duplicate
    "## Order\n- fx/1 not-beside:\n",
    "## Order\n- fx/1 not-beside: nonsense\n",
    "## Order\n- fx/12-with-a-slug\n",
  ]) assert.throws(() => parseOrder(bad), OrderError, JSON.stringify(bad));
  assert.throws(() => parseOrder("## Order\n- fx/1\n- oops\n"), /line 3|oops/);
});

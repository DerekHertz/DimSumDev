// den-mvp/61: goals. The user's short list of goals lives in .scratch/goals.md, one table row each; every ticket names
// the goal it serves on a `**Goal:**` line.
//
// Contract:
//   parseGoals(md) -> { goals: [{ key, name, why, doneWhen }], errors: [string] }  a bad row is an error, never dropped
//   readGoals(root) -> the same, from .scratch/goals.md; no file is { goals: [], errors: ["no goals file ..."] }
//   createTicket(root, { goal }) writes `**Goal:** <key>`; an unknown key, or a goal on a board with no goals file, is
//     refused with the valid keys in the reason
//   audit(root) flags an open ticket with no goal (`no-goal`) or an unknown one (`unknown-goal`), and a malformed goals file
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseGoals, readGoals } from "./goals.mjs";
import { createTicket, BoardError } from "./board-service.mjs";
import { audit } from "./board-audit.mjs";

const GOALS_MD = `# Goals

Intro prose the parser ignores.

| Key | Goal | Why | Done when |
|---|---|---|---|
| \`routing\` | Den on the routing project | The showcase. | 54 delivered. |
| \`den\` | Running everything from the den | No terminal. | Code, design and spec land from the den. |
`;

async function board(goals = GOALS_MD) {
  const root = await mkdtemp(path.join(os.tmpdir(), "goals-"));
  await mkdir(path.join(root, ".scratch", "den", "issues"), { recursive: true });
  if (goals !== null) await writeFile(path.join(root, ".scratch", "goals.md"), goals);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const ticket = (over = {}) => ({ feature: "den", slug: "thing", title: "A thing", text: "Do the thing.", ...over });

test("the goals table is parsed into keys, names, reasons and done-when", () => {
  const { goals, errors } = parseGoals(GOALS_MD);
  assert.deepEqual(errors, []);
  assert.deepEqual(goals, [
    { key: "routing", name: "Den on the routing project", why: "The showcase.", doneWhen: "54 delivered." },
    { key: "den", name: "Running everything from the den", why: "No terminal.", doneWhen: "Code, design and spec land from the den." },
  ]);
});

test("a malformed row, a bad key or a repeated key is reported, not dropped silently", () => {
  const md = `| Key | Goal | Why | Done when |\n|---|---|---|---|\n| \`den\` | A | B | C |\n| \`Bad Key\` | A | B | C |\n| \`den\` | Again | B | C |\n| \`short\` | only two |\n`;
  const { goals, errors } = parseGoals(md);
  assert.deepEqual(goals.map((g) => g.key), ["den"]);
  assert.equal(errors.length, 3, errors.join("\n"));
  assert.ok(errors.some((e) => /Bad Key/.test(e)));
  assert.ok(errors.some((e) => /den.*more than once|repeated/i.test(e)));
  assert.ok(errors.some((e) => /four cells|columns/i.test(e)));
});

test("a file with no goals table is an error", () => {
  const { goals, errors } = parseGoals("# Goals\n\nNo table here.\n");
  assert.deepEqual(goals, []);
  assert.equal(errors.length, 1);
});

test("readGoals reads .scratch/goals.md, and says so when there is none", async () => {
  const b = await board();
  try {
    assert.deepEqual((await readGoals(b.root)).goals.map((g) => g.key), ["routing", "den"]);
  } finally {
    await b.cleanup();
  }
  const none = await board(null);
  try {
    const r = await readGoals(none.root);
    assert.deepEqual(r.goals, []);
    assert.match(r.errors[0], /no goals file/);
  } finally {
    await none.cleanup();
  }
});

test("a goals file over 16 KB is refused, not parsed", async () => {
  const b = await board(GOALS_MD + "x".repeat(17 * 1024));
  try {
    const r = await readGoals(b.root);
    assert.deepEqual(r.goals, []);
    assert.match(r.errors[0], /over 16384 bytes/);
  } finally {
    await b.cleanup();
  }
});

test("a ticket created with a goal carries a Goal line", async () => {
  const b = await board();
  try {
    const made = await createTicket(b.root, ticket({ goal: "routing" }));
    const md = await readFile(made.path, "utf8");
    assert.match(md, /^\*\*Goal:\*\* routing$/m);
  } finally {
    await b.cleanup();
  }
});

test("an unknown goal, or a goal on a board with no goals file, is refused with the valid keys", async () => {
  const b = await board();
  try {
    await assert.rejects(createTicket(b.root, ticket({ goal: "nope" })), (err) => err instanceof BoardError && /routing, den/.test(err.message));
    await assert.rejects(createTicket(b.root, ticket({ goal: "Two\nlines" })), BoardError);
  } finally {
    await b.cleanup();
  }
  const none = await board(null);
  try {
    await assert.rejects(createTicket(none.root, ticket({ goal: "den" })), (err) => err instanceof BoardError && /goals file/.test(err.message));
  } finally {
    await none.cleanup();
  }
});

test("audit flags an open ticket with no goal or an unknown one, and skips resolved and parked tickets", async () => {
  const b = await board();
  try {
    const issues = path.join(b.root, ".scratch", "den", "issues");
    const md = (n, status, goal) => [`# ${n}: T`, "", "**Type:** task", "", `**Status:** ${status}`, "", ...(goal ? [`**Goal:** ${goal}`, ""] : []), "**Blocked by:** none", "", "## Comments", ""].join("\n");
    await writeFile(path.join(issues, "01-good.md"), md("01", "ready-for-agent", "den"));
    await writeFile(path.join(issues, "02-none.md"), md("02", "ready-for-agent", null));
    await writeFile(path.join(issues, "03-unknown.md"), md("03", "ready-for-human", "nope"));
    await writeFile(path.join(issues, "04-done.md"), md("04", "resolved", null));
    await writeFile(path.join(issues, "05-parked.md"), md("05", "parked", null));
    const goalFindings = (await audit(b.root)).filter((f) => /goal/.test(f.kind));
    assert.deepEqual(goalFindings.map((f) => `${f.ref} ${f.kind}`), ["den/02-none no-goal", "den/03-unknown unknown-goal"]);
  } finally {
    await b.cleanup();
  }
});

test("audit reports a malformed goals file", async () => {
  const b = await board("# Goals\n\nno table\n");
  try {
    const f = (await audit(b.root)).find((x) => x.kind === "goals-file");
    assert.ok(f, "a goals-file finding");
  } finally {
    await b.cleanup();
  }
});

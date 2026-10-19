// A ticket number of 100 or more goes through the whole board lifecycle: claim,
// comment, handoff, release, resolve, audit refs and log-agent. Two digits or more
// are accepted everywhere a ticket number is parsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { makeBoardFixture, runBoard, validStateJson, writeValidHandoff, ticketPath, REPO_ROOT } from "./board-fixture.mjs";

const TICKET = "108-apply-gated-script";
const code = (t, status = "ready-for-agent") =>
  `# ${t}\n\n**Type:** feature\n\n**Status:** ${status}\n\n- [ ] criterion\n\n## Comments\n`;
const run = (fx, args) => runBoard(args, { cwd: fx.worktree, env: { DEN_ROOT: fx.root } });
const audit = (fx) => runBoard(["audit"], { cwd: fx.worktree, env: { DEN_ROOT: "" } });
const statusOf = (text) => /^\*\*Status:\*\*[ \t]*(\S+)/m.exec(text)?.[1];

async function withFx(fn, ticket = TICKET) {
  const fx = await makeBoardFixture({ feature: "organism-infra", ticket, content: code(ticket) });
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

async function draftHandoff(fx, name, ticketRef) {
  const dir = path.join(path.dirname(fx.worktree), ".local-handoffs");
  await mkdir(dir, { recursive: true });
  const draft = path.join(dir, name);
  const state = validStateJson({ ticket: ticketRef, role: "developer" });
  await writeFile(draft, "```json\n" + JSON.stringify(state) + "\n```\n\n## Summary\n\nx\n", "utf8");
  return draft;
}

test("claim, comment, handoff, release, resolve work on a three-digit ticket", () =>
  withFx(async (fx) => {
    const ref = fx.ticketRelPath;
    let r = await run(fx, ["claim", ref, "developer"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(await fx.readTicket()), "claimed");

    r = await run(fx, ["comment", ref, "hello from 108"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(await fx.readTicket(), /hello from 108/);

    const draft = await draftHandoff(fx, "108-developer.md", ref);
    r = await run(fx, ["handoff", ref, "--from", draft]);
    assert.equal(r.code, 0, r.stderr);
    const published = path.join(fx.root, ".scratch", fx.feature, "handoffs", "108-developer.md");
    assert.match(await readFile(published, "utf8"), /108-apply-gated-script/);

    r = await run(fx, ["release", ref, "--status", "in-review"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(await fx.readTicket()), "in-review");

    r = await run(fx, ["resolve", ref, "--pr", "7"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(await fx.readTicket()), "resolved");
  }));

test("a handoff name with the wrong three-digit prefix is refused", () =>
  withFx(async (fx) => {
    const draft = await draftHandoff(fx, "109-developer.md", fx.ticketRelPath);
    const r = await run(fx, ["handoff", fx.ticketRelPath, "--from", draft]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /prefix 109- but .* needs prefix 108-/);
  }));

test("a ticket number of one digit is still refused", async () => {
  const fx = await makeBoardFixture({ feature: "organism-infra", ticket: "1-bad", content: code("1-bad") });
  try {
    const r = await run(fx, ["claim", "organism-infra/1-bad", "developer"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /invalid ticket segment/);
  } finally {
    await fx.cleanup();
  }
});

test("audit reads a three-digit Blocked by", () =>
  withFx(async (fx) => {
    await writeFile(
      ticketPath(fx.root, fx.feature, "109-next"),
      `# 109-next\n\n**Blocked by:** 108-apply-gated-script\n\n**Status:** ready-for-agent\n\n## Comments\n`,
      "utf8",
    );
    await writeFile(
      ticketPath(fx.root, fx.feature, "110-other"),
      `# 110-other\n\n**Blocked by:** organism-infra/111\n\n**Status:** ready-for-agent\n\n## Comments\n`,
      "utf8",
    );
    const r = await audit(fx);
    // 109 names an existing 108: no finding. 110 names a missing 111: exactly that finding.
    assert.match(r.stdout, /organism-infra\/110-other blocked-by-missing .*organism-infra\/111/);
    assert.doesNotMatch(r.stdout, /109-next/);
  }));

test("audit names a resolved three-digit ticket in an orphan pending item", () =>
  withFx(async (fx) => {
    await writeFile(fx.ticketPath, code(TICKET, "resolved"), "utf8");
    await writeFile(ticketPath(fx.root, fx.feature, "109-next"), code("109-next"), "utf8");
    const dir = path.join(fx.root, ".scratch", fx.feature, "handoffs");
    await mkdir(dir, { recursive: true });
    const state = validStateJson({
      ticket: `${fx.feature}/109-next`,
      role: "qa",
      pending: [{ item: `do something on ${fx.feature}/108`, owner: "orchestrator" }],
    });
    await writeFile(path.join(dir, "109-qa.md"), "```json\n" + JSON.stringify(state) + "\n```\n", "utf8");
    const r = await audit(fx);
    assert.match(r.stdout, /orphan-pending .*organism-infra\/108/);
  }));

test("audit lists findings in numeric ticket order across 99 and 100", async () => {
  const fx = await makeBoardFixture({ feature: "organism-infra", ticket: "99-a", content: code("99-a", "claimed") });
  try {
    await writeFile(ticketPath(fx.root, fx.feature, "100-b"), code("100-b", "claimed"), "utf8");
    const r = await audit(fx);
    const at99 = r.stdout.indexOf("organism-infra/99-a");
    const at100 = r.stdout.indexOf("organism-infra/100-b");
    assert.ok(at99 >= 0 && at100 >= 0, r.stdout);
    assert.ok(at99 < at100, r.stdout);
  } finally {
    await fx.cleanup();
  }
});

test("log-agent accepts a three-digit ticket with a matching handoff", () =>
  withFx(async (fx) => {
    await writeValidHandoff(fx, { filename: "108-developer.md" });
    const r = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "log-agent.mjs"), "--ticket", fx.ticketRelPath, "--role", "developer", "--tokens", "10", "--ms", "20", "--outcome", "ok"],
      { cwd: fx.root, env: { ...process.env, DEN_ROOT: fx.root }, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(r.status, 0, r.stderr);
    const rows = (await readFile(path.join(fx.root, ".scratch", "usage.jsonl"), "utf8")).split("\n").filter(Boolean);
    assert.equal(JSON.parse(rows[0]).ticket, "organism-infra/108-apply-gated-script");
  }));

// team-and-den-ux/57: the router works with no orchestrator role. It names no retired role (orchestrator, herald, scout)
// and reads no role file, so a ready ticket still starts a delivery when .claude/agents has no orchestrator.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "./decide.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

test("no router source names a retired role or reads a role file", () => {
  const sources = readdirSync(HERE).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
  assert.ok(sources.includes("decide.mjs") && sources.includes("router.mjs"));
  for (const f of sources) {
    const text = readFileSync(path.join(HERE, f), "utf8");
    assert.doesNotMatch(text, /\b(orchestrator|herald|scout)\b/, f);
    assert.doesNotMatch(text, /\.claude\/agents|\.codex\/agents/, f);
  }
});

test("with no orchestrator role file, a ready ticket still starts a delivery", () => {
  assert.equal(existsSync(path.join(ROOT, ".claude", "agents", "orchestrator.md")), false);
  const ticket = {
    ref: "fx/01-slug",
    locked: false,
    text: "# 1\n\n**Type:** feature\n\n**Status:** ready-for-agent\n\n**Blocked by:** None\n\n## What to build\n`apps/a/one.mjs`\n\n## Acceptance criteria\n- [ ] x\n",
  };
  const { actions } = decide({
    order: { entries: [{ ref: "fx/01", notBeside: [] }] },
    tickets: [ticket],
    state: { capacity: { max: 2, cap: 3, load: 0, live: 0, room: 2, refs: [] }, deliveries: [] },
    usage: { "5-hour": { percent: 10 }, weekly: { percent: 10 }, source: "live", age_s: 0 },
    stops: [],
    downForMs: 0,
  });
  assert.deepEqual(actions.filter((a) => a.type === "start").map((a) => a.ref), ["fx/01-slug"]);
});

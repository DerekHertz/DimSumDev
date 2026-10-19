// agent-os/02 (ADR 0021 decision 3): POST /tasks takes task grants as data in a fixed shape.
//
// PINNED INTERFACE:
//   POST /tasks body { role, text, grants? }   grants: [{ kind: "host" | "path", value }], at most 6. Same rules as the adapter
//       (compileCeiling in grants.test.mjs): host is a plain lower-case DNS name (no IP, scheme, port, path, localhost); path is
//       absolute or ~/ with plain segments. Anything else is a 400 BEFORE a ticket is written or a worktree made.
//       scout takes no grant (400). A role with no ceiling takes none either (400).
//   runtime.spawn args gain  grants  (the validated array, same objects' fields), beside role, cwd, prompt, ticketFile.
//   The prompt template and the argv never carry a grant string outside the settings value.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { makeBridge } from "./host-test-helpers.mjs";
import { DEN_FEATURE } from "./policy.mjs";

const TEXT = "Fetch the package index and note which versions changed.";
const GOOD = [{ kind: "host", value: "api.example.com" }, { kind: "path", value: "/srv/shared/data" }];
let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const tickets = async () => (await readdir(path.join(t.fx.root, ".scratch", DEN_FEATURE, "issues")).catch(() => [])).filter((n) => n.endsWith(".md"));

describe("POST /tasks grants", () => {
  test("a developer task with grants starts, and the runtime gets exactly the validated grants", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "developer", text: TEXT, grants: GOOD });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(t.fake.spawns[0].args.grants, GOOD);
  });

  test("no grant string reaches the prompt template", async () => {
    t = await makeBridge();
    await t.post("/tasks", { role: "developer", text: TEXT, grants: GOOD });
    const { prompt } = t.fake.spawns[0].args;
    for (const g of GOOD) assert.equal(prompt.includes(g.value), false, g.value);
  });

  test("a task with no grants spawns with none", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "developer", text: TEXT });
    assert.equal(res.status, 201, res.text);
    assert.ok([undefined, null].includes(t.fake.spawns[0].args.grants) || t.fake.spawns[0].args.grants.length === 0);
  });

  const bad = [
    ["not an array", "api.example.com"],
    ["an object", { kind: "host", value: "api.example.com" }],
    ["a string entry", ["api.example.com"]],
    ["an IP host", [{ kind: "host", value: "127.0.0.1" }]],
    ["the metadata address", [{ kind: "host", value: "169.254.169.254" }]],
    ["localhost", [{ kind: "host", value: "localhost" }]],
    ["a scheme", [{ kind: "host", value: "https://example.com" }]],
    ["a port", [{ kind: "host", value: "example.com:8080" }]],
    ["a relative path", [{ kind: "path", value: "notes/x" }]],
    ["a .. path", [{ kind: "path", value: "/srv/../etc" }]],
    ["a glob path", [{ kind: "path", value: "/srv/*" }]],
    ["an unknown kind", [{ kind: "flag", value: "--dangerously-skip-permissions" }]],
    ["an extra key", [{ kind: "host", value: "api.example.com", flag: "--x" }]],
    ["seven grants", Array.from({ length: 7 }, (_, i) => ({ kind: "host", value: `h${i}.example.com` }))],
    ["a non-string value", [{ kind: "host", value: 7 }]],
  ];
  for (const [name, grants] of bad) {
    test(`${name} is a 400, nothing written, nothing spawned`, async () => {
      t = await makeBridge();
      const res = await t.post("/tasks", { role: "developer", text: TEXT, grants });
      assert.equal(res.status, 400, res.text);
      assert.equal(typeof res.body.error, "string");
      assert.equal(res.body.error.includes("--dangerously"), false, "the error does not echo a flag back as advice");
      assert.deepEqual(await tickets(), [], "no ticket");
      assert.equal(t.fake.spawns.length, 0, "no agent");
    });
  }

  test("scout takes no grant", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "scout", text: TEXT, grants: [GOOD[0]] });
    assert.equal(res.status, 400, res.text);
    assert.equal(t.fake.spawns.length, 0);
  });

  test("a role that writes nothing (Bao) takes no grant", async () => {
    t = await makeBridge();
    const res = await t.post("/tasks", { role: "orchestrator", text: TEXT, grants: [GOOD[0]] });
    assert.equal(res.status, 400, res.text);
    assert.equal(t.fake.spawns.length, 0);
  });
});

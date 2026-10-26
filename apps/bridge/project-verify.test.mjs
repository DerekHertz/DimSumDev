import assert from "node:assert/strict";
import test from "node:test";
import { verifyProtection } from "./project-verify.mjs";

const row = { repo: "acme/web", checks: ["build", "test"] };
test("a protected stub passes, and only a GET was made", async () => {
  const calls = [];
  const gh = async (args) => { calls.push(args); return JSON.stringify({ checks: [{ context: "build" }, { context: "test" }] }); };
  assert.deepEqual(await verifyProtection(row, { gh }), { ok: true });
  assert.ok(calls.every((a) => !a.includes("PUT") && !a.includes("-X")));
});
test("an unprotected stub prints the PUT command with the target's check names and never calls it", async () => {
  const calls = [];
  const gh = async (args) => { calls.push(args); throw new Error("HTTP 404"); };
  const r = await verifyProtection(row, { gh });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["build", "test"]);
  assert.match(r.command, /gh api -X PUT repos\/acme\/web\/branches\/main\/protection --input -/);
  assert.match(r.command, /"context":"build"/);
  assert.doesNotMatch(r.command, /"context":"security"/);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((a) => a[0] === "api" && !a.includes("-X")));
});
test("a partly protected stub names the missing check", async () => {
  const gh = async () => JSON.stringify({ contexts: ["build"] });
  assert.deepEqual((await verifyProtection(row, { gh })).missing, ["test"]);
});

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
test("a gh error that is not a 404 (auth, network) throws instead of reading as unprotected", async () => {
  const gh = async () => { throw Object.assign(new Error("Command failed: gh api"), { stderr: "gh: To use GitHub CLI, run: gh auth login" }); };
  await assert.rejects(verifyProtection(row, { gh }), /could not read branch protection for acme\/web: gh: To use GitHub CLI/);
});
test("a 404 carried in stderr still means unprotected", async () => {
  const gh = async () => { throw Object.assign(new Error("Command failed"), { stderr: "gh: Not Found (HTTP 404)" }); };
  assert.equal((await verifyProtection(row, { gh })).ok, false);
});

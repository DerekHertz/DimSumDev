// organism-infra/70: which events.jsonl comment the route-bounce CLI sends (security review 67:
// the latest `board comment --verdict bounce` text for this ticket, nothing else).
import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("./jev.mjs");
const ev = (over) => JSON.stringify({ feature: "feat", ticket: "07-thing", role: "qa", op: "comment", ...over });

test("latest bounce verdict comment for the ticket wins, by append order", async () => {
  const { latestBounceComment } = await load();
  const text = [
    ev({ seq: 9, text: "first bounce", verdict: "bounce" }),
    ev({ seq: 2, text: "second bounce", verdict: "bounce" }),
    ev({ text: "security pass", verdict: "pass", role: "security" }),
  ].join("\n");
  assert.equal(latestBounceComment(text, "feat", "07-thing"), "second bounce");
});

test("non-verdict comments, pass verdicts and non-comment ops are ignored", async () => {
  const { latestBounceComment } = await load();
  const text = [
    ev({ text: "the bounce", verdict: "bounce" }),
    ev({ text: "plain note" }),
    ev({ text: "pass note", verdict: "pass" }),
    ev({ op: "release", text: "not a comment", verdict: "bounce" }),
  ].join("\n");
  assert.equal(latestBounceComment(text, "feat", "07-thing"), "the bounce");
});

test("other tickets and other features never leak in", async () => {
  const { latestBounceComment } = await load();
  const text = [
    ev({ text: "mine", verdict: "bounce" }),
    ev({ ticket: "70-other", text: "OTHER_TICKET", verdict: "bounce" }),
    ev({ ticket: "08-thing", text: "OTHER_NN", verdict: "bounce" }),
    ev({ feature: "other", text: "OTHER_FEATURE", verdict: "bounce" }),
  ].join("\n");
  assert.equal(latestBounceComment(text, "feat", "07-thing"), "mine");
});

test("the ticket matches by feature and NN, so a renamed slug still finds its bounce", async () => {
  const { latestBounceComment } = await load();
  const text = ev({ ticket: "07-old-name", text: "renamed", verdict: "bounce" });
  assert.equal(latestBounceComment(text, "feat", "07-thing"), "renamed");
});

test("no bounce, empty log, malformed lines and non-string text give an empty string", async () => {
  const { latestBounceComment } = await load();
  assert.equal(latestBounceComment("", "feat", "07-thing"), "");
  assert.equal(latestBounceComment("not json\n{broken", "feat", "07-thing"), "");
  assert.equal(latestBounceComment(ev({ text: { x: 1 }, verdict: "bounce" }), "feat", "07-thing"), "");
  const mixed = [ev({ text: "kept", verdict: "bounce" }), "garbage", ev({ text: 5, verdict: "bounce" })].join("\n");
  assert.equal(latestBounceComment(mixed, "feat", "07-thing"), "kept");
});

// den-scene-v1/07: view-models for the floating cards and bottom overlays. Literals come from the ticket copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeAge, stepRequest, badgeModel, clockText, timelineMarkers, shortRef, teamIdOf, teamsModel, needsYouModel } from "./overlay-model.mjs";

const NOW = Date.parse("2026-10-01T12:00:00Z");

test("relativeAge: now under a minute, minutes, hours, days, null when unknown", () => {
  assert.equal(relativeAge("2026-10-01T11:59:40Z", NOW), "now");
  assert.equal(relativeAge("2026-10-01T11:58:00Z", NOW), "2 min");
  assert.equal(relativeAge("2026-10-01T09:00:00Z", NOW), "3 h");
  assert.equal(relativeAge("2026-09-29T12:00:00Z", NOW), "2 d");
  assert.equal(relativeAge(undefined, NOW), null);
  assert.equal(relativeAge("not a date", NOW), null);
});

test("stepRequest wraps in both directions and falls back to the first when the ref is gone", () => {
  const reqs = [{ ref: "a" }, { ref: "b" }, { ref: "c" }];
  assert.equal(stepRequest(reqs, "a", 1), "b");
  assert.equal(stepRequest(reqs, "c", 1), "a");
  assert.equal(stepRequest(reqs, "a", -1), "c");
  assert.equal(stepRequest(reqs, "zzz", 1), "a");
  assert.equal(stepRequest([], "a", 1), null);
});

test("shortRef drops the feature slug; the three Pass types share the pass team; unknown placement types are cubs", () => {
  assert.equal(shortRef("den-scene-v1/07-sidebar-overlays"), "07-sidebar-overlays");
  assert.equal(teamIdOf("orchestrator"), "pass");
  assert.equal(teamIdOf("product"), "pass");
  assert.equal(teamIdOf("developer"), "steamers");
  assert.equal(teamIdOf("designer"), "front-of-house");
});

test("badgeModel: Live, Offline with the run hint, Reconnecting politely", () => {
  assert.equal(badgeModel({ phase: "live" }).label, "Live");
  assert.equal(badgeModel({ phase: "offline" }).label, "Offline");
  assert.match(badgeModel({ phase: "offline" }).hint, /npm run ui/);
  const r = badgeModel({ phase: "connecting" });
  assert.equal(r.label, "Reconnecting…");
  assert.equal(r.ariaLive, "polite");
});

test("clockText is 24 hour with the hour unpadded", () => {
  assert.match(clockText(new Date(2026, 9, 1, 9, 5).getTime()), /^9:05$/);
  assert.match(clockText(new Date(2026, 9, 1, 21, 40).getTime()), /^21:40$/);
});

test("timelineMarkers: last hour only, lantern for a gate, alarm for blocked, position 0 (an hour ago) to 1 (now)", () => {
  const snap = {
    tickets: [
      { ref: "f/01", status: "claimed", holder: { since: "2026-10-01T11:30:00Z" } },
      { ref: "f/02", status: "in-review", gate: "merge", holder: { since: "2026-10-01T11:59:00Z" } },
      { ref: "f/03", status: "blocked", holder: { since: "2026-10-01T11:45:00Z" } },
      { ref: "f/04", status: "claimed", holder: { since: "2026-10-01T09:00:00Z" } },
      { ref: "f/05", status: "claimed" },
    ],
  };
  const m = timelineMarkers(snap, NOW);
  assert.deepEqual(m.map((x) => [x.ref, x.tone]), [["f/01", "pass"], ["f/02", "lantern"], ["f/03", "alarm"]]);
  assert.equal(m[0].at, 0.5);
  assert.ok(Math.abs(m[1].at - (1 - 1 / 60)) < 1e-9);
});

test("teamsModel with no snapshot: five open pills, three dormant (Cubs 0 asleep, the others coming online)", () => {
  const m = teamsModel(null);
  assert.deepEqual(m.open.map((s) => s.id), ["pass", "steamers", "tea", "pantry", "front-of-house"]);
  assert.deepEqual(m.dormant.map((s) => s.text), ["0 asleep", "coming online", "coming online"]);
  assert.equal(m.summary, "5 open · 0 ready");
  assert.deepEqual(m.next, []);
});

test("needsYouModel with no snapshot is empty", () => {
  assert.deepEqual(needsYouModel(null, NOW), { count: 0, requests: [] });
});

// den-mvp/29: red pull requests from the CI watch.
test("a red pull request is a Needs you card for Bao, or for security; a re-run and a delivery's own pull request are not", () => {
  const prs = [
    { number: 7, url: "https://github.com/o/r/pull/7", title: "a change", state: "red", route: "orchestrator", jobs: [{ name: "test", reason: "timed out at 15m0s" }], bao: "Bao was told" },
    { number: 8, url: "javascript:alert(1)", title: "", state: "asks-user", route: "security", jobs: [{ name: "security", reason: "failed" }] },
    { number: 9, state: "rerun", route: "orchestrator", jobs: [] },
    { number: 10, state: "red", route: "orchestrator", jobs: [] },
  ];
  const { requests } = needsYouModel({ tickets: [], ci: { prs }, deliveries: [{ id: "d-1", state: "paused", pr: { number: 10 } }] }, 0);
  const ci = requests.filter((r) => r.kind === "ci");
  assert.deepEqual(ci.map((r) => [r.key, r.role, r.team]), [["ci:7", "orchestrator", "pass"], ["ci:8", "security", teamIdOf("security")]]);
  assert.equal(ci[0].title, "PR #7 is red: test");
  assert.equal(ci[0].reason, "test: timed out at 15m0s");
  assert.equal(ci[0].pr, "https://github.com/o/r/pull/7");
  assert.match(ci[0].next, /Bao was told\.$/);
  assert.equal(ci[1].title, "PR #8 is red again on the same commit: security");
  assert.equal(ci[1].pr, null, "only an https link is rendered");
  assert.equal(needsYouModel({ tickets: [], ci: null }, 0).count, 0);
});

test("den-mvp/13: a ready-for-human ticket is a Needs you request with its text; others are not", () => {
  const snapshot = { tickets: [
    { ref: "f/06-human", title: "06: Human", status: "ready-for-human", text: "# 06: Human\n\nDo the thing." },
    { ref: "f/08-plain", title: "08", status: "ready-for-agent" },
  ] };
  const reqs = needsYouModel(snapshot, NOW).requests.filter((r) => r.kind === "ticket");
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].ref, "f/06-human");
  assert.match(reqs[0].preview[0], /Do the thing/);
});

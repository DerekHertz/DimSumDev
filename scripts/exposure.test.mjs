// organism-infra/77: Shared exposure module.
// Covers scripts/exposure.mjs: DENIED_PATHS, isDenied(path), hasSecret(text).
// Also: --tests path validation in the jev.mjs CLI (AC3), per-point input
// allowlisting via decide with an injected transport (AC4), and the
// one-source import property (jev.mjs reads SECRET_PATTERNS from exposure.mjs).
// Fixtures are built at runtime so CI gitleaks never sees token-shaped literals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync,
  readFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const JEV = path.join(REPO_ROOT, "scripts", "jev.mjs");
const NOW = new Date("2026-09-29T01:20:00Z");
const KEY = "sk-" + "test-KEYVALUE-should-never-leak-123";
const TICKET = "feat/07-thing";

// Build a synthetic token body of length n from safe alphanumeric chars.
const body = (n) => "aB3dE5fG7h".repeat(Math.ceil(n / 10)).slice(0, n);

// ---- shared helpers ----

function makeBoard(ticketText) {
  const root = mkdtempSync(path.join(tmpdir(), "exp77-"));
  mkdirSync(path.join(root, ".scratch", "feat", "issues"), { recursive: true });
  writeFileSync(
    path.join(root, ".scratch", "feat", "issues", "07-thing.md"),
    ticketText ?? "# 07\n\n**What to build:** a thing.\n",
  );
  return root;
}

function cliNoKey(root, argv) {
  const env = { ...process.env, DEN_ROOT: root };
  delete env.TYPESAFE_API_KEY;
  return spawnSync(process.execPath, [JEV, ...argv], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
}

function usageRows(root) {
  const p = path.join(root, ".scratch", "usage.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function makeFile(dir, name, content) {
  const full = path.join(dir, name);
  writeFileSync(full, content);
  return full;
}

const load = () => import("./jev.mjs");
function fake(answer, calls = []) {
  return async (req) => { calls.push(req); return answer; };
}
const routeAns = {
  pick: "qa-specify",
  probs: { "qa-specify": 0.85, other: 0.15 },
  usage: { cost: 0.0004 },
};

// ====================================================================
// AC1 — exposure.mjs exports DENIED_PATHS, isDenied, hasSecret;
//        jev.mjs and risk-check.mjs share one pattern source.
// ====================================================================

test("exposure.mjs exports DENIED_PATHS as a non-empty array", async () => {
  const { DENIED_PATHS } = await import("./exposure.mjs");
  assert.ok(Array.isArray(DENIED_PATHS), "DENIED_PATHS must be an array");
  assert.ok(DENIED_PATHS.length > 0, "DENIED_PATHS must not be empty");
});

test("exposure.mjs exports isDenied as a function", async () => {
  const { isDenied } = await import("./exposure.mjs");
  assert.equal(typeof isDenied, "function");
});

test("exposure.mjs exports hasSecret as a function", async () => {
  const { hasSecret } = await import("./exposure.mjs");
  assert.equal(typeof hasSecret, "function");
});

test("isDenied returns true for .env paths", async () => {
  const { isDenied } = await import("./exposure.mjs");
  assert.ok(isDenied(path.join(tmpdir(), ".env")));
  assert.ok(isDenied(path.join(tmpdir(), ".env.local")));
});

test("isDenied returns true for credentials files", async () => {
  const { isDenied } = await import("./exposure.mjs");
  assert.ok(isDenied(path.join(tmpdir(), "credentials.json")));
  assert.ok(isDenied(path.join(tmpdir(), "credentials")));
});

test("isDenied returns true for .pem and .key files", async () => {
  const { isDenied } = await import("./exposure.mjs");
  assert.ok(isDenied(path.join(tmpdir(), "server.pem")));
  assert.ok(isDenied(path.join(tmpdir(), "id.key")));
});

test("isDenied returns true for paths inside a dot-directory", async () => {
  const { isDenied } = await import("./exposure.mjs");
  assert.ok(isDenied(path.join(tmpdir(), ".hidden", "tests.txt")));
  assert.ok(isDenied(path.join(tmpdir(), ".git", "config")));
});

test("isDenied returns true for paths inside .scratch handoffs and _handoffs", async () => {
  const { isDenied } = await import("./exposure.mjs");
  assert.ok(isDenied(path.join(tmpdir(), ".scratch", "feat", "handoffs", "77-qa.md")));
  assert.ok(isDenied(path.join(tmpdir(), "_handoffs", "something.md")));
});

test("isDenied returns true for _requests paths and *.lock files", async () => {
  const { isDenied } = await import("./exposure.mjs");
  assert.ok(isDenied(path.join(tmpdir(), "_requests", "requests.jsonl")));
  assert.ok(isDenied(path.join(tmpdir(), "some.lock")));
});

test("isDenied returns true for usage.jsonl", async () => {
  const { isDenied } = await import("./exposure.mjs");
  assert.ok(isDenied(path.join(tmpdir(), "usage.jsonl")));
});

test("isDenied returns false for a normal test output file in /tmp", async () => {
  const { isDenied } = await import("./exposure.mjs");
  assert.equal(isDenied(path.join(tmpdir(), "test-results-12345", "out.txt")), false);
});

// One-source: jev.mjs must import from exposure.mjs, not define its own SECRET_PATTERNS.
test("jev.mjs imports from exposure.mjs, not risk-check.mjs", () => {
  const src = readFileSync(path.join(REPO_ROOT, "scripts", "jev.mjs"), "utf8");
  assert.doesNotMatch(
    src,
    /from ['"]\.\/risk-check\.mjs['"]/,
    "jev.mjs must not import directly from risk-check.mjs",
  );
  assert.match(
    src,
    /from ['"]\.\/exposure\.mjs['"]/,
    "jev.mjs must import from exposure.mjs",
  );
});

// One-source: risk-check.mjs must import SECRET_PATTERNS from exposure.mjs.
test("risk-check.mjs imports SECRET_PATTERNS from exposure.mjs, not defining its own", () => {
  const src = readFileSync(path.join(REPO_ROOT, "scripts", "risk-check.mjs"), "utf8");
  assert.doesNotMatch(
    src,
    /^export const SECRET_PATTERNS\s*=/m,
    "risk-check.mjs must not own SECRET_PATTERNS; it must import from exposure.mjs",
  );
  assert.match(
    src,
    /from ['"]\.\/exposure\.mjs['"]/,
    "risk-check.mjs must import from exposure.mjs",
  );
});

// ====================================================================
// AC2 — hasSecret catches every listed secret shape (from 67 + ticket 46).
//        Fixtures built at runtime.
// ====================================================================

async function hs() {
  const m = await import("./exposure.mjs");
  return m.hasSecret;
}

test("hasSecret catches unquoted NAME_KEY=value env lines", async () => {
  const f = await hs();
  assert.ok(f("TYPESAFE_API_KEY=" + body(32)));
  assert.ok(f("MY_SECRET_KEY=" + body(20)));
});

test("hasSecret catches Authorization: Bearer token shape", async () => {
  const f = await hs();
  assert.ok(f("Authorization: Bearer " + body(40)));
});

test("hasSecret catches JWT shape (three dot-separated base64url segments)", async () => {
  const f = await hs();
  // Synthetic JWT: three base64url-safe segments of realistic length.
  const seg = (n) => body(n).replace(/[+/]/g, "a");
  assert.ok(f(`${seg(36)}.${seg(54)}.${seg(43)}`));
});

test("hasSecret catches sk_live_ API key shape", async () => {
  const f = await hs();
  // Build at runtime to avoid triggering static scanners.
  assert.ok(f("sk" + "_live_" + body(24)));
});

test("hasSecret catches github_pat_ token shape", async () => {
  const f = await hs();
  assert.ok(f("github" + "_pat_" + body(36)));
});

test("hasSecret catches gho_, ghs_, ghu_ token shapes", async () => {
  const f = await hs();
  for (const suffix of ["o_", "s_", "u_"]) {
    assert.ok(f("gh" + suffix + body(36)), `gh${suffix} shape`);
  }
});

test("hasSecret catches npm_ token shape", async () => {
  const f = await hs();
  assert.ok(f("npm" + "_" + body(36)));
});

test("hasSecret catches URL credentials (user:password@host)", async () => {
  const f = await hs();
  assert.ok(f("https://alice:" + body(16) + "@internal.example.com/api"));
});

test("hasSecret catches aws_secret_access_key assignment shape", async () => {
  const f = await hs();
  assert.ok(f("aws_secret_access_key = " + body(40)));
  assert.ok(f("AWS_SECRET_ACCESS_KEY=" + body(40)));
});

test("hasSecret catches Slack xoxr-, xoxs-, xoxe- shapes (ticket 46)", async () => {
  const f = await hs();
  for (const kind of ["r", "s", "e"]) {
    assert.ok(f("xo" + "x" + kind + "-" + body(32)), `xox${kind}- shape`);
  }
});

test("hasSecret catches glued GitHub token prefix e.g. GH_ghp_... (ticket 46)", async () => {
  const f = await hs();
  // A gh*_ token glued to a word-character prefix must still match.
  assert.ok(f("GH_gh" + "p_" + body(36)), "GH_ prefix + ghp_");
  assert.ok(f("MYVAR_gh" + "o_" + body(36)), "MYVAR_ prefix + gho_");
});

test("hasSecret does not flag prose, prefixes alone, or short lookalikes", async () => {
  const f = await hs();
  assert.equal(f("The gho_ prefix and npm_ prefix are documented"), false);
  assert.equal(f("github_pat_ tokens begin with that prefix"), false);
  assert.equal(f("no secrets here at all"), false);
});

// Secret check must cover text BEFORE 16k tail-truncation (so a secret early
// in a long ticket does not escape when it is cut off).
test("hasSecret: a new shape early in text >16k still blocks (secret before truncation window)", async () => {
  const { decide } = await load();
  const calls = [];
  // Place a sk_live_ secret at position 0; ticket is 20k chars long so the
  // tail cut would drop the beginning entirely.
  const secretPrefix = "sk" + "_live_" + body(24);
  const ticketText = secretPrefix + " " + "x".repeat(20000);
  const { row } = await decide({
    point: "tier",
    ticket: TICKET,
    ticketText,
    now: NOW,
    env: { TYPESAFE_API_KEY: KEY },
    transport: fake(routeAns, calls),
  });
  assert.equal(calls.length, 0, "no transport call when secret is present");
  assert.equal(row.fallback, "blocked-input");
});

// ====================================================================
// AC3 — jev.mjs --tests rejects each denied path; no row sent or logged.
// ====================================================================

test("--tests rejects a .env file and writes no usage row", () => {
  const root = makeBoard();
  const f = makeFile(root, ".env", "SECRET=val\n");
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", f]);
  assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}`);
  assert.equal(usageRows(root).length, 0, "no usage row must be written");
});

test("--tests rejects a credentials file and writes no usage row", () => {
  const root = makeBoard();
  const f = makeFile(root, "credentials.json", "{}");
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", f]);
  assert.notEqual(r.status, 0);
  assert.equal(usageRows(root).length, 0);
});

test("--tests rejects a .pem file and writes no usage row", () => {
  const root = makeBoard();
  const f = makeFile(root, "server.pem", "cert-data");
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", f]);
  assert.notEqual(r.status, 0);
  assert.equal(usageRows(root).length, 0);
});

test("--tests rejects a .key file and writes no usage row", () => {
  const root = makeBoard();
  const f = makeFile(root, "id.key", "key-data");
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", f]);
  assert.notEqual(r.status, 0);
  assert.equal(usageRows(root).length, 0);
});

test("--tests rejects a file inside a dot-directory and writes no usage row", () => {
  const root = makeBoard();
  mkdirSync(path.join(root, ".hidden"), { recursive: true });
  const f = makeFile(path.join(root, ".hidden"), "tests.txt", "ok 1\n");
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", f]);
  assert.notEqual(r.status, 0);
  assert.equal(usageRows(root).length, 0);
});

test("--tests rejects a file inside .scratch handoffs and writes no usage row", () => {
  const root = makeBoard();
  mkdirSync(path.join(root, ".scratch", "feat", "handoffs"), { recursive: true });
  const f = makeFile(
    path.join(root, ".scratch", "feat", "handoffs"),
    "77-qa-specify.md",
    "ok 1\n",
  );
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", f]);
  assert.notEqual(r.status, 0);
  assert.equal(usageRows(root).length, 0);
});

test("--tests rejects usage.jsonl and writes no usage row", () => {
  const root = makeBoard();
  const usagePath = path.join(root, ".scratch", "usage.jsonl");
  writeFileSync(usagePath, "");
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", usagePath]);
  assert.notEqual(r.status, 0);
  // usage.jsonl was pre-created empty; after rejection no rows must be appended.
  assert.equal(usageRows(root).length, 0);
});

test("--tests rejects a symlink (even to a non-denied target) and writes no usage row", () => {
  const root = makeBoard();
  const real = makeFile(root, "real-tests.txt", "ok 1\n");
  const link = path.join(root, "tests-link.txt");
  symlinkSync(real, link);
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", link]);
  assert.notEqual(r.status, 0);
  assert.equal(usageRows(root).length, 0);
});

test("--tests rejects a directory path and writes no usage row", () => {
  const root = makeBoard();
  const dir = path.join(root, "testdir");
  mkdirSync(dir);
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", dir]);
  assert.notEqual(r.status, 0);
  assert.equal(usageRows(root).length, 0);
});

test("--tests rejects a file over 1 MB and writes no usage row", () => {
  const root = makeBoard();
  // 1 MiB + 1 byte
  const f = makeFile(root, "big.txt", "x".repeat(1024 * 1024 + 1));
  const r = cliNoKey(root, ["verify", "--ticket", TICKET, "--tests", f]);
  assert.notEqual(r.status, 0);
  assert.equal(usageRows(root).length, 0);
});

// ====================================================================
// AC4 — Each Jev point's request contains only its allowlisted inputs,
//        checked through decide with an injected transport.
// ====================================================================

// route-bounce is a new point (ticket 70). Tests verify it exists and that
// the bounce comment is included while handoff text is excluded.
test("route-bounce: decide handles the point and includes bounce comment in transport text", async () => {
  const { decide } = await load();
  const calls = [];
  const BOUNCE = "BOUNCE_VERDICT_SENTINEL_" + body(8);
  const HANDOFF = "HANDOFF_SENTINEL_SHOULD_NOT_APPEAR_" + body(8);
  await decide({
    point: "route-bounce",
    ticket: TICKET,
    ticketText: "# 07\n\n**What to build:** a thing.\n",
    bounceComment: BOUNCE,
    handoffText: HANDOFF, // must NOT reach the transport
    now: NOW,
    env: { TYPESAFE_API_KEY: KEY },
    transport: fake(routeAns, calls),
  });
  assert.equal(calls.length, 1, "transport must be called exactly once");
  assert.match(calls[0].text, new RegExp(BOUNCE), "bounce comment must appear in assembled text");
  assert.doesNotMatch(calls[0].text, new RegExp(HANDOFF), "handoff text must not appear in assembled text");
});

// wake is a new point (ticket 72). Tests verify it exists and that only the
// ticket header and new comment are included; handoff text is excluded.
test("wake: decide handles the point and includes new comment but not handoff text", async () => {
  const { decide } = await load();
  const calls = [];
  const COMMENT = "WAKE_COMMENT_SENTINEL_" + body(8);
  const HANDOFF = "HANDOFF_SENTINEL_SHOULD_NOT_APPEAR_" + body(8);
  await decide({
    point: "wake",
    ticket: TICKET,
    ticketText: "# 07\n\n**Status:** in-review\n**What to build:** a thing.\n",
    newComment: COMMENT,
    author: "qa",
    handoffText: HANDOFF,
    now: NOW,
    env: { TYPESAFE_API_KEY: KEY },
    transport: fake(routeAns, calls),
  });
  assert.equal(calls.length, 1, "transport must be called exactly once");
  assert.match(calls[0].text, new RegExp(COMMENT), "new comment must appear in assembled text");
  assert.doesNotMatch(calls[0].text, new RegExp(HANDOFF), "handoff text must not appear in assembled text");
});

// wake point must NOT call transport for a user-authored comment, a
// 'Scope added' comment, a verdict-event, or a new _requests row.
test("wake: user-authored comment, Scope added, and verdict events produce zero transport calls", async () => {
  const { decide } = await load();

  const scenarios = [
    { label: "user-authored comment", newComment: "user said: looks good", author: "user" },
    { label: "Scope added comment", newComment: "Scope added (user): also handle X", author: "orchestrator" },
    { label: "verdict event", newComment: "orchestrator verdict: bounce", verdict: "bounce" },
  ];

  for (const s of scenarios) {
    const calls = [];
    await decide({
      point: "wake",
      ticket: TICKET,
      ticketText: "# 07\n\n**Status:** in-review\n",
      ...s,
      now: NOW,
      env: { TYPESAFE_API_KEY: KEY },
      transport: fake(routeAns, calls),
    });
    assert.equal(calls.length, 0, `${s.label}: transport must not be called`);
  }
});

// An absent author is not a known role, so code wakes (77 security bounce).
test("wake: a comment with no author produces zero transport calls", async () => {
  const { decide } = await load();
  for (const author of [undefined, null]) {
    const calls = [];
    await decide({
      point: "wake",
      ticket: TICKET,
      ticketText: "# 07\n\n**Status:** in-review\n",
      newComment: "a plain comment",
      author,
      now: NOW,
      env: { TYPESAFE_API_KEY: KEY },
      transport: fake(routeAns, calls),
    });
    assert.equal(calls.length, 0, `author ${author}: transport must not be called`);
  }
});

// ====================================================================
// AC5 — 46's dead release-gate code removed
// This criterion is human-verified: the developer removes the dead
// `claimMtimeMs === undefined ? undefined : {...}` branch in
// apps/board/board-service.mjs, or the ticket comment explains
// why it stays. The qa agent cannot verify source removal automatically
// without testing implementation details.
// Mark: human-verified
// ====================================================================

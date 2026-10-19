// herald/02: the draft-shape check. One seam: checkDraft(text) takes a herald
// draft file's text and returns an array of violation strings (empty = ok).
//
// Draft format under test: a header block fenced by `---` lines at the top
// (metadata for the user, not post text) with `title:`, `channel:`, `image:`
// and a `sources:` list of `- item` lines; then the post text, 1-3 paragraphs
// separated by blank lines. Rules: header present, at most 3 paragraphs,
// non-empty sources list, no email addresses, no credential-looking strings.
//
// Module: scripts/draft-check.mjs, exporting `checkDraft`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDraft } from "./draft-check.mjs";

const HEADER = [
  "---",
  "title: Why Dim Sum Dev exists",
  "series: First series, 1 of 4",
  "channel: LinkedIn",
  "image: none",
  "sources:",
  "  - CONTEXT.md",
  "  - docs/adr/0002-relay-not-swarm.md",
  "---",
].join("\n");

const P1 = "Running several AI agents at once is easy. Keeping control of them is not.";
const P2 = "We modeled the work as an org, where each agent does one job and hands off.";
const P3 = "The result is a relay a person can watch and steer.";
const P4 = "A fourth paragraph that should not be here.";

const draft = (header, ...paras) => `${header}\n\n${paras.join("\n\n")}\n`;

test("a good draft (header, 3 paragraphs, sources) has no violations", () => {
  assert.deepEqual(checkDraft(draft(HEADER, P1, P2, P3)), []);
});

test("a good draft with a single paragraph has no violations", () => {
  assert.deepEqual(checkDraft(draft(HEADER, P1)), []);
});

test("a draft with no header is a violation", () => {
  const v = checkDraft(`${P1}\n\n${P2}\n`);
  assert.ok(v.length > 0);
  assert.ok(v.some((m) => /header/i.test(m)), `no header violation in ${JSON.stringify(v)}`);
});

test("a draft with more than 3 paragraphs is a violation", () => {
  const v = checkDraft(draft(HEADER, P1, P2, P3, P4));
  assert.ok(v.some((m) => /paragraph/i.test(m)), `no paragraph violation in ${JSON.stringify(v)}`);
});

test("header lines do not count as paragraphs", () => {
  // 3 paragraphs plus a multi-line header must still pass.
  assert.deepEqual(checkDraft(draft(HEADER, P1, P2, P3)), []);
});

test("a draft with an empty sources list is a violation", () => {
  const noSources = HEADER.replace(/sources:[\s\S]*---$/, "sources:\n---");
  const v = checkDraft(draft(noSources, P1));
  assert.ok(v.some((m) => /source/i.test(m)), `no sources violation in ${JSON.stringify(v)}`);
});

test("a draft with no sources key is a violation", () => {
  const noKey = HEADER.replace(/sources:[\s\S]*---$/, "---");
  const v = checkDraft(draft(noKey, P1));
  assert.ok(v.some((m) => /source/i.test(m)), `no sources violation in ${JSON.stringify(v)}`);
});

test("an email address in the post text is a violation", () => {
  const v = checkDraft(draft(HEADER, `${P1} Write to someone@example.com.`));
  assert.ok(v.some((m) => /email/i.test(m)), `no email violation in ${JSON.stringify(v)}`);
});

test("an email address in the header is a violation", () => {
  const v = checkDraft(draft(HEADER.replace("channel: LinkedIn", "channel: someone@example.com"), P1));
  assert.ok(v.some((m) => /email/i.test(m)), `no email violation in ${JSON.stringify(v)}`);
});

test("a credential-looking string is a violation", () => {
  const cases = [
    "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "sk-" + "ant-api03-abcdefghijklmnopqrstuvwx",
    "AKIA" + "IOSFODNN7EXAMPLE",
    "api_key=" + "abcdef1234567890abcdef",
  ];
  for (const secret of cases) {
    const v = checkDraft(draft(HEADER, `${P1} Token: ${secret}`));
    assert.ok(
      v.some((m) => /secret|credential|token|key/i.test(m)),
      `no secret violation for ${secret} in ${JSON.stringify(v)}`,
    );
  }
});

test("each bad draft reports its own rule, not the others", () => {
  const good = checkDraft(draft(HEADER, P1, P2, P3));
  assert.equal(good.length, 0);
  const tooLong = checkDraft(draft(HEADER, P1, P2, P3, P4));
  assert.ok(!tooLong.some((m) => /email|secret|credential/i.test(m)));
});

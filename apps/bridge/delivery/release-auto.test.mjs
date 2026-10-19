import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutoRelease } from "./release-auto.mjs";

const SHA = (c) => c.repeat(40);
const pr = (number, sha, files, mergedBy = "me", title = `fix: thing ${number}`) => ({ number, title, sha, files, mergedBy });
function fake({ prs, tag = "v0.4.1", existing = [] }) {
  const published = [];
  return {
    published,
    mainSha: async () => SHA("f"), lastTag: async () => tag, login: async () => "me",
    tagExists: async (v) => existing.includes(v),
    mergedPrs: async () => prs,
    publishRelease: async (r) => { published.push(r); },
  };
}

test("a merge touching a bridge path gets the next patch tag; the notes list the merged PRs", async () => {
  const git = fake({ prs: [pr(9, SHA("9"), ["apps/bridge/server.mjs"]), pr(8, SHA("8"), ["docs/a.md"])] });
  const r = await createAutoRelease({ git }).poll();
  assert.equal(r.tagged, "v0.4.2");
  assert.deepEqual(git.published.map((p) => [p.version, p.sha]), [["v0.4.2", SHA("9")]]);
  assert.match(git.published[0].notes, /fix: thing 9 \(#9\)/);
  assert.match(git.published[0].notes, /#8/);
});

test("the tag goes on the newest bridge merge, so a later docs merge is not in it", async () => {
  const git = fake({ prs: [pr(10, SHA("a"), ["docs/a.md"]), pr(9, SHA("9"), ["package.json"])] });
  await createAutoRelease({ git }).poll();
  assert.equal(git.published[0].sha, SHA("9"));
  assert.doesNotMatch(git.published[0].notes, /#10/);
});

test("a docs-only merge and a UI-only merge get no tag", async () => {
  for (const files of [["docs/adr/1.md", "README.md"], ["apps/ui/src/App.jsx"]]) {
    const git = fake({ prs: [pr(5, SHA("5"), files)] });
    assert.equal((await createAutoRelease({ git }).poll()).tagged, null);
    assert.equal(git.published.length, 0);
  }
});

test("a bridge commit merged by someone other than the user's login gets no tag", async () => {
  const git = fake({ prs: [pr(5, SHA("5"), ["apps/bridge/x.mjs"], "someone-else")] });
  assert.equal((await createAutoRelease({ git }).poll()).tagged, null);
  assert.equal(git.published.length, 0);
});

test("a tag that already exists is never reused or moved", async () => {
  const git = fake({ prs: [pr(5, SHA("5"), ["apps/bridge/x.mjs"])], existing: ["v0.4.2"] });
  const r = await createAutoRelease({ git }).poll();
  assert.equal(r.tagged, null);
  assert.equal(git.published.length, 0);
});

test("a git host failure is reported, not thrown", async () => {
  const git = fake({ prs: [] });
  git.mainSha = async () => { throw new Error("offline"); };
  assert.match((await createAutoRelease({ git }).poll()).error, /offline/);
});

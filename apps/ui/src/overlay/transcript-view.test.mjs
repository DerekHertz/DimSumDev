// den-v1/05 criterion 2: "The panel shows new events as they arrive while open."
// Seam: apps/ui/src/overlay/transcript-view.mjs, a pure module the panel renders from (qa pinned the contract).
//   transcriptView(buffer, ui) -> view
//     buffer = { entries, dropped } as kept by transcript-buffer.mjs (entries carry n), or undefined for none yet
//     ui = { expanded: number[] (entry n's the user opened), atBottom: boolean, seenThrough: number (highest n the
//            user has scrolled past), connection: { phase } }
//     view = { empty, emptyText, droppedNotice, droppedText, rows, atBottom, unread, jumpLabel, banner }
//   Rows keep arrival order, oldest first, so the newest is last (bottom). Row kinds:
//     message    { kind, n, speaker: "Agent"|"You", text, at }
//     tool       { kind, n, name, summary, status, expanded, toggleLabel: "Show details"|"Hide details",
//                  and when expanded: inputText (JSON string of input), result: { text, truncatedBytes } | null }
//                tool calls are collapsed unless their n is in ui.expanded (user, 2026-10-08)
//     permission { kind, n, name, label: "Waiting on you", detail, answerable }   (the pending one names its target and
//                can be answered: den-request.test.mjs)
//     ended      { kind, n, state, label: "Agent ended: <state>" }
//     unreadable { kind, n, type, label: "Unreadable event" }
//   A result over 4096 bytes shows its first 4096 and truncatedBytes counts the rest.
//   The view never mutates its input and never throws on a bad entry.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { transcriptView } from "./transcript-view.mjs";
import { appendTranscript } from "../state/transcript-buffer.mjs";

const msg = (text, role = "agent") => ({ kind: "message", role, text, at: "2026-10-08T14:02:00Z" });
const tool = (extra = {}) => ({ kind: "tool", id: "t1", name: "Edit", summary: "live-store.mjs", status: "done", input: { path: "live-store.mjs" }, result: "done", at: "2026-10-08T14:02:30Z", ...extra });
const fill = (...entries) => entries.reduce((b, e) => appendTranscript(b, "c-1", e), {})["c-1"];
const ui = (extra = {}) => ({ expanded: [], atBottom: true, seenThrough: 0, connection: { phase: "live" }, ...extra });

describe("rows", () => {
  test("new events show as new rows in arrival order, newest last", () => {
    const first = transcriptView(fill(msg("one")), ui());
    assert.deepEqual(first.rows.map((r) => r.text), ["one"]);
    const second = transcriptView(fill(msg("one"), msg("two"), msg("three")), ui());
    assert.deepEqual(second.rows.map((r) => r.text), ["one", "two", "three"]);
  });

  test("messages name the speaker: Agent or You", () => {
    const v = transcriptView(fill(msg("hi"), msg("use 200", "user")), ui());
    assert.deepEqual(v.rows.map((r) => r.speaker), ["Agent", "You"]);
    assert.equal(v.rows[1].text, "use 200");
    assert.equal(v.rows[0].at, "2026-10-08T14:02:00Z");
  });

  // den-v1 loop S5: a message the user sent from the den carries its delivery status; the bridge resends the entry.
  test("your own message says whether the agent has taken it yet", () => {
    const mine = (status) => transcriptView(fill({ ...msg("use 200", "user"), messageId: "m-1", ...(status ? { status } : {}) }), ui()).rows[0];
    assert.equal(mine("queued").note, "Queued");
    assert.equal(mine("applied").note, "Received");
    assert.equal(mine("undelivered").note, "Not delivered");
    assert.equal(mine().note, null);
    assert.equal(mine("hologram").note, null, "an unknown status shows nothing");
    assert.equal(mine("queued").speaker, "You");
    assert.equal(transcriptView(fill({ ...msg("hi"), status: "queued" }), ui()).rows[0].note, null, "an agent's message has no delivery status");
  });

  test("a status change replaces the row instead of adding one", () => {
    const sent = { ...msg("use 200", "user"), id: 4, messageId: "m-1" };
    const v = transcriptView(fill({ ...sent, status: "queued" }, { ...sent, status: "applied" }), ui());
    assert.deepEqual(v.rows.map((r) => r.note), ["Received"]);
  });

  test("tool calls are collapsed by default and say how to open them", () => {
    const [row] = transcriptView(fill(tool()), ui()).rows;
    assert.equal(row.kind, "tool");
    assert.equal(row.name, "Edit");
    assert.equal(row.summary, "live-store.mjs");
    assert.equal(row.status, "done");
    assert.equal(row.expanded, false);
    assert.equal(row.toggleLabel, "Show details");
  });

  test("a tool call the user opened shows its input and result, and offers Hide details", () => {
    const buffer = fill(tool());
    const [row] = transcriptView(buffer, ui({ expanded: [buffer.entries[0].n] })).rows;
    assert.equal(row.expanded, true);
    assert.equal(row.toggleLabel, "Hide details");
    assert.deepEqual(JSON.parse(row.inputText), { path: "live-store.mjs" });
    assert.deepEqual(row.result, { text: "done", truncatedBytes: 0 });
  });

  test("opening one tool call leaves the others collapsed", () => {
    const buffer = fill(tool({ id: "a" }), tool({ id: "b" }));
    const rows = transcriptView(buffer, ui({ expanded: [buffer.entries[1].n] })).rows;
    assert.deepEqual(rows.map((r) => r.expanded), [false, true]);
  });

  test("a tool call still running has no result yet", () => {
    const buffer = fill(tool({ status: "running", result: undefined }));
    const [row] = transcriptView(buffer, ui({ expanded: [buffer.entries[0].n] })).rows;
    assert.equal(row.status, "running");
    assert.equal(row.result, null);
  });

  test("a failed tool call keeps the word failed", () => {
    const [row] = transcriptView(fill(tool({ status: "failed", result: "EACCES" })), ui()).rows;
    assert.equal(row.status, "failed");
  });

  test("a result over 4 KB shows its first 4096 bytes and counts the rest", () => {
    const buffer = fill(tool({ result: "x".repeat(5000) }));
    const [row] = transcriptView(buffer, ui({ expanded: [buffer.entries[0].n] })).rows;
    assert.equal(row.result.text.length, 4096);
    assert.equal(row.result.truncatedBytes, 904);
  });

  test("a result of exactly 4096 bytes is not truncated", () => {
    const buffer = fill(tool({ result: "y".repeat(4096) }));
    const [row] = transcriptView(buffer, ui({ expanded: [buffer.entries[0].n] })).rows;
    assert.equal(row.result.text.length, 4096);
    assert.equal(row.result.truncatedBytes, 0);
  });

  test("a pending permission request names the tool and says Waiting on you, with no actions", () => {
    const [row] = transcriptView(fill({ kind: "permission", name: "Bash" }), ui()).rows;
    assert.equal(row.kind, "permission");
    assert.equal(row.name, "Bash");
    assert.equal(row.label, "Waiting on you");
    assert.equal("actions" in row, false, "A and D belong to ticket 06");
  });

  // den-v1 loop S2: the bridge resends the entry with the answer, so the row stops saying it waits.
  test("an answered permission request says how it ended, and only a pending one is waiting", () => {
    const label = (status) => transcriptView(fill({ kind: "permission", name: "Write", ...(status ? { status } : {}) }), ui()).rows[0];
    assert.deepEqual([label("pending").label, label("pending").waiting], ["Waiting on you", true]);
    assert.equal(label().waiting, true);
    assert.deepEqual([label("allowed").label, label("allowed").waiting], ["Allowed by you", false]);
    assert.deepEqual([label("denied").label, label("denied").waiting], ["Denied by you", false]);
    assert.deepEqual([label("expired").label, label("expired").waiting], ["Expired: denied", false]);
    assert.deepEqual([label("hologram").label, label("hologram").waiting], ["Waiting on you", true], "an unknown status reads as pending");
  });

  test("an agent that ended leaves a final line with its state", () => {
    const rows = transcriptView(fill(msg("bye"), { kind: "ended", state: "failed" }), ui()).rows;
    assert.equal(rows.at(-1).kind, "ended");
    assert.equal(rows.at(-1).label, "Agent ended: failed");
  });

  test("an unreadable event shows a labelled row with its type, and the others still show", () => {
    const rows = transcriptView(fill({ kind: "unreadable", type: "hologram" }, msg("after")), ui()).rows;
    assert.equal(rows[0].kind, "unreadable");
    assert.equal(rows[0].label, "Unreadable event");
    assert.equal(rows[0].type, "hologram");
    assert.equal(rows[1].text, "after");
  });

  test("a bad entry in the buffer degrades to an unreadable row instead of throwing", () => {
    const buffer = { entries: [{ n: 1, kind: "message", role: "agent", text: "ok" }, null, { n: 3, kind: "tool" }, { n: 4, kind: "wat" }], dropped: 0 };
    const v = transcriptView(buffer, ui());
    assert.equal(v.rows.length, 4);
    assert.equal(v.rows[0].text, "ok");
    assert.equal(v.rows[1].kind, "unreadable");
    assert.equal(v.rows[3].kind, "unreadable");
  });

  test("the view does not mutate the buffer or the ui state", () => {
    const buffer = fill(tool(), msg("x"));
    const state = ui({ expanded: [1] });
    const frozen = structuredClone({ buffer, state });
    transcriptView(buffer, state);
    assert.deepEqual({ buffer, state }, frozen);
  });
});

describe("empty, dropped, and the jump pill", () => {
  test("no buffer yet, or an empty one, shows the waiting text", () => {
    for (const buffer of [undefined, { entries: [], dropped: 0 }]) {
      const v = transcriptView(buffer, ui());
      assert.equal(v.empty, true);
      assert.equal(v.emptyText, "Waiting for the agent's first message.");
      assert.deepEqual(v.rows, []);
    }
  });

  test("a buffer with entries is not empty", () => {
    assert.equal(transcriptView(fill(msg("x")), ui()).empty, false);
  });

  test("when entries were dropped the first row is the dropped notice", () => {
    let b = {};
    for (let i = 0; i < 5; i += 1) b = appendTranscript(b, "c-1", msg(`m${i}`), 3);
    const v = transcriptView(b["c-1"], ui());
    assert.equal(v.droppedNotice, true);
    assert.equal(v.droppedText, "Earlier entries were dropped");
    assert.equal(v.rows.length, 3);
    assert.equal(transcriptView(fill(msg("x")), ui()).droppedNotice, false);
  });

  test("at the bottom there is nothing unread and no jump pill", () => {
    const v = transcriptView(fill(msg("a"), msg("b")), ui({ atBottom: true, seenThrough: 0 }));
    assert.equal(v.unread, 0);
    assert.equal(v.jumpLabel, null);
  });

  test("scrolled up, new events count as unread and the pill says how many", () => {
    const buffer = fill(msg("a"), msg("b"), msg("c"));
    const v = transcriptView(buffer, ui({ atBottom: false, seenThrough: 1 }));
    assert.equal(v.unread, 2);
    assert.equal(v.jumpLabel, "Jump to latest (2)");
    assert.equal(v.rows.length, 3, "the rows keep arriving; only the scroll position stays put");
  });

  test("unread counts events that arrived after the user scrolled up, across drops", () => {
    let b = {};
    for (let i = 0; i < 6; i += 1) b = appendTranscript(b, "c-1", msg(`m${i}`), 3);
    const v = transcriptView(b["c-1"], ui({ atBottom: false, seenThrough: 4 }));
    assert.equal(v.unread, 2, "arrivals 5 and 6 are newer than n=4");
  });
});

describe("connection banner", () => {
  const entries = fill(msg("kept"));
  test("live shows no banner", () => {
    assert.equal(transcriptView(entries, ui({ connection: { phase: "live" } })).banner, null);
  });
  test("connecting and reconnecting show Reconnecting... and keep the entries", () => {
    for (const phase of ["connecting", "reconnecting"]) {
      const v = transcriptView(entries, ui({ connection: { phase } }));
      assert.equal(v.banner, "Reconnecting...");
      assert.equal(v.rows.length, 1);
    }
  });
  test("offline says to run npm run ui and keeps the entries readable", () => {
    const v = transcriptView(entries, ui({ connection: { phase: "offline" } }));
    assert.equal(v.banner, "Bridge offline: run npm run ui");
    assert.equal(v.rows[0].text, "kept");
  });
});

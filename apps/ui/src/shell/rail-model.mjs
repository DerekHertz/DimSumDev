// team-and-den-ux/04 (design/04-spec.md sections 1, 3 and 6): the rail, its badges, and the order Escape closes things in.
// Pure: no React, no DOM. App.jsx and Rail.jsx render what these return.
import { needsYouModel } from "../overlay/overlay-model.mjs";
import { newVersionReady } from "../overlay/build-model.mjs";

// The rail, top to bottom (spec section 3). `slot` says where an entry opens: a topic sheet by the rail, the side sheet
// (a conversation), or nothing (an action). `from` names where each destination lived before the rail, so the inventory
// test can check nothing was lost in the move.
export const RAIL_ENTRIES = Object.freeze([
  { id: "bao", label: "Talk to Bao", icon: "speech", slot: "side", from: "masthead Talk to Bao" },
  { id: "needs", label: "Needs you", icon: "bell", slot: "topic", from: "desk Needs you card" },
  { id: "queue", label: "Queue", icon: "list", slot: "topic", wide: true, from: "desk Queue button and drawer" },
  { id: "work", label: "Work", icon: "steamer", slot: "topic", from: "desk Teams & queue card, deliveries and slots; top nav Work" },
  { id: "meetings", label: "Meetings", icon: "people", slot: "topic", from: "desk Meetings card" },
  { id: "team", label: "Team", icon: "panda", slot: "topic", from: "top nav Pandas (Residents)" },
  { id: "library", label: "Library", icon: "book", slot: "topic", from: "desk Library card; top nav Library" },
  { id: "tally", label: "Tally", icon: "bars", slot: "topic", from: "scene Tally chip" },
]);
export const RAIL_FOOTER = Object.freeze([
  { id: "build", label: "Den build", icon: "tag", slot: "topic", from: "desk build card" },
  { id: "demo", label: "Watch the demo", icon: "play", slot: null, from: "masthead Watch the demo" },
  { id: "reset", label: "Reset view", icon: "target", slot: null, from: "garden Reset view link" },
]);
// Each sheet's header: an eyebrow and a title (spec section 4).
export const SHEET_HEADS = Object.freeze({
  needs: ["Waiting on you", "Needs you"], queue: ["The board", "Queue"], work: ["In motion", "Work"],
  meetings: ["Talk it over", "Meetings"], team: ["Every role", "Team"], library: ["Shared", "Library"],
  tally: ["The abacus", "Tally"], build: ["The den", "Den build"], replay: ["Hierarchy audit", "Replay"], meeting: ["Meeting", null], conversation: ["Conversation", null],
});
export const TOPICS = Object.freeze([...RAIL_ENTRIES, ...RAIL_FOOTER].filter((e) => e.slot === "topic").map((e) => e.id));
export const topicEntry = (id) => [...RAIL_ENTRIES, ...RAIL_FOOTER].find((e) => e.id === id) ?? null;

/** Each entry's badge: { count } (hidden at 0) or { dot }. */
export function railBadges({ snapshot, now, ownBuild = null } = {}) {
  const meetings = Array.isArray(snapshot?.meetings) ? snapshot.meetings : [];
  return {
    needs: { count: needsYouModel(snapshot, now).count },
    queue: { count: Array.isArray(snapshot?.frontier) ? snapshot.frontier.length : 0 },
    meetings: { dot: meetings.some((m) => m?.state === "running") },
    build: { dot: newVersionReady(ownBuild, snapshot?.build ?? null) },
  };
}

/** The build entry's label: "Den v0.1.3" from the live build's tag, else "Den build". */
export const buildLabel = (build) => (typeof build?.live?.tag === "string" && /^[\w.+-]{1,32}$/.test(build.live.tag) ? `Den ${build.live.tag}` : "Den build");

/** The accessible name of a rail entry, with its count ("Needs you, 3 waiting"). */
export function entryName(entry, badge) {
  if (badge?.count > 0) return `${entry.label}, ${badge.count} ${entry.id === "queue" ? "ready" : "waiting"}`;
  if (badge?.dot) return `${entry.label}, ${entry.id === "meetings" ? "one is running" : "an update is ready"}`;
  return entry.label;
}

// The open sheets, oldest first: at most one topic and one side sheet (spec 1.3). Opening a topic replaces the topic;
// opening a conversation replaces the side sheet. Each layer remembers what opened it, for focus on close.
export const emptyLayers = () => [];
export function openLayer(layers, layer) {
  return [...layers.filter((l) => l.slot !== layer.slot), layer];
}
export function closeLayer(layers, slot) {
  return layers.filter((l) => l.slot !== slot);
}
export const topLayer = (layers) => layers.at(-1) ?? null;
export const layerIn = (layers, slot) => layers.find((l) => l.slot === slot) ?? null;

/**
 * What one Escape press does (spec 1.6), as a name the shell acts on:
 *   "confirm"  an open inline confirm (it closes itself)
 *   "sheet"    close the top sheet
 *   "deselect" clear the selected panda's card
 *   "walk"     leave it to walk mode (the explorer frees the cursor, then leaves)
 *   null       nothing (the diorama with nothing open)
 * Closing a sheet never leaves walk mode: a press that closes something is taken, so the explorer never sees it.
 */
export function escapeAction({ layers, confirming = false, picked = false, walking = false }) {
  if (confirming) return "confirm";
  if (layers.length) return "sheet";
  if (picked && !walking) return "deselect";
  if (walking) return "walk";
  return null;
}

// den-mvp outcome 4 (spec section 6, ADR 0017): the fixed numbers and names of a meeting. No imports, so the den's page
// reads the same lists as the bridge.
// A specialist is a role that runs on a worker slot. Bao chairs on Bao's own slot.
export const SPECIALISTS = ["product", "architect", "developer", "qa", "security", "designer", "code-reviewer", "release-manager", "sre", "technical-writer"];
export const CHAIR = "orchestrator";
export const SEATS_MAX = 6;
export const TOPIC_MAX_BYTES = 2048;
export const REJOIN_MS = 24 * 60 * 60 * 1000; // how long a decided or closed meeting keeps its takes and can be asked again
export const MEETING_STATES = ["running", "paused", "briefed", "decided", "closed"];
export const SEAT_STATES = ["waiting", "taken", "declined", "failed"];

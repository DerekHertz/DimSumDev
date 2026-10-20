// The character director (ADR 0007, spec.md "Character director"): a pure module, no renderer
// dependency. It takes agent-state changes (and, later, handoff events, perch anchors and time) and
// answers `tick(agentId, now)` with a clip name, whether it loops, a face frame and a cross-fade hint. State→clip
// names were the panda asset contract (removed with the glbs, den-v1/08; director.test.mjs keeps a frozen copy) so the two
// stay in lockstep.

export const STATES = [
  "idle", "working", "waiting_on_user", "blocked",
  "done", "failed", "throttled", "terminated",
];

// Design system motion tokens (project/tokens.json in the design system artifact).
export const DUR_FAST = 0.16;
export const DUR_HEARTBEAT = 1.2;

const BLINK_DURATION = 0.12;

// Each state maps to a looping clip, an entry one-shot, a face frame and a held pose for reduced
// motion (spec.md, "State → clip map"). `loop` is what the agent settles into after the entry;
// `loops` says whether it repeats (a contract LOOPS clip) or is a pose clip played once and held.
// Every clip named here must exist in the asset contract's CLIPS list, and `loops` must agree with
// its LOOPS list (both enforced by director.test.mjs, not re-imported here to keep this module
// dependency-free).
export const STATE_MAP = {
  idle: { loop: "sit_still", loops: false, enter: "sit_still", face: "half_lidded", heldPose: "sit_still", enterDuration: 0 },
  working: { loop: "breathe", loops: true, enter: "breathe", face: "focused_squint", heldPose: "breathe", enterDuration: 0 },
  waiting_on_user: { loop: "paw_raise", loops: true, enter: "paw_raise", face: "wide_eyes", heldPose: "paw_raise", enterDuration: 0 },
  blocked: { loop: "arms_folded", loops: false, enter: "arms_folded", face: "narrowed", heldPose: "arms_folded", enterDuration: 0 },
  done: { loop: "lean_back", loops: false, enter: "lean_back", face: "content_squint", heldPose: "lean_back", enterDuration: 0 },
  failed: { loop: "slump", loops: false, enter: "slump", face: "sour_pucker", heldPose: "slump", enterDuration: 0 },
  throttled: { loop: "doze", loops: true, enter: "doze", face: "sleepy", heldPose: "doze", enterDuration: 0 },
  // Story 8: wave once (the contract's wave clip runs 1.87 s), then settle. The ghost fade isn't a clip.
  terminated: { loop: "sit_still", loops: false, enter: "wave", face: "eyes_shut_savoring", heldPose: "sit_still", enterDuration: 1.87 },
};

const DEFAULT_STATE = "idle";

// Per-type idle habits (spec.md "Per-type idle habits", ticket 07): a working Brain-type agent
// loops its own prop clip instead of the generic `breathe`. Only the three modeled Brain types
// (orchestrator, product, architect) have a habit today; every other type still breathes. Clip
// names must exist in the asset contract's CLIPS/LOOPS (cross-checked in director.test.mjs, not
// re-imported here, matching STATE_MAP's convention).
export const HABIT_LOOPS = {
  orchestrator: "fan_tap_and_point",
  product: "scroll_unroll",
  architect: "blueprint_unroll",
};

function newAgent(state, now) {
  return { state, since: now, nextBlinkAt: undefined };
}

/** Returns state's mapping, substituting the habit loop for `working` when role has one. */
function mappingFor(state, role) {
  const habit = state === "working" ? HABIT_LOOPS[role] : undefined;
  if (!habit) return STATE_MAP[state];
  return { ...STATE_MAP[state], loop: habit, enter: habit, heldPose: habit, loops: true };
}

/**
 * Creates a character director. `reducedMotion` and `random` (an injectable RNG, for
 * deterministic tests of the calm rule) are the only options; everything else arrives through
 * `setState`/`setAgentType`/`tick`.
 */
export function createCharacterDirector({ reducedMotion = false, random = Math.random } = {}) {
  const agents = new Map();
  // Kept separate from `agents`: a type is a fixed identity, not part of the state timeline, so
  // recording it never resets or depends on a agent's `since` (order-independent with setState).
  const roles = new Map();

  function agentOf(agentId, now) {
    let agent = agents.get(agentId);
    if (!agent) {
      agent = newAgent(DEFAULT_STATE, now);
      agents.set(agentId, agent);
    }
    return agent;
  }

  return {
    setReducedMotion(value) {
      reducedMotion = value;
    },

    /** Pushes a agent-state-changed event. Interrupts immediately, even mid one-shot or mid loop. */
    setState(agentId, state, now) {
      if (!STATE_MAP[state]) throw new Error(`unknown state "${state}"`);
      agents.set(agentId, newAgent(state, now));
    },

    /** Records `agentId`'s agent type (spec.md "Per-type idle habits"), for the `working` habit loop. */
    setAgentType(agentId, role) {
      roles.set(agentId, role);
    },

    /** Samples the clip, face frame and cross-fade hint for `agentId` at time `now` (seconds). */
    tick(agentId, now) {
      const agent = agentOf(agentId, now);
      const mapping = mappingFor(agent.state, roles.get(agentId));
      const sinceChange = now - agent.since;
      const crossFade = sinceChange < DUR_FAST ? DUR_FAST : 0;

      if (reducedMotion) {
        return { clip: mapping.heldPose, loop: false, face: mapping.face, crossFade: 0 };
      }

      const entering = sinceChange < mapping.enterDuration;
      const clip = entering ? mapping.enter : mapping.loop;

      // The calm rule: blinks are spaced no closer than dur-heartbeat, scheduled independently of
      // the body clip since the face is a separate texture-atlas channel (spec.md, "Faces").
      if (agent.nextBlinkAt === undefined) {
        agent.nextBlinkAt = now + DUR_HEARTBEAT + random() * DUR_HEARTBEAT;
      }
      let face = mapping.face;
      if (now >= agent.nextBlinkAt) {
        if (now < agent.nextBlinkAt + BLINK_DURATION) {
          face = "blink";
        } else {
          agent.nextBlinkAt = now + DUR_HEARTBEAT + random() * DUR_HEARTBEAT;
        }
      }

      return { clip, loop: !entering && mapping.loops, face, crossFade };
    },
  };
}

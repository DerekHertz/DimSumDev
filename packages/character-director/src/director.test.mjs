import { test } from "node:test";
import assert from "node:assert/strict";
import { STATES, STATE_MAP, DUR_FAST, DUR_HEARTBEAT, HABIT_LOOPS, createCharacterDirector } from "./director.mjs";
// The panda glb contract (apps/ui/src/assets/panda-contract.mjs) was removed with the glbs (den-v1/08). The names
// it held are kept here as a frozen copy, so the director's state mapping is still checked against the clip names
// the rig authored.
const CLIPS = [
  "sit_still", "breathe", "blink", "paw_raise", "arms_folded", "slump", "lean_back", "doze", "wave",
  "fan_tap_and_point", "scroll_unroll", "blueprint_unroll",
];
const LOOPS = ["breathe", "paw_raise", "doze", "fan_tap_and_point", "scroll_unroll", "blueprint_unroll"];
const FACE_FRAMES = [
  "blink", "content_squint", "wide_eyes", "half_lidded", "focused_squint",
  "narrowed", "eyes_shut_savoring", "sour_pucker", "sleepy", "yawn",
];
const PROP_ASSETS = {
  orchestrator: { clip: "fan_tap_and_point" },
  product: { clip: "scroll_unroll" },
  architect: { clip: "blueprint_unroll" },
};

test("every state maps to a loop, entry one-shot, face frame and held pose, all named in the asset contract", () => {
  assert.deepEqual([...STATES].sort(), [
    "blocked", "done", "failed", "idle", "terminated", "throttled", "waiting_on_user", "working",
  ]);
  for (const state of STATES) {
    const mapping = STATE_MAP[state];
    assert.ok(mapping, `no mapping for ${state}`);
    assert.ok(CLIPS.includes(mapping.loop), `${state}.loop "${mapping.loop}" is not a contract clip`);
    assert.ok(CLIPS.includes(mapping.enter), `${state}.enter "${mapping.enter}" is not a contract clip`);
    assert.ok(CLIPS.includes(mapping.heldPose), `${state}.heldPose "${mapping.heldPose}" is not a contract clip`);
    assert.ok(FACE_FRAMES.includes(mapping.face), `${state}.face "${mapping.face}" is not a contract face frame`);
    assert.equal(mapping.loops, LOOPS.includes(mapping.loop), `${state}.loops disagrees with the contract's LOOPS`);
  }
});

test("pose clips are held once settled, and only contract loop clips repeat", () => {
  const director = createCharacterDirector();
  for (const state of STATES) {
    director.setState("agent-1", state, 0);
    const cmd = director.tick("agent-1", 10);
    assert.equal(cmd.clip, STATE_MAP[state].loop, state);
    assert.equal(cmd.loop, LOOPS.includes(cmd.clip), state);
  }
});

test("a terminated agent waves once, then settles instead of waving again", () => {
  const director = createCharacterDirector();
  director.setState("agent-1", "terminated", 0);
  const waving = director.tick("agent-1", 1);
  assert.equal(waving.clip, "wave");
  assert.equal(waving.loop, false);
  const settled = director.tick("agent-1", 5);
  assert.notEqual(settled.clip, "wave");
  assert.equal(settled.loop, false);
});

test("a agent defaults to idle before any state is pushed", () => {
  const director = createCharacterDirector();
  const cmd = director.tick("agent-1", 0);
  assert.equal(cmd.clip, STATE_MAP.idle.enter);
  assert.equal(cmd.face, STATE_MAP.idle.face);
});

test("tick plays each state's entry clip and face frame right after a state change", () => {
  const director = createCharacterDirector();
  for (const state of STATES) {
    director.setState("agent-1", state, 0);
    const cmd = director.tick("agent-1", 0);
    assert.equal(cmd.clip, STATE_MAP[state].enter, state);
    assert.equal(cmd.face, STATE_MAP[state].face, state);
  }
});

test("tick settles into the state's loop once the entry duration has elapsed", () => {
  const director = createCharacterDirector();
  director.setState("agent-1", "working", 0);
  const cmd = director.tick("agent-1", 10);
  assert.equal(cmd.clip, STATE_MAP.working.loop);
  assert.equal(cmd.loop, true);
});

test("a state change interrupts immediately, even mid one-shot, and cross-fades for dur-fast", () => {
  const director = createCharacterDirector();
  director.setState("agent-1", "terminated", 0); // wave is a one-shot, never reaches a loop
  director.tick("agent-1", 0.05); // still mid one-shot
  director.setState("agent-1", "blocked", 0.05);
  const justChanged = director.tick("agent-1", 0.05);
  assert.equal(justChanged.clip, STATE_MAP.blocked.enter);
  assert.equal(justChanged.crossFade, DUR_FAST);

  const afterFade = director.tick("agent-1", 0.05 + DUR_FAST + 0.01);
  assert.equal(afterFade.crossFade, 0);
});

test("reduced motion holds every state's pose and face with no loop, breathing, blink or crossfade", () => {
  const director = createCharacterDirector({ reducedMotion: true });
  for (const state of STATES) {
    director.setState("agent-1", state, 0);
    const cmd = director.tick("agent-1", 500); // long after any transition or blink would fire
    assert.equal(cmd.clip, STATE_MAP[state].heldPose, state);
    assert.equal(cmd.face, STATE_MAP[state].face, state);
    assert.equal(cmd.loop, false, state);
    assert.equal(cmd.crossFade, 0, state);
  }
});

test("the calm rule: blinks never come faster than dur-heartbeat apart", () => {
  // A deterministic "random" that always returns 0 asks for the fastest legal blink cadence.
  const director = createCharacterDirector({ random: () => 0 });
  director.setState("agent-1", "working", 0);
  const blinkTimes = [];
  for (let t = 0; t < 20; t += 0.05) {
    const cmd = director.tick("agent-1", t);
    if (cmd.face === "blink") blinkTimes.push(t);
  }
  const starts = blinkTimes.filter((t, i) => i === 0 || t - blinkTimes[i - 1] > 0.1);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= DUR_HEARTBEAT - 1e-9, `blinks at ${starts[i - 1]} and ${starts[i]} are closer than dur-heartbeat`);
  }
  assert.ok(starts.length > 1, "expected more than one blink over 20s at the fastest cadence");
});

test("reduced motion never blinks", () => {
  const director = createCharacterDirector({ reducedMotion: true, random: () => 0 });
  director.setState("agent-1", "working", 0);
  for (let t = 0; t < 20; t += 0.1) {
    assert.notEqual(director.tick("agent-1", t).face, "blink");
  }
});

test("agents are tracked independently", () => {
  const director = createCharacterDirector();
  director.setState("a", "done", 0);
  director.setState("b", "failed", 0);
  assert.equal(director.tick("a", 0).clip, STATE_MAP.done.enter);
  assert.equal(director.tick("b", 0).clip, STATE_MAP.failed.enter);
});

test("every habit loop is a contract clip that also appears in the prop-asset map (ticket 07)", () => {
  for (const [role, clip] of Object.entries(HABIT_LOOPS)) {
    assert.ok(CLIPS.includes(clip), `${role}'s habit "${clip}" is not a contract clip`);
    assert.ok(LOOPS.includes(clip), `${role}'s habit "${clip}" is not a contract loop`);
    assert.equal(PROP_ASSETS[role]?.clip, clip, `${role}'s prop-asset entry disagrees with HABIT_LOOPS`);
  }
});

test("a working Brain-type agent loops its own habit clip instead of the generic breathe", () => {
  const director = createCharacterDirector();
  for (const [role, clip] of Object.entries(HABIT_LOOPS)) {
    director.setAgentType("agent-1", role);
    director.setState("agent-1", "working", 0);
    const settled = director.tick("agent-1", 10);
    assert.equal(settled.clip, clip, role);
    assert.equal(settled.loop, true, role);
  }
});

test("a working agent with no habit (or an unmodeled type) still breathes", () => {
  const director = createCharacterDirector();
  director.setState("agent-1", "working", 0);
  assert.equal(director.tick("agent-1", 10).clip, "breathe");

  director.setAgentType("agent-2", "developer");
  director.setState("agent-2", "working", 0);
  assert.equal(director.tick("agent-2", 10).clip, "breathe");
});

test("setAgentType before the first setState still cross-fades normally on the first real state change", () => {
  const director = createCharacterDirector();
  director.setAgentType("agent-1", "orchestrator"); // no `now`; must not skew the agent's `since`
  director.setState("agent-1", "working", 100);
  const justChanged = director.tick("agent-1", 100);
  assert.equal(justChanged.crossFade, DUR_FAST);
});

test("a Brain-type agent's habit only applies to working; other states are unaffected", () => {
  const director = createCharacterDirector();
  director.setAgentType("agent-1", "orchestrator");
  director.setState("agent-1", "done", 0);
  assert.equal(director.tick("agent-1", 10).clip, STATE_MAP.done.loop);
});

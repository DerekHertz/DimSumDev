import { capsuleWeights, restTable, tailSway } from './character-profiles.mjs';

// team-and-den-ux/25-35 (slice 2a): rig profiles for crane, tortoise, pangolin, otter and deer on the shared
// rig. Rig space as in character-profiles.mjs (feet y=0, front +Z, character's left +X); anchors were read off
// orthographic front/side grids of the packed meshes (all five face +Z). Jiao, fox, lion, lucky-cat and
// golden-monkey have no profile yet, so CAST_PROFILES omits them and they keep the old panda body.
// Not in CHARACTER_PROFILES on purpose: character-rig.test.mjs iterates that table.

const limbs = (arm, leg) => Object.fromEntries(['L', 'R'].flatMap(s => [
  ['Shoulder_' + s, arm[0]], ['Elbow_' + s, arm[1]], ['Wrist_' + s, arm[2]], ['paw_' + s, arm[3]],
  ['Hip_' + s, leg[0]], ['Knee_' + s, leg[1]], ['Ankle_' + s, leg[2]], ['Toe_' + s, leg[3]],
]));
// Fused arms never move against the body, so their vertices follow the torso capsules (no arm/belly seam to tear).
const legs = leg => Object.fromEntries(['L', 'R'].flatMap(s => ['Hip_', 'Knee_', 'Ankle_', 'Toe_'].map((n, i) => [n + s, leg[i]])));
// A haunch on the grass stays put while the hips bob or settle, easing into the pelvis above it.
const planted = (y, height = .25) => y >= height ? 'Pelvis' : [['Root', 1 - y / height], ['Pelvis', y / height]].filter(([, w]) => w > 0);
// Legs and the haunch merge at the grass: diffuse weights across the seam, but keep the soles on their own bones.
const FUSED_SMOOTHING = Object.freeze({ iterations: 60, alpha: .5, pin: p => p.y < .03 });
// Sitting is a crouch: the hips lower and the knees bend over planted feet (a swung leg would tear the haunch).
const FUSED_ARMS = Object.freeze({ drop: 0, swing: Object.freeze({ L: 0, R: 0 }) });
const inBox = (p, [x0, x1], [y0, y1], [z0, z1]) => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1 && p.z > z0 && p.z < z1;
const ankleOf = rest => { const [, , [x, y, z]] = rest.find(([n]) => n === 'Ankle_L'); return { x, y, z }; };

const OTTER_REST = restTable({
  torso: [['Pelvis', [0, .62, .4]], ['Spine', [0, 1, .45]], ['Chest', [0, 1.4, .5]], ['Neck', [0, 1.85, .6]], ['Head', [0, 2.3, .7]]],
  head: { jaw: [0, 2, 1.3], hat: [0, 3, .7] }, ears: [.88, 2.5, .6],
  arm: [[.85, 1.5, .55], [1.2, 1.05, .7], [1.25, .85, 1], [1.2, .8, 1.25]],
  leg: [[.7, .65, .35], [.72, .38, .45], [.72, .12, .5], [.72, .05, .82]],
  tail: [[0, .45, -.35], [0, .55, -.85], [0, .75, -1.3], [0, .9, -1.7]],
});
export const OTTER = Object.freeze({
  id: 'river-otter', label: 'River otter QA', role: 'qa', height: 3, offset: [0, .4],
  foot: ankleOf(OTTER_REST), rest: OTTER_REST,
  weightsFor: capsuleWeights(OTTER_REST, {
    Pelvis: .9, Spine: .85, Chest: .8, Neck: .5, Head: .9, ...legs([.5, .45, .4, .32]),
    Tail1: .4, Tail2: .4, Tail3: .35, TailTip: .3,
  }, {
    softness: .1, sole: .05,
    // The cup rides the right paw and the checklist the left, as fused in the mesh.
    // The rump behind the thighs stays with the pelvis, so a sitting hip never drags the haunch.
    rigid: p => p.z < .12 && p.z > -.6 && p.y < .95 ? planted(p.y) : null,
  }),
  animate: tailSway(.16, .05),
  sit: { drop: .1, planted: true },
  // A shorter, lower step: its feet merge into the haunch behind them.
  gait: { stride: .4, lift: .07 },
  weightSmoothing: FUSED_SMOOTHING,
  heldProps: ['paw_L', 'paw_R'],
  // Both paws are fused to the belly and their props: they never swing (the user chose a head-and-body hello).
  arms: FUSED_ARMS, greeting: 'body',
  // Measured maxima over every pose (the tail sets the radius), plus 5%.
  envelope: { standing: { radius: 2.53, height: 3.28 }, moving: { radius: 2.55, height: 3.11 }, seated: { radius: 2.53, height: 3.05 }, head: { top: 3.28, radius: 1.2 } },
});

const DEER_REST = restTable({
  torso: [['Pelvis', [0, .5, -.05]], ['Spine', [0, .85, -.03]], ['Chest', [0, 1.15, 0]], ['Neck', [0, 1.45, .05]], ['Head', [0, 1.85, .1]]],
  head: { jaw: [0, 1.65, .6], hat: [0, 3.05, .1] }, ears: [.55, 2.3, 0],
  arm: [[.55, 1.3, 0], [.9, 1, .1], [.95, .85, .25], [.95, .75, .3]],
  leg: [[.33, .45, -.05], [.33, .28, -.05], [.33, .1, -.05], [.33, .05, .2]],
  tail: [[0, .45, -.35], [0, .45, -.55], [0, .45, -.7], [0, .45, -.8]],
});
export const DEER = Object.freeze({
  id: 'sika-deer', label: 'Deer designer', role: 'designer', height: 3, offset: [0, 0],
  foot: ankleOf(DEER_REST), rest: DEER_REST,
  weightsFor: capsuleWeights(DEER_REST, {
    Pelvis: .45, Spine: .5, Chest: .6, Neck: .4, Head: .8, ...legs([.28, .26, .26, .22]),
    Tail1: .15, Tail2: .12, Tail3: .1, TailTip: .08,
  }, {
    softness: .1, sole: .05,
    // Ears and antlers follow the head; the fan travels with the left paw and the brush with the right.
    rigid: p => p.y > 1.8 ? 'Head' : null,
  }),
  animate: tailSway(.1, .04),
  sit: { drop: .15, planted: true },
  weightSmoothing: FUSED_SMOOTHING,
  heldProps: ['paw_L', 'paw_R'],
  // Both paws are fused to the belly and their props: they never swing (the user chose a head-and-body hello).
  arms: FUSED_ARMS, greeting: 'body',
  // Measured maxima over every pose (ears and the fan set the radius, antlers the height), plus 5%.
  envelope: { standing: { radius: 1.46, height: 3.2 }, moving: { radius: 1.53, height: 3.11 }, seated: { radius: 1.44, height: 3 }, head: { top: 3.2, radius: 1.4 } },
});

const CRANE_REST = restTable({
  torso: [['Pelvis', [0, .85, -.6]], ['Spine', [0, 1.1, -.4]], ['Chest', [0, 1.4, -.15]], ['Neck', [0, 1.9, 0]], ['Head', [0, 2.6, .15]]],
  head: { jaw: [0, 2.5, .7], hat: [0, 3, .15] }, ears: [.2, 2.8, .1],
  arm: [[.7, 1.4, -.2], [.8, 1.1, -.2], [.85, .8, -.2], [.85, .6, -.2]],
  leg: [[.3, .85, -.15], [.3, .5, -.15], [.3, .15, -.2], [.3, .05, .3]],
  tail: [[0, .9, -.9], [0, .9, -1.3], [0, .85, -1.65], [0, .8, -1.95]],
});
export const CRANE = Object.freeze({
  id: 'red-crowned-crane', label: 'Crane architect', role: 'architect', height: 3, offset: [0, .3],
  foot: ankleOf(CRANE_REST), rest: CRANE_REST,
  weightsFor: capsuleWeights(CRANE_REST, {
    Pelvis: .6, Spine: .7, Chest: .65, Neck: .3, Head: .45, ...legs([.12, .1, .1, .1]),
    Tail1: .4, Tail2: .4, Tail3: .35, TailTip: .3,
  }, {
    softness: .1, sole: .05,
    // The beak, crown and scarf-top follow the head; the plan rides the chest.
    rigid: p => p.y > 2.4 ? 'Head' : null,
  }),
  animate: tailSway(.1, .04),
  sit: { drop: .25, planted: true },
  weightSmoothing: FUSED_SMOOTHING,
  heldProps: ['paw_L', 'paw_R'],
  arms: FUSED_ARMS, greeting: 'body',
  // Measured maxima over every pose (the tail sets the radius), plus 5%.
  envelope: { standing: { radius: 2.12, height: 3.17 }, moving: { radius: 2.15, height: 3.11 }, seated: { radius: 2.12, height: 2.89 }, head: { top: 3.17, radius: 1.1 } },
});

const TORTOISE_REST = restTable({
  torso: [['Pelvis', [0, .6, -.55]], ['Spine', [0, .9, .05]], ['Chest', [0, 1.1, .85]], ['Neck', [0, 1.7, 1.5]], ['Head', [0, 2.15, 1.75]]],
  head: { jaw: [0, 2, 2.15], hat: [0, 2.8, 1.4] }, ears: [.75, 2.5, 1.25],
  arm: [[.8, 1.2, .9], [.9, .9, 1], [.95, .7, 1.1], [.95, .5, 1.1]],
  leg: [[.8, .8, .9], [.85, .5, .95], [.85, .15, .95], [.85, .05, 1.3]],
  tail: [[0, .45, -1.2], [0, .4, -1.45], [0, .35, -1.65], [0, .3, -1.8]],
});
export const TORTOISE = Object.freeze({
  id: 'cloud-tortoise', label: 'Cloud tortoise SRE', role: 'sre', height: 3, offset: [0, -.25],
  foot: ankleOf(TORTOISE_REST), rest: TORTOISE_REST,
  weightsFor: capsuleWeights(TORTOISE_REST, {
    Pelvis: .9, Spine: 1, Chest: .9, Neck: .45, Head: .7, ...legs([.3, .25, .25, .22]),
  }, {
    softness: .1, sole: .05,
    rigid: p => {
      // The cloud curls and the face follow the head.
      if (p.y > 1.9 && p.z > .8) return 'Head';
      // The hind feet and plastron stay on the grass; the shell is one piece, riding the spine.
      if (p.z < .3 && p.y < .55) return planted(p.y);
      return p.z < 1.1 && p.y > .55 ? 'Spine' : null;
    },
  }),
  sit: { drop: .15, planted: true },
  weightSmoothing: FUSED_SMOOTHING,
  heldProps: ['paw_L', 'paw_R'],
  arms: FUSED_ARMS, greeting: 'body',
  // Measured maxima over every pose (the shell sets the radius), plus 5%.
  envelope: { standing: { radius: 2.8, height: 3.27 }, moving: { radius: 2.78, height: 3.09 }, seated: { radius: 2.76, height: 3 }, head: { top: 3.27, radius: 1.4 } },
});

const PANGOLIN_REST = restTable({
  torso: [['Pelvis', [0, .8, -.7]], ['Spine', [0, 1.3, -.45]], ['Chest', [0, 1.7, -.1]], ['Neck', [0, 2.1, .4]], ['Head', [0, 2.3, .8]]],
  head: { jaw: [0, 2, 1.3], hat: [0, 2.9, .5] }, ears: [.5, 2.6, .5],
  arm: [[.8, 1.5, .2], [.85, 1.2, .3], [.85, 1, .4], [.7, 1, .5]],
  leg: [[.45, .75, -.15], [.45, .45, -.15], [.45, .15, -.2], [.45, .05, .45]],
  tail: [[0, .7, -1], [0, .65, -1.4], [0, .6, -1.8], [0, .55, -2.1]],
});
export const PANGOLIN = Object.freeze({
  id: 'pangolin', label: 'Pangolin security', role: 'security', height: 3, offset: [0, .3],
  foot: ankleOf(PANGOLIN_REST), rest: PANGOLIN_REST,
  weightsFor: capsuleWeights(PANGOLIN_REST, {
    Pelvis: .65, Spine: .75, Chest: .75, Neck: .45, Head: .6, ...legs([.25, .22, .2, .2]),
    Tail1: .45, Tail2: .35, Tail3: .28, TailTip: .2,
  }, {
    softness: .1, sole: .05,
    // The belly behind the feet stays on the grass; the crown plates follow the head.
    rigid: p => p.y > 2.6 && p.z > .3 ? 'Head' : p.z < -.3 && p.z > -.9 && p.y < .4 ? planted(p.y) : null,
  }),
  animate: tailSway(.14, .05),
  sit: { drop: .25, planted: true },
  weightSmoothing: FUSED_SMOOTHING,
  heldProps: ['paw_L', 'paw_R'],
  arms: FUSED_ARMS, greeting: 'body',
  // Measured maxima over every pose (the tail sets the radius), plus 5%.
  envelope: { standing: { radius: 2.32, height: 3.24 }, moving: { radius: 2.36, height: 3.1 }, seated: { radius: 2.32, height: 2.89 }, head: { top: 3.24, radius: 1.2 } },
});

const FOX_REST = restTable({
  torso: [['Pelvis', [0, .65, -.35]], ['Spine', [0, 1, -.3]], ['Chest', [0, 1.4, -.2]], ['Neck', [0, 1.85, 0]], ['Head', [0, 2.35, .3]]],
  head: { jaw: [0, 2.1, .8], hat: [0, 3, .2] }, ears: [.6, 2.7, .2],
  arm: [[.6, 1.4, -.1], [.8, 1.1, -.1], [.85, .9, 0], [.85, .8, .1]],
  leg: [[.4, .5, -.2], [.4, .3, -.2], [.4, .1, -.25], [.4, .05, .25]],
  tail: [[-.4, .5, -.65], [-1.1, .8, -.85], [-1.6, 1.1, -.95], [-2, 1.5, -1]],
});
export const FOX = Object.freeze({
  id: 'fox', label: 'Fox product', role: 'product', height: 3, offset: [.5, .2],
  foot: ankleOf(FOX_REST), rest: FOX_REST,
  weightsFor: capsuleWeights(FOX_REST, {
    Pelvis: .75, Spine: .75, Chest: .7, Neck: .4, Head: .85, ...legs([.25, .22, .2, .18]),
    Tail1: .5, Tail2: .55, Tail3: .5, TailTip: .4,
  }, {
    softness: .1, sole: .05,
    // The ears follow the head.
    rigid: p => p.y > 2.6 ? 'Head' : null,
  }),
  animate: tailSway(.12, .05),
  sit: { drop: .08, planted: true },
  // A shorter, lower step: the feet merge into the robe hem above them.
  gait: { stride: .4, lift: .07 },
  weightSmoothing: FUSED_SMOOTHING,
  heldProps: ['paw_L', 'paw_R'],
  arms: FUSED_ARMS, greeting: 'body',
  // Measured maxima over every pose (the tail sets the radius), plus 5%.
  envelope: { standing: { radius: 2.57, height: 3.18 }, moving: { radius: 2.61, height: 3.12 }, seated: { radius: 2.57, height: 3.07 }, head: { top: 3.18, radius: 1.2 } },
});

const LION_REST = restTable({
  torso: [['Pelvis', [0, .55, -.2]], ['Spine', [0, .9, -.1]], ['Chest', [0, 1.25, 0]], ['Neck', [0, 1.6, .3]], ['Head', [0, 2.05, .4]]],
  head: { jaw: [0, 1.85, 1.1], hat: [0, 3, .4] }, ears: [.75, 2.55, .5],
  arm: [[.85, 1.3, .4], [1, .95, .6], [.7, .8, .9], [.5, .75, 1.05]],
  leg: [[.65, .6, -.3], [.7, .35, -.25], [.7, .12, -.2], [.7, .05, .25]],
  tail: [[-.5, .4, -.85], [-.7, .5, -1.05], [-.7, .7, -1.25], [-.7, .9, -1.4]],
});
export const LION = Object.freeze({
  id: 'lion', label: 'Lion code reviewer', role: 'code-reviewer', height: 3, offset: [0, .1],
  foot: ankleOf(LION_REST), rest: LION_REST,
  weightsFor: capsuleWeights(LION_REST, {
    Pelvis: .9, Spine: .9, Chest: .85, Neck: .6, Head: .95, ...legs([.55, .5, .45, .35]),
    Tail1: .3, Tail2: .3, Tail3: .3, TailTip: .25,
  }, {
    softness: .1, sole: .05,
    // The belly between the paws rests on the grass.
    rigid: p => p.y < .25 && Math.abs(p.x) < .45 && p.z > .3 ? planted(p.y) : null,
  }),
  animate: tailSway(.12, .04),
  sit: { drop: .12, planted: true },
  gait: { stride: .4, lift: .07 },
  weightSmoothing: FUSED_SMOOTHING,
  heldProps: ['paw_L', 'paw_R'],
  arms: FUSED_ARMS, greeting: 'body',
  envelope: { standing: { radius: 2.02, height: 3.23 }, moving: { radius: 1.98, height: 3.11 }, seated: { radius: 2.02, height: 3.04 }, head: { top: 3.23, radius: 1.3 } },
});

const LUCKY_CAT_REST = restTable({
  torso: [['Pelvis', [0, .5, 0]], ['Spine', [0, .9, 0]], ['Chest', [0, 1.3, .05]], ['Neck', [0, 1.7, .1]], ['Head', [0, 2.1, .05]]],
  head: { jaw: [0, 1.85, .8], hat: [0, 2.95, 0] }, ears: [.6, 2.6, -.1],
  arm: [[.8, 1.4, .1], [1.2, 1.8, .1], [1.4, 2, .1], [1.45, 2.05, .1]],
  leg: [[.55, .5, 0], [.55, .3, .05], [.55, .12, .1], [.55, .05, .5]],
  tail: [[-.8, .3, -.85], [-1.1, .55, -.9], [-1.4, .95, -.9], [-1.4, 1.3, -.9]],
});
export const LUCKY_CAT = Object.freeze({
  id: 'lucky-cat', label: 'Lucky cat release manager', role: 'release-manager', height: 3, offset: [0, 0],
  foot: ankleOf(LUCKY_CAT_REST), rest: LUCKY_CAT_REST,
  weightsFor: capsuleWeights(LUCKY_CAT_REST, {
    Pelvis: 1, Spine: 1, Chest: .95, Neck: .6, Head: .95, ...legs([.5, .45, .4, .35]),
    Tail1: .3, Tail2: .3, Tail3: .3, TailTip: .25,
  }, {
    softness: .1, sole: .05,
    // The seated cat rests on one round haunch: its whole underside stays on the grass.
    rigid: p => p.y < .3 ? planted(p.y) : null,
  }),
  animate: tailSway(.14, .05),
  sit: { drop: .2, planted: true },
  weightSmoothing: FUSED_SMOOTHING,
  heldProps: ['paw_L', 'paw_R'],
  // The raised paw stays raised: it is the cat's native beckon, and follows the torso.
  arms: FUSED_ARMS, greeting: 'body',
  envelope: { standing: { radius: 1.96, height: 3.23 }, moving: { radius: 2.03, height: 3.12 }, seated: { radius: 1.96, height: 2.95 }, head: { top: 3.23, radius: 1 } },
});

const MONKEY_REST = restTable({
  torso: [['Pelvis', [.05, .55, -.05]], ['Spine', [.1, .95, -.05]], ['Chest', [.15, 1.3, 0]], ['Neck', [.25, 1.75, 0]], ['Head', [.35, 2.3, 0]]],
  head: { jaw: [.35, 1.95, .65], hat: [.35, 2.95, 0] }, ears: [.9, 2.3, 0],
  arm: [[.6, 1.4, .1], [.8, 1.1, .3], [.85, .95, .5], [.85, .9, .55]],
  leg: [[.4, .5, -.05], [.4, .3, 0], [.4, .1, .05], [.4, .05, .45]],
  tail: [[-.5, .45, -.55], [-1.25, .8, -.5], [-1.65, 1.4, -.45], [-1.25, 1.75, -.45]],
});
export const GOLDEN_MONKEY = Object.freeze({
  id: 'golden-monkey', label: 'Golden monkey runner', role: 'runner', height: 3, offset: [.05, 0],
  foot: ankleOf(MONKEY_REST), rest: MONKEY_REST,
  weightsFor: capsuleWeights(MONKEY_REST, {
    Pelvis: .6, Spine: .6, Chest: .6, Neck: .4, Head: .85, ...legs([.4, .35, .32, .28]),
    Tail1: .2, Tail2: .2, Tail3: .2, TailTip: .18,
  }, { softness: .1, sole: .05 }),
  animate: tailSway(.2, .06),
  sit: { drop: .12, planted: true },
  gait: { stride: .4, lift: .07 },
  weightSmoothing: FUSED_SMOOTHING,
  heldProps: ['paw_L', 'paw_R'],
  // The scroll and satchel ride the torso: both paws are fused to the body and never swing.
  arms: FUSED_ARMS, greeting: 'body',
  envelope: { standing: { radius: 1.83, height: 3.17 }, moving: { radius: 1.88, height: 3.12 }, seated: { radius: 1.83, height: 3.03 }, head: { top: 3.17, radius: 1.1 } },
});

const JIAO_REST = restTable({
  torso: [['Pelvis', [0, .55, 0]], ['Spine', [0, .95, -.05]], ['Chest', [0, 1.35, 0]], ['Neck', [0, 1.8, .05]], ['Head', [0, 2.3, .05]]],
  head: { jaw: [0, 1.95, .75], hat: [0, 3, .05] }, ears: [.75, 2.8, -.1],
  arm: [[.8, 1.4, .1], [.95, 1.1, .3], [.7, .95, .55], [.55, .9, .6]],
  leg: [[.5, .5, 0], [.5, .3, .05], [.5, .1, .05], [.5, .05, .45]],
  tail: [[0, .45, -.6], [0, .45, -.75], [0, .45, -.85], [0, .45, -.9]],
});
// The codex orchestrator: a panda like Bao, but its own identity (dusty-blue wrap, own face), worn by runtime 'codex'.
export const JIAO = Object.freeze({
  id: 'jiao', label: 'Jiao orchestrator', role: 'orchestrator', runtime: 'codex', height: 3, offset: [0, 0],
  foot: ankleOf(JIAO_REST), rest: JIAO_REST,
  weightsFor: capsuleWeights(JIAO_REST, {
    Pelvis: .85, Spine: 1, Chest: 1, Neck: .6, Head: .95, ...legs([.45, .4, .35, .3]),
    Tail1: .1, Tail2: .1, Tail3: .1, TailTip: .1,
  }, { softness: .1, sole: .05 }),
  animate: tailSway(.1, .03),
  sit: { drop: .1, planted: true },
  gait: { stride: .4, lift: .07 },
  // Heavier smoothing than the others: the feet and the belly are one black-and-cream mass.
  weightSmoothing: Object.freeze({ ...FUSED_SMOOTHING, iterations: 120, pin: p => p.y < .015 }),
  heldProps: ['paw_L', 'paw_R'],
  // Both paws are fused to the wrap and never swing (the user chose a head-and-body hello).
  arms: FUSED_ARMS, greeting: 'body',
  envelope: { standing: { radius: 1.39, height: 3.2 }, moving: { radius: 1.45, height: 3.12 }, seated: { radius: 1.37, height: 3.06 }, head: { top: 3.2, radius: 1.2 } },
});

// A profile joins CAST_PROFILES (the factory selects it) once cast-rig.test.mjs passes for it.
// CAST_DRAFTS holds profiles still being fitted; run them with `CAST_DRAFTS=1 node --test cast-rig.test.mjs`.
export const CAST_DRAFTS = Object.freeze({});
export const CAST_PROFILES = Object.freeze({ otter: OTTER, deer: DEER, crane: CRANE, tortoise: TORTOISE, pangolin: PANGOLIN, fox: FOX, lion: LION, 'lucky-cat': LUCKY_CAT, 'golden-monkey': GOLDEN_MONKEY, jiao: JIAO });

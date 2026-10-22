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

// A profile joins CAST_PROFILES (the factory selects it) once cast-rig.test.mjs passes for it.
// CAST_DRAFTS holds profiles still being fitted; run them with `CAST_DRAFTS=1 node --test cast-rig.test.mjs`.
export const CAST_DRAFTS = Object.freeze({});
export const CAST_PROFILES = Object.freeze({ otter: OTTER, deer: DEER });

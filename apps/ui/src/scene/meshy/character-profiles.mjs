import * as T from 'three';

// team-and-den-ux/23: species profiles for the shared rig (createRig in panda-rig.mjs).
// Rig space: feet y=0, front +Z, the character's left at +X. Rest positions were read off
// orthographic grids of the packaged meshes (characters.* in the den manifest).

function restTable({ torso, head, ears, arm, leg, tail }) {
  const rest = [['Root', null, [0, 0, 0]]];
  let parent = 'Root';
  for (const [name, position] of torso) { rest.push([name, parent, position]); parent = name; }
  rest.push(['Jaw', 'Head', head.jaw], ['hat', 'Head', head.hat]);
  rest.push(['Ear_L', 'Head', ears], ['Ear_R', 'Head', [-ears[0], ears[1], ears[2]]]);
  const chain = (names, positions, root) => {
    for (const side of ['L', 'R']) {
      let up = root;
      names.forEach((name, i) => {
        const [x, y, z] = positions[i], bone = name + '_' + side;
        rest.push([bone, up, side === 'L' ? [x, y, z] : [-x, y, z]]); up = bone;
      });
    }
  };
  chain(['Shoulder', 'Elbow', 'Wrist', 'paw'], arm, 'Chest');
  chain(['Hip', 'Knee', 'Ankle', 'Toe'], leg, 'Pelvis');
  let up = 'Pelvis';
  tail.forEach((position, i) => { const name = i === tail.length - 1 ? 'TailTip' : 'Tail' + (i + 1); rest.push([name, up, position]); up = name; });
  return rest;
}

const segmentDistance = (p, a, b) => {
  const ab = b.clone().sub(a), t = ab.lengthSq() ? T.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1) : 0;
  return p.distanceTo(a.clone().addScaledVector(ab, t));
};

/**
 * Capsule skinning: each vertex belongs to its nearest capsule and blends only with that
 * bone's parent and children, so an arm never pulls the belly and a leg never pulls the tail.
 */
export function capsuleWeights(rest, radii, { softness = .07, rigid = () => null, sole = .14 } = {}) {
  const at = Object.fromEntries(rest.map(([name, , p]) => [name, new T.Vector3(...p)]));
  const parentOf = Object.fromEntries(rest.map(([name, parent]) => [name, parent]));
  const children = {}; for (const [name, parent] of rest) if (parent) (children[parent] ||= []).push(name);
  const capsules = Object.entries(radii).map(([bone, r]) => {
    const kids = (children[bone] || []).filter(k => radii[k] !== undefined || k === 'hat');
    const tip = bone === 'Head' ? at.hat : kids.length === 1 ? at[kids[0]] : at[bone];
    return { bone, a: at[bone], b: tip, r };
  });
  const p = new T.Vector3();
  return function weightsFor(position, headOnly = false) {
    if (headOnly) return [['Head', 1]];
    p.copy(position);
    const fixed = rigid(p); if (fixed) return [[fixed, 1]];
    const d = capsules.map(c => ({ bone: c.bone, d: segmentDistance(p, c.a, c.b) - c.r }));
    const best = d.reduce((m, c) => c.d < m.d ? c : m);
    // Soles belong wholly to their foot (as Bao's do), so a bending knee never pushes a heel through
    // the floor. Only vertices whose nearest capsule is a leg count: a tail resting beside a heel is not a sole.
    if (p.y < sole && /^(Hip|Knee|Ankle|Toe)_/.test(best.bone)) {
      const side = best.bone.slice(-1), ankle = at['Ankle_' + side], toe = at['Toe_' + side];
      const t = T.MathUtils.smoothstep(p.z, ankle.z, toe.z);
      return t > .999 ? [['Toe_' + side, 1]] : t < .001 ? [['Ankle_' + side, 1]] : [['Ankle_' + side, 1 - t], ['Toe_' + side, t]];
    }
    // A rear resting on the grass stays planted while the hips bob or settle: it blends toward the root.
    if (p.y < sole && (best.bone === 'Pelvis' || best.bone === 'Tail1')) {
      const planted = 1 - p.y / sole;
      return planted > .999 ? [['Root', 1]] : [['Root', planted], [best.bone, 1 - planted]];
    }
    const family = new Set([best.bone, parentOf[best.bone], ...(children[best.bone] || [])]);
    const near = d.filter(c => family.has(c.bone) && c.d - best.d < softness * 3).map(c => [c.bone, Math.exp(-(c.d - best.d) / softness)]);
    const top = near.sort((x, y) => y[1] - x[1]).slice(0, 4), total = top.reduce((n, [, w]) => n + w, 0);
    return top.map(([bone, w]) => [bone, w / total]);
  };
}

const tailSway = (amount, lift) => (bones, { kind, phase, breath = 0, reducedMotion, drop = 0 }) => {
  // Seated, the tail root keeps its standing height so the tail rests on the floor, not through it.
  if (kind === 'sit') bones.Tail1.position.y += drop;
  if (reducedMotion) return;
  const swing = kind === 'walk' ? Math.sin(phase) : Math.sin(phase * .5) * .6;
  // Walking, the tail lifts clear of the grass the hips bob toward.
  if (kind === 'walk') bones.Tail1.rotation.x = .15;
  ['Tail1', 'Tail2', 'Tail3'].forEach((name, i) => {
    bones[name].rotation.y = amount * swing * (i + 1) / 3;
    bones[name].rotation.z = lift * breath * (i + 1) / 3;
  });
};

const PANDA_REST = restTable({
  torso: [['Pelvis', [0, .72, 0]], ['Spine', [0, 1.12, 0]], ['Chest', [0, 1.5, 0]], ['Neck', [0, 1.78, .05]], ['Head', [0, 2.05, .1]]],
  head: { jaw: [0, 1.9, .6], hat: [0, 2.95, 0] }, ears: [.75, 2.75, 0],
  arm: [[.72, 1.48, 0], [1.05, 1.25, .05], [1.28, 1.06, .08], [1.38, .98, .1]],
  leg: [[.58, .55, 0], [.6, .32, .05], [.6, .1, .05], [.6, .06, .35]],
  tail: [[.35, .55, -.45], [.95, .75, -.9], [1.5, .9, -1.15], [2.0, .95, -1.2]],
});

const DRAGON_REST = restTable({
  torso: [['Pelvis', [0, .6, 0]], ['Spine', [0, .98, 0]], ['Chest', [0, 1.35, .05]], ['Neck', [0, 1.7, .1]], ['Head', [0, 1.95, .15]]],
  head: { jaw: [0, 1.85, .75], hat: [0, 2.75, 0] }, ears: [.6, 2.4, 0],
  arm: [[.5, 1.42, .15], [.68, 1.12, .35], [.6, .96, .6], [.55, .92, .7]],
  leg: [[.42, .48, 0], [.44, .3, .05], [.45, .1, 0], [.45, .06, .3]],
  tail: [[-.2, .45, -.45], [-.75, .6, -.95], [-1.25, .85, -1.3], [-1.65, 1.0, -1.55]],
});

const limbs = (arm, leg) => Object.fromEntries(['L', 'R'].flatMap(s => [
  ['Shoulder_' + s, arm[0]], ['Elbow_' + s, arm[1]], ['Wrist_' + s, arm[2]], ['paw_' + s, arm[3]],
  ['Hip_' + s, leg[0]], ['Knee_' + s, leg[1]], ['Ankle_' + s, leg[2]], ['Toe_' + s, leg[3]],
]));

// Conservative envelopes in rig units (multiply by the resident scale). Radius is the
// footprint around the root including tail and held props; heights include ears/antlers.
export const RED_PANDA = Object.freeze({
  id: 'red-panda', label: 'Red panda engineer', role: 'developer', height: 3, offset: [-.53, .55],
  foot: { x: .6, y: .1, z: .05 }, rest: PANDA_REST,
  weightsFor: capsuleWeights(PANDA_REST, {
    Pelvis: .85, Spine: .85, Chest: .75, Neck: .55, Head: .85, ...limbs([.25, .22, .22, .2], [.32, .3, .25, .2]),
    Tail1: .45, Tail2: .5, Tail3: .45, TailTip: .4,
  }, {
    // The tool pouch hangs from the belt: it rides the pelvis, never a leg.
    rigid: p => p.y > .3 && p.y < 1.05 && p.z > .7 && p.x < -.4 ? 'Pelvis' : null,
  }),
  animate: tailSway(.16, .05),
  // Seated on the grass at Bao's table (it has no stools): the rear stays planted and the legs come forward and out.
  // Swept for the deepest sit whose lowest point stays at the floor.
  sit: { drop: .15, hip: 1.3, knee: -.3, splay: .7 },
  heldProps: [],
  // A-pose arms: a smaller drop than Bao's tucks them toward the vest without crossing it.
  arms: { drop: .2 },
  // Measured maxima over rest, idle, waddle, sit and every leisure gesture (the tail sets the radius), plus 5%.
  envelope: { standing: { radius: 3.35, height: 3.2 }, moving: { radius: 3.45, height: 3.15 }, seated: { radius: 3.35, height: 3.1 }, head: { top: 3.2, radius: 1 } },
});

export const CLOUD_DRAGON = Object.freeze({
  id: 'cloud-dragon', label: 'Cloud dragon technical writer', role: 'technical-writer', height: 3.2, offset: [0, .4],
  foot: { x: .45, y: .1, z: 0 }, rest: DRAGON_REST,
  weightsFor: capsuleWeights(DRAGON_REST, {
    Pelvis: .7, Spine: .65, Chest: .55, Neck: .45, Head: .7, ...limbs([.2, .18, .18, .16], [.25, .23, .2, .16]),
    Tail1: .35, Tail2: .45, Tail3: .5, TailTip: .45,
  }, {
    rigid: p => {
      // Whiskers and antlers are thin; they follow the head as one piece.
      if (p.y > 1.5 && Math.abs(p.x) > .75 && p.z > -.2) return 'Head';
      if (p.y > 2.5) return 'Head';
      // The book is fused across the right paw and belly: it stays with the chest (the right arm does not gesture).
      if (p.x > -.62 && p.x < .15 && p.y > .55 && p.y < 1.3 && p.z > .2) return 'Chest';
      // The brush travels with the left paw.
      if (p.x > .38 && p.x < .8 && p.y > .55 && p.y < 1.85 && p.z > .45) return 'paw_L';
      return null;
    },
  }),
  animate: tailSway(.1, .04),
  sit: { drop: .15, hip: 1.3, knee: -.5, splay: .7 },
  // The book fills the right paw and the brush the left: no tea cup is added to either.
  heldProps: ['paw_L', 'paw_R'],
  // Both paws already hold props against the body: the right (book) arm stays still, the left only gestures.
  arms: { drop: 0, swing: { L: .35, R: 0 } },
  // Measured maxima as for the red panda, plus 5%: the antlers set the height, the whiskers the head radius.
  envelope: { standing: { radius: 2.45, height: 3.5 }, moving: { radius: 2.5, height: 3.35 }, seated: { radius: 2.45, height: 3.35 }, head: { top: 3.5, radius: 1.75 } },
});

export const CHARACTER_PROFILES = Object.freeze({ developer: RED_PANDA, 'technical-writer': CLOUD_DRAGON });

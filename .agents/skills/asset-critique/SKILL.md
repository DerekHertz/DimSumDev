---
name: asset-critique
description: Visual critique of a rigged 3D character asset (glb), covering proportions, silhouette, colour reading, deformation and pose goals, with measured numbers and ranked fixes. Use when the user asks to critique or review how a model or character looks, or before an asset ticket goes to the user for a visual verdict.
---

# Asset critique

A critique is a **round**: look, measure, judge, diagnose, report. Every finding carries a number, or names the clip and view where it shows. The developer applies the fixes and re-exports, and the next round compares before and now. Rounds end when the user accepts the asset.

## 1. Look

Open the asset's viewer in a browser (the Browser pane or Claude in Chrome). For the panda this is `apps/ui/assets-src/panda/viewer.html`, and its `README.md` says how to serve it. Screenshot the rest pose and every clip that raises, crosses or folds a limb, plus any clip the ticket names. Take each from the front and both three-quarter views, and add the side view for anything front-to-back.

Done when every such clip has been seen from the front and both three-quarters.

## 2. Measure

```bash
node .claude/skills/asset-critique/scripts/measure-glb.mjs <path/to/asset.glb>
```

This prints rest-pose numbers per bone, in glTF space with +Y up:
- **length**: the extent along the bone.
- **thickness**: a robust diameter.
- **taper**: thickness in five slices from head to tail.
- **reach**: the largest |x|, to compare with the body's.

From round 2 on, also measure the previous version so before and now sit side by side:

```bash
git show <previous-sha>:<glb path> > <scratch>/previous.glb
```

For a pose goal, such as whether both paws can meet at the belly, compare the limb's length plus its end radius with the distance from its joint to the target. Take both from the numbers; don't eyeball them.

## 3. Judge: the readings

Give every reading a verdict, either *fine* or a finding.

- **Visible mass.** Weigh a limb by how much of it shows, next to the body and head it sits beside. Short, mostly buried legs are the wrong yardstick for long, fully visible arms: at equal thickness the arms read about twice as heavy.
- **Taper.** A limb narrows to the wrist and swells into the paw. Equal thickness end to end reads as a **log**, and adding taper fixes a log better than any change in overall size.
- **Silhouette.** In the front view at rest, each limb's reach stays inside the body's, so the outline is one rounded shape. The resting limb stays tucked while the other one moves.
- **Colour reading.** Each limb has contrast behind it. A black limb over a black flank, or merged with a black marking, becomes a **blob**: one dark shape where there should be limbs.
- **Deformation.** Where a limb meets the body, the surface stays smooth: no stretched or torn skin, pinches, dents or creases. Look hardest in the three-quarter views, where the arm, belly and leg meet.
- **Pose goals.** Each clip's intent physically works. Contacts meet and overlap cleanly, one part resting on the other, not pushing into it. When the reach is shorter than the distance, the limb has to change, because no animation fix closes that gap.
- **Style proportions** (cute or plush). The head is at least as wide as the body, and front and back limbs match by visible mass. Markings, like a panda's shoulder band, tie the limbs into the body while each limb keeps its own outline.
- **Stray geometry.** Look for loose discs, seams and leftover pieces.

## 4. Diagnose

Find each finding's cause in the build scripts. For the panda they are in `apps/ui/assets-src/panda/`, and the README's step table says which script does what. The usual sources are:
- the source mesh itself (for example, Meshy dents)
- a smoothing mask's reach
- vertex colours
- skin weights
- a clip's aim target

Mark a cause **confirmed** when the code shows it, and **guess** otherwise. If you have no repo access, ask for the build script's path.

## 5. Report

1. A one-line verdict.
2. A table of the numbers the findings cite, with columns for before, now, and a reference part (for example, the legs).
3. Findings, most important first. Each gives what is wrong, where (clip and view), its number, and its cause (confirmed or guess).
4. Fixes in the order to apply them. Each gives a target number or range and the finding it fixes. Name the changes that worked so the next round keeps them. If an earlier round's target caused a problem, say so and give the corrected target.
5. **Check first**: the one pose that proves the proportions (for example, "arms_folded: the paws overlap").

Done when every reading has a verdict and every fix has a target number.

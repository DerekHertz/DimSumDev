// The one place the camera's goal lives (den-scene-v1/07): the zoom factor and the look-at target. The rig
// (CameraRig.jsx) eases the camera toward it; the wheel, pinch, + and - keys, the zoom buttons, the level
// switcher and the team pills all write here, so they can never disagree. Pure: no React, no three.
// Zoom is the dolly factor of iso-projection.mjs (smaller is closer), always held inside [ZOOM_MIN, ZOOM_MAX].
import { STALL_CENTERS } from "./banquet-layout.mjs";
import { TARGET } from "./iso-projection.mjs";

/** Dolly factor of each zoom level. Level 4 (Workspace) has no destination yet. */
export const LEVEL_ZOOM = { 1: 1, 2: 0.75, 3: 0.55 };

const round = (v) => Math.round(v * 1000) / 1000; // 1 - 0.1 + 0.1 must read 1, not 1.0000000000000002
const sameTarget = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** The level whose dolly factor is nearest the zoom; Level 1 for anything farther out. */
export function levelOfZoom(zoom,levels=LEVEL_ZOOM) {
  let best = 1;
  for (const [level, z] of Object.entries(levels)) {
    if (Math.abs(z - zoom) < Math.abs(levels[best] - zoom)) best = Number(level);
  }
  return best;
}

export function createCameraStore({minZoom=.55,levels=LEVEL_ZOOM}={}) {
  const clamp=z=>Math.max(minZoom,Math.min(1.2,z));
  let zoom = 1;
  let target = [...TARGET];
  const subs = new Set();
  const emit = () => subs.forEach((fn) => fn());
  const store = {
    levels,
    getZoom: () => zoom,
    getTarget: () => target,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    setZoom(z) {
      const next = round(clamp(z));
      if (next === zoom) return;
      zoom = next;
      emit();
    },
    setTarget(t) {
      if (sameTarget(t, target)) return;
      target = [...t];
      emit();
    },
    /** One + or - step, the same one the keyboard takes. */
    stepZoom(key) {
      store.setZoom(['+','='].includes(key)?zoom-.1:['-','_'].includes(key)?zoom+.1:zoom);
    },
    /** Level 1 is the default framing (target reset too); levels 2 and 3 dolly in where the camera already looks. */
    goToLevel(level) {
      if (!(level in levels)) return;
      store.setZoom(levels[level]);
      if (level === 1) store.setTarget(TARGET);
    },
    /** Level 2 on a team: the look-at moves to its kiosk (the rig pulls it inside the pan limits). */
    goToTeam(id) {
      const c = STALL_CENTERS[id];
      store.setZoom(levels[2]);
      store.setTarget(c ? [c.x, 0, c.z] : TARGET);
    },
  };
  return store;
}

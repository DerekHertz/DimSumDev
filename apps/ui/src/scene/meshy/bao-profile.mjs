import { BAO_PROFILE } from './panda-rig.mjs';

// Same broad Balanced Bao anatomy and named rig, with the simplified jade wrap.
// This profile belongs only to Bao (Claude orchestrator); Jiao keeps its own appearance.
export const BAO_PRODUCTION = Object.freeze({
  ...BAO_PROFILE, id: 'giant-panda', label: 'Bao · jade sash',
  sit: { drop: .12, hip: 1.3, knee: -.3, splay: .7 },
  envelope: {
    standing: { radius: 1.9, height: 3.2 }, moving: { radius: 1.95, height: 3.2 },
    seated: { radius: 1.9, height: 3.1 }, head: { top: 3.2, labelTop: 3, radius: 1.6 },
  },
});

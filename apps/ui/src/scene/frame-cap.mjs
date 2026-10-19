// The den's frame cap (2026-10-19): at the display's own rate (60-144 Hz) the garden kept the user's GPU at full tilt and froze
// the tab. The Canvas runs frameloop="demand"; this asks for a frame no more often than `fps`, on the browser's own clock.
import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

export const MAX_FPS = 30;

/** Whether a frame is due at `now` (ms), given the last one drawn at `last`; 1 ms of slack absorbs rAF jitter. */
export function frameDue(now, last, fps = MAX_FPS) {
  return now - last >= 1000 / fps - 1;
}

export function FrameCap({ fps = MAX_FPS }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let raf = 0, last = -Infinity;
    const tick = (now) => { if (frameDue(now, last, fps)) { last = now; invalidate(); } raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [invalidate, fps]);
  return null;
}

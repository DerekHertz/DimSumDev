import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

export const DEFAULT_FPS = 30;
export const FPS_OPTIONS = [30, 60, 120];

export function createFramePreference(storage) {
  let fps = DEFAULT_FPS;
  try { const saved = Number(storage?.getItem('den.fps')); if (FPS_OPTIONS.includes(saved)) fps = saved; } catch {}
  return { get fps() { return fps; }, set(value) {
    if (!FPS_OPTIONS.includes(value)) return;
    fps = value;
    try { storage?.setItem('den.fps', String(value)); } catch {}
  } };
}

/** Whether a frame is due at `now` (ms), given the last one drawn at `last`; 1 ms of slack absorbs rAF jitter. */
export function frameDue(now, last, fps = DEFAULT_FPS) {
  return now - last >= 1000 / fps - 1;
}

export function createFrameSchedule(fps = DEFAULT_FPS) {
  let last = -Infinity;
  const interval = 1000 / fps;
  return (now) => {
    if (!frameDue(now, last, fps)) return false;
    // Advance by whole intervals so 60 FPS does not drift down to 48 on a 144 Hz display.
    last = Number.isFinite(last) ? last + Math.max(1, Math.floor((now - last + 1) / interval)) * interval : now;
    return true;
  };
}

export function FrameCap({ fps = DEFAULT_FPS }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let raf = 0;
    const due = createFrameSchedule(fps);
    const tick = (now) => { if (due(now)) invalidate(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [invalidate, fps]);
  return null;
}

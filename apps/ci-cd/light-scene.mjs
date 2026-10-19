// organism-infra/94: make the Den scene cheap in headless browser tests, without touching the app.
//
// Cause (measured, see handoffs/94-developer.md): headless Chromium has no GPU, so WebGL runs on SwiftShader, a CPU
// rasteriser. The scene is about 230 draw calls per frame and a frame costs 100-200 ms of main-thread time even at a
// 640x400 viewport, so the render loop pins the page at about 5 fps. On the 2-core CI runner that starves Playwright
// (a button click took about 4.5 s to land on 2 pinned cores, and 8-10 s with other work running: the click timeouts
// are 8-10 s), and every test boots its own page, so the file takes 15-50 s per test.
//
// Two levers, both applied through a page init script, so nothing in the app changes:
//  - skipDraws: draw calls become no-ops. The scene graph, React tree, raycasting (CPU) and every DOM node the tests
//    read are unchanged; only the pixels are never rasterised. Tests that need pixels or a real render (smoke --url,
//    team-hues-live) do not use this helper.
//  - frameDelayMs: each requestAnimationFrame callback is held back this long, so the render loop's JS leaves the
//    main thread idle between frames. The delay lives in the page's own world; Playwright's actionability checks run
//    in its utility world and are not slowed by it.

export const LIGHT_SCENE_DEFAULTS = { skipDraws: true, frameDelayMs: 100 };

// Runs inside the page (serialised by Playwright), so it must not close over anything.
export function installLightScene({ skipDraws, frameDelayMs }) {
  if (skipDraws) {
    for (const name of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
      const proto = window[name]?.prototype;
      if (!proto) continue;
      for (const call of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]) {
        if (typeof proto[call] === "function") proto[call] = function skippedDraw() {};
      }
    }
  }
  if (frameDelayMs > 0) {
    const raf = window.requestAnimationFrame.bind(window);
    const caf = window.cancelAnimationFrame.bind(window);
    const pending = new Map();
    let next = 1;
    window.requestAnimationFrame = (callback) => {
      const id = next++;
      const entry = { timer: undefined, handle: undefined };
      entry.timer = setTimeout(() => {
        entry.handle = raf((time) => {
          pending.delete(id);
          callback(time);
        });
      }, frameDelayMs);
      pending.set(id, entry);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (entry.handle !== undefined) caf(entry.handle);
    };
  }
}

/** Lighten the scene for every page of `target` (a Playwright BrowserContext or Page). Call before the first goto. */
export async function lightenScene(target, options = {}) {
  await target.addInitScript(installLightScene, { ...LIGHT_SCENE_DEFAULTS, ...options });
}

// Offline authoring (team-and-den-ux/35): renders the nine cast roles and Jiao with the live rig, the way Bao's
// portrait was made, and writes public/den/portraits/<role>-<species>.webp at or under 40 KiB.
// Usage: node apps/ui/assets-src/den/render-cast-portraits.mjs   (needs a WebGL Chromium, as grove-review does)
import {writeFileSync} from 'node:fs';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../ci-cd/launch-options.mjs';
import {CAST, castCharacterId} from '../../src/scene/meshy/cast.mjs';

const CAP = 40 * 1024, OUT = new URL('../../public/den/portraits/', import.meta.url);
// Every cast role renders once (the runtimes share a species); the orchestrator adds Jiao on the codex runtime.
const jobs = Object.keys(CAST).flatMap(role => role === 'orchestrator'
  ? [{ role, runtime: 'codex' }] : [{ role, runtime: 'claude' }]);

const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(buildLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  page.on('pageerror', e => console.error('pageerror', e.message));
  await page.goto(server.resolvedUrls.local[0] + 'grove-review.html');
  await page.waitForFunction(() => window.groveReview?.ready, {}, { timeout: 60000 });
  for (const { role, runtime } of jobs) {
    let wrote = null;
    for (const quality of [.92, .85, .78, .7, .6, .5]) {
      const data = await page.evaluate(async ({ role, runtime, quality }) => {
        const { renderRolePortraits } = await import('/assets-src/den/render-role-portraits.mjs');
        let out = null; await renderRolePortraits((id, url) => { out = url; }, { runtime, roles: [role], quality }); return out;
      }, { role, runtime, quality });
      const bytes = Buffer.from(data.split(',')[1], 'base64');
      if (bytes.length <= CAP) { wrote = { quality, bytes }; break; }
    }
    if (!wrote) throw Error(role + ' portrait exceeds 40 KiB even at quality .5');
    const name = role + '-' + castCharacterId(role, runtime) + '.webp';
    writeFileSync(new URL(name, OUT), wrote.bytes);
    console.log(name, wrote.bytes.length, 'q' + wrote.quality);
  }
} finally { await browser?.close(); await server.close(); }

// Offline evidence (team-and-den-ux/35): renders the labelled cast sheets with the live rig into docs/design/team-and-den-ux/cast-35/.
// Usage: node apps/ui/assets-src/den/render-cast-review.mjs   (needs a WebGL Chromium, as render-cast-portraits does)
import {mkdirSync, writeFileSync} from 'node:fs';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../ci-cd/launch-options.mjs';

const OUT = new URL('../../../../docs/design/team-and-den-ux/cast-35/', import.meta.url), CAP = 1.5 * 1024 * 1024;
mkdirSync(OUT, { recursive: true });
const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(buildLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', e => console.error('pageerror', e.message));
  page.on('console', m => m.type() === 'error' && console.error('console', m.text()));
  await page.goto(server.resolvedUrls.local[0] + 'assets-src/den/cast-review.html');
  await page.waitForFunction(() => window.ready, {}, { timeout: 90000 });
  const only = process.env.ONLY?.split(','); // e.g. ONLY=lineup,bao-and-jiao re-renders just those
  const save = async (name, draw, arg) => {
    if (only && !only.some(o => name.includes(o))) return;
    await page.evaluate(draw, arg);
    const bytes = Buffer.from((await page.evaluate(() => review.png())).split(',')[1], 'base64');
    if (bytes.length > CAP) throw Error(name + ' is ' + bytes.length + ' bytes, over the 1.5 MB cap');
    writeFileSync(new URL(name, OUT), bytes); console.log(name, bytes.length);
  };
  const characters = await page.evaluate(() => review.characters);
  for (const [id, role, runtime] of characters) await save(`species-${id}.png`, ([i, r, rt]) => review.species(i, r, rt), [id, role, runtime]);
  await save('reduced-motion.png', () => review.reduced());
  await save('bao-and-jiao.png', () => review.baoJiao());
  await save('lineup-near.png', () => review.lineup(false)); await save('lineup-far.png', () => review.lineup(true));
} finally { await browser?.close(); await server.close(); }

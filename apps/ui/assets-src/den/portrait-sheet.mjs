// Offline evidence (team-and-den-ux/35): the cast portraits at the 512 source, 72px and 48px as the Team rail crops them
// (round, object-fit cover, 2px accent border). Usage: node portrait-sheet.mjs <out.png>
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../ci-cd/launch-options.mjs';

const dir = new URL('../../public/den/portraits/', import.meta.url);
const files = ['bao-jade', 'orchestrator-jiao', 'product-fox', 'architect-crane', 'designer-deer', 'code-reviewer-lion', 'qa-otter', 'security-pangolin', 'release-manager-lucky-cat', 'sre-tortoise', 'runner-golden-monkey'];
const uri = f => 'data:image/webp;base64,' + readFileSync(new URL(f + '.webp', dir)).toString('base64');
const circle = (f, px) => `<span style="display:inline-block;width:${px}px;height:${px}px;border-radius:50%;overflow:hidden;border:2px solid #597047;background:#e0eadb;box-sizing:content-box;flex:none"><img src="${uri(f)}" style="width:100%;height:100%;object-fit:cover"></span>`;
const row = f => `<div style="display:flex;align-items:center;gap:14px;padding:6px 10px"><img src="${uri(f)}" width="128" height="128">${circle(f, 72)}${circle(f, 48)}<code style="font:12px monospace">${f}</code></div>`;
const html = `<body style="margin:0;background:#f7f1e3;font-family:sans-serif"><div style="display:grid;grid-template-columns:1fr 1fr">${files.map(row).join('')}</div>`;
const browser = await chromium.launch(buildLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.setContent(html);
  await page.screenshot({ path: process.argv[2], fullPage: true });
} finally { await browser.close(); }

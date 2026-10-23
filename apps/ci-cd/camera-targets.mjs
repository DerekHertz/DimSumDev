import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {buildLaunchOptions} from './launch-options.mjs';

// Isolated production CSS/control ancestry check; no scene, service or final visual verdict.
const source=new URL('../ui/src/',import.meta.url);
const app=readFileSync(new URL('App.jsx',source),'utf8'),bottom=readFileSync(new URL('overlay/Bottom.jsx',source),'utf8');
assert.match(app,/className="den-camera-controls"[\s\S]*?<ZoomSwitcher/);
const labels=[...bottom.matchAll(/level: \d, label: "([^"]+)"/g)].map(m=>m[1]);assert.equal(labels.length,4);
const css=['styles.css','shell/forest.css'].map(file=>readFileSync(new URL(file,source),'utf8')).join('\n');
const browser=await chromium.launch(buildLaunchOptions());
const failures=[];
try{
 for(const [name,width,hasTouch]of [['desktop-fine',1440,false],['desktop-coarse',1440,true],['phone-coarse',390,true]]){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch});
  await page.setContent('<style>'+css+'</style><div class="shell forest-shell den-shell"><header class="den-bar"></header><div class="den-stage"><div class="den-camera-controls"><nav class="zoom-switcher"><div class="zoom-levels">'+labels.map(label=>'<button class="zoom-level">'+label+'</button>').join('')+'</div><div class="zoom-steps"><button class="zoom-step">+</button><button class="zoom-step">−</button></div></nav><div class="den-roof-controls"><button class="btn">Full roofs</button><button class="btn">Cutaway</button></div></div></div></div>');
  assert.equal(await page.evaluate(()=>matchMedia('(pointer:coarse)').matches),hasTouch);
  const targets=await page.locator('.den-camera-controls button:visible').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
  console.log(JSON.stringify({name,targets}));
  assert.equal(targets.length,width===390?4:8,'all visible camera controls are covered');
  for(const t of targets)if(t.width<44||t.height<44)failures.push(name+': '+t.text+' '+t.width+'x'+t.height);
  await page.close();
 }
}finally{await browser.close();}
assert.deepEqual(failures,[],'native camera targets must be at least 44x44 CSS pixels');

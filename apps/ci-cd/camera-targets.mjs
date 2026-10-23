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
const failures=[];
const talk=app.match(/<button type="button" className="([^"]*den-bar-talk[^"]*)"/)?.[1];
const roof=app.match(/key=\{mode\} type="button" className="([^"]+)"/)?.[1];
assert.ok(talk&&roof,'fixture uses the production button classes');
const browser=await chromium.launch(buildLaunchOptions());
try{
 for(const [name,width,hasTouch,colorScheme]of [['desktop-fine',1440,false,'light'],['desktop-dark',1440,false,'dark'],['desktop-coarse',1440,true,'light'],['phone-coarse',390,true,'light']]){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch,colorScheme});
  await page.setContent('<style>'+css+'</style><div class="shell forest-shell den-shell"><header class="den-bar"><div class="logo-pill">Dim Sum Dev</div><button class="'+talk+'">Talk to Bao</button></header><div class="den-stage"><div class="den-camera-controls"><nav class="zoom-switcher"><div class="zoom-levels">'+labels.map(label=>'<button class="zoom-level">'+label+'</button>').join('')+'</div><div class="zoom-steps"><button class="zoom-step">+</button><button class="zoom-step">−</button></div></nav><div class="den-roof-controls"><button class="'+roof+'" aria-pressed="true">Full roofs</button><button class="'+roof+'" aria-pressed="false">Cutaway</button></div></div><aside class="den-sheet"><header class="den-sheet-head">Readable panel</header></aside></div></div>');
  assert.equal(await page.evaluate(()=>matchMedia('(pointer:coarse)').matches),hasTouch);
  const targets=await page.locator('.den-camera-controls button:visible').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
  console.log(JSON.stringify({name,targets}));
  assert.equal(targets.length,width===390?4:8,'all visible camera controls are covered');
  for(const t of targets)if(t.width<44||t.height<44)failures.push(name+': '+t.text+' '+t.width+'x'+t.height);
  const material=await page.evaluate(()=>{
    const css=selector=>getComputedStyle(document.querySelector(selector)),talk=css('.den-bar-talk'),bar=css('.den-bar'),roof=css('.den-roof-controls button'),sheet=css('.den-sheet'),head=css('.den-sheet-head');
    const context=document.createElement('canvas').getContext('2d');
    const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data];};
    const luminance=color=>rgba(color).slice(0,3).map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    const unselected=css('.den-roof-controls button[aria-pressed="false"]');
    const bg=rgba(sheet.backgroundColor),alpha=bg[3]/255;
    const textContrast=Math.min(...[0,255].flatMap(outside=>['--ink','--ink-muted','--ink-faint'].map(token=>contrast(sheet.getPropertyValue(token),'rgb('+bg.slice(0,3).map(v=>v*alpha+outside*(1-alpha)).join(',')+')'))));
    return {talkWidth:parseFloat(talk.width),talkHeight:parseFloat(talk.height),barHeight:parseFloat(bar.height),roofFont:roof.fontFamily,talkFont:talk.fontFamily,selectedContrast:contrast(roof.color,roof.backgroundColor),unselectedContrast:contrast(unselected.color,sheet.getPropertyValue('--surface-200')),textContrast,unselectedBorder:unselected.borderStyle,blur:sheet.backdropFilter,alpha:bg[3],nestedBlur:head.backdropFilter};
  });
  if(material.talkWidth>150||material.talkHeight!==44||material.barHeight!==44)failures.push(name+': Talk must be content-sized inside44px bar '+JSON.stringify(material));
  if(material.roofFont!==material.talkFont||material.selectedContrast<4.5||material.unselectedContrast<4.5||material.unselectedBorder!=='solid')failures.push(name+': roof typography/contrast '+JSON.stringify(material));
  if(material.textContrast<4.5)failures.push(name+': exterior text must remain readable over light and dark scene backgrounds '+material.textContrast);
  if(!material.blur.includes('blur(12px)')||material.alpha<210||material.alpha>220||material.nestedBlur!=='none')failures.push(name+': bounded exterior glass '+JSON.stringify(material));
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  const opaque=await page.locator('.den-sheet').evaluate(el=>({background:getComputedStyle(el).backgroundColor,blur:getComputedStyle(el).backdropFilter}));
  if(opaque.background.startsWith('rgba(')||opaque.blur!=='none')failures.push(name+': reduced transparency must be opaque');
  await page.emulateMedia({forcedColors:'active'});
  assert.equal(await page.locator('.den-sheet').evaluate(el=>getComputedStyle(el).backdropFilter),'none','forced colors must disable blur');
  await page.emulateMedia({forcedColors:'none'});
  await cdp.send('Emulation.setEmulatedMedia',{features:[]});
  const unsupported=await page.evaluate(()=>{
    for(const sheet of document.styleSheets)for(let i=sheet.cssRules.length-1;i>=0;i--)if(sheet.cssRules[i].type===CSSRule.SUPPORTS_RULE)sheet.deleteRule(i);
    const style=getComputedStyle(document.querySelector('.den-sheet'));return {blur:style.backdropFilter,background:style.backgroundColor};
  });
  assert.equal(unsupported.blur,'none','without support the exterior surface does not blur');
  assert.ok(!unsupported.background.startsWith('rgba('),'without support the exterior surface stays opaque');
  await page.close();
 }
}finally{await browser.close();}
assert.deepEqual(failures,[],'native controls and panel materials must satisfy preview accessibility criteria');

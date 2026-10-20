// Run with native Windows Node. Authoring pose renders, not runtime chair fitting.
const fs=require('node:fs');
const {chromium}=require('C:/Users/Derek/AppData/Local/Temp/den-cast-23/22-runtime/node_modules/playwright');
(async()=>{
 const output=process.argv[2]||__dirname;fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const results={kind:'selected-A textured authoring poses; no runtime chair or performance claim',commit:process.argv[3]||'portrait preparation; uncommitted',errors:[],captures:[]};
 try{
  const page=await browser.newPage({viewport:{width:1024,height:768}});page.on('pageerror',e=>results.errors.push(e.message));
  await page.goto('http://127.0.0.1:4426/assets-src/den/bao-review.html');await page.waitForFunction(()=>globalThis.ready,null,{timeout:60000});
  for(const theme of ['light','dark'])for(const pose of ['idle','work','sit','walk','greeting']){
   await page.evaluate(({pose,theme})=>{review.theme(theme);review.pose(pose,.4);},{pose,theme});
   const file=theme+'-'+pose+'.png';await page.screenshot({path:output+'/'+file});results.captures.push(file);
  }
  await page.evaluate(()=>{review.theme('light');review.pose('idle',0);review.camera.position.set(7,1.8,0);review.camera.lookAt(0,1.5,0);review.renderer.render(review.scene,review.camera);});
  await page.screenshot({path:output+'/side-idle.png'});
  const portrait=await page.evaluate(()=>review.portrait());fs.writeFileSync(output+'/bao-jade.webp',Buffer.from(portrait.split(',')[1],'base64'));
  results.resources=await page.evaluate(()=>{
   const {panda}=review;let triangles=0,shadowTriangles=0,geometryBytes=0;const textures=new Set();
   panda.model.traverse(m=>{if(!m.isMesh)return;const n=(m.geometry.index?.count??m.geometry.attributes.position.count)/3;triangles+=n;if(m.castShadow)shadowTriangles+=n;geometryBytes+=(m.geometry.index?.array.byteLength||0)+Object.values(m.geometry.attributes).reduce((n,a)=>n+a.array.byteLength,0);for(const material of Array.isArray(m.material)?m.material:[m.material])if(material.map)textures.add(material.map);});
   return {triangles,shadowTriangles,geometryBytes,bones:panda.rig.skeleton.bones.length,textures:[...textures].map(t=>({width:t.image.width,height:t.image.height,mips:t.generateMipmaps})),calls:review.renderer.info.render.calls};
  });
  if(results.errors.length)throw Error(JSON.stringify(results.errors));console.log(JSON.stringify(results));
 }finally{await browser.close();fs.writeFileSync(output+'/authoring-results.json',JSON.stringify(results,null,2));}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

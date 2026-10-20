// Generate an A/A diagnostic from the unchanged acceptance collector.
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function controlSource(original){
 let source=original;
 const replace=(before,after)=>{assert.equal(source.split(before).length,2,'expected one '+before);source=source.replace(before,after);};
 replace("const cases=[['idle-light',false,false,false,false,'light'],['idle-dark',false,false,false,false,'dark'],['crowded-light',true,false,false,false,'light'],['crowded-dark',true,false,false,false,'dark'],['meeting-light',true,true,false,false,'light'],['meeting-dark',true,true,false,false,'dark'],['walk-light',true,false,true,false,'light'],['walk-dark',true,false,true,false,'dark'],['reduced-light',true,true,false,true,'light'],['reduced-dark',true,true,false,true,'dark']];", "const cases=[['meeting-light',true,true,false,false,'light']];");
 replace('bound=preflight?300000:resume?1200000:3000000','bound=420000');
 replace("preflight?'Metadata/layout/hardware preflight; NOT acceptance performance':'Full approved acceptance recipe'","'Original/original control ONLY; never acceptance or replacement samples'");
 replace("recipe:'10 scenarios x 3 repetitions x 10s warmup + 30s sample x original-shipped Bao / selected A; one Chrome, interleaved pairs with alternating order'","recipe:'meeting-light x 3 original/original pairs x 10s warmup + 30s sample; label order AB/BA/AB'");
 replace('power.draw,temperature.gpu','power.draw,temperature.gpu,utilization.gpu,utilization.memory');
 replace("if(p==='/den/manifest.json'&&baseline){","if(p==='/den/manifest.json'){");
 replace("delete m.assets['characters.bao'];return route.fulfill", "delete m.assets['characters.bao'];identity.manifestHasBao=Object.hasOwn(m.assets,'characters.bao');return route.fulfill");
 replace("if(p==='/den/portraits/bao-jade.webp'&&baseline){","if(p==='/den/portraits/bao-jade.webp'){");
 replace('await page.route(\'**/*\',async route=>{',"const identity={manifestHasBao:null,requests:[]};page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/den/'))identity.requests.push(p);});\n   await page.route('**/*',async route=>{");
 replace('Object.assign(item,{name,rep,baseline,theme,','Object.assign(item,{identity,name,rep,baseline,theme,');
 replace("assert.equal(item.baoSpecies,baseline?null:'giant-panda');","assert.equal(item.baoSpecies,null);assert.equal(identity.manifestHasBao,false);assert.ok(identity.requests.includes('/den/models/bao.glb.gz'));assert.ok(!identity.requests.includes('/den/models/characters/bao.glb.gz'));");
 return source;
}
function prepare(output){
 assert.ok(output,'explicit new output directory required');assert.ok(!fs.existsSync(output),'refuse existing diagnostic directory');
 const source=controlSource(fs.readFileSync(__dirname+'/native-performance.cjs','utf8'));
 const plan={recordedAt:new Date().toISOString(),kind:'Diagnostic A/A only; never replaces failed60 or quiet6',scenario:'meeting-light',condition:'User reported other GPU workloads closed; agent controls only owned browser',repetitions:3,order:['A(original)','B(original)','B(original)','A(original)','A(original)','B(original)'],warmupMs:10000,sampleMs:30000,overallBoundMs:420000,minimumFrames:801,minimumGpuQueries:251,zeroDisjointAndPending:true,sourceCommit:'efbb225f9569abeb269cd052236dac426c4d9af4',collector:'Unchanged render/animation/GPU instrumentation; both labels delete characters.bao and use original portrait; request/manifest identity recorded outside sample',harnessSha256:hash(source),immutableFiles:{'resumed/performance-assembled-60.json':'d3a5ca47a75a7bef4f586d560fed68039dc37d3b67ad72d56470d2e357221b1d','quiet-diagnostic/performance-raw.json':'692e851fa7894d92855e5b0db0f4ee419bac6bbd0f32739b5748d072ea87b699'}};
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(output+'/native-performance.cjs',source);for(const n of ['capture-review.cjs','performance-resume.cjs'])fs.copyFileSync(__dirname+'/'+n,output+'/'+n);fs.writeFileSync(output+'/diagnostic-plan.json',JSON.stringify(plan,null,2)+'\n');return plan;
}
module.exports={controlSource,prepare};
if(require.main===module)console.log(JSON.stringify(prepare(process.argv[2]),null,2));

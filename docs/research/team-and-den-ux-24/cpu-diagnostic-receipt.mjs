// Read-only hash proof plus a preparation receipt. Does not start any capture.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const here=path.dirname(new URL(import.meta.url).pathname);
const external='/mnt/c/Users/Derek/.codex/visualizations/2026/10/19/01a15689-f776-7ab1-8ca6-13d1dbc49206';
const frozen=path.join(external,'ticket24-cpu-diagnostic-bracketed');
const hash=async file=>{const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex');};
const proof=async(file,expected)=>{const bytes=fs.statSync(file).size,sha256=await hash(file);if(expected){assert.equal(bytes,expected.bytes,file);assert.equal(sha256,expected.sha256,file);}return {path:file,bytes,sha256};};
assert.ok(!fs.existsSync(path.join(frozen,'capture-attempt.json')),'Preparation only; no capture attempted');
const prior=JSON.parse(fs.readFileSync(path.join(here,'same-context-calibration-receipt.json'))),build=JSON.parse(fs.readFileSync(path.join(here,'same-context-receipt.json')));
const retainedBuild=[];for(const file of build.buildFiles)retainedBuild.push(await proof(path.join(build.retainedBuild,file.name),file));assert.equal(retainedBuild.length,62);
const immutable=[];for(const file of prior.immutableVerified)immutable.push(await proof(path.join(external,'ticket24-acceptance',file.name),file));
const calibration=await proof(path.join(prior.root,'calibration-raw.json'),prior.files.find(f=>f.name==='calibration-raw.json'));
const plan=JSON.parse(fs.readFileSync(path.join(frozen,'calibration-plan.json'))),harness=[];
for(const [name,sha256]of Object.entries(plan.files)){const item=await proof(path.join(frozen,name));assert.equal(item.sha256,sha256);harness.push(item);}
const logger=path.join(external,'ticket24-cpu-diagnostic','cpu-counters.ps1');assert.equal(await hash(logger),plan.files['cpu-counters.ps1'],'Exact logger code passed preflight');
const preflight=await proof(path.join(external,'ticket24-cpu-diagnostic','cpu-counters-preflight.json'));
const receipt={kind:'Tested diagnostic preparation only; capture requires fresh Ready',recordedAt:new Date().toISOString(),sourceBase:'d0d1173a4f24',productionRuntime:prior.productionRuntime,frozen,plan:await proof(path.join(frozen,'calibration-plan.json')),harness,preflight,retainedBuild,immutable,calibration,noBuildPerformed:true,noCapturePerformed:true,cleanup:'Only short read-only counter preflight started; completed normally. No server/browser/router/service started.',limits:['CPU logger query wall times1202.4194ms and289.302ms are observer overhead, not measured CPU execution cost.','Provider counter clock fields missing; use UTC/Stopwatch acquisition windows and preserve missingness.','Diagnostic cannot establish exact preemption, physical GPU busy time or asset acceptance.']};
fs.writeFileSync(path.join(here,'cpu-diagnostic-receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({buildFiles:retainedBuild.length,immutable:immutable.length,harness:harness.length,driver:harness.find(f=>f.path.endsWith('native-cpu-diagnostic.cjs')).sha256,noCapture:true}));

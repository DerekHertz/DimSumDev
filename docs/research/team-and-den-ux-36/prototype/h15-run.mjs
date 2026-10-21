// THROWAWAY sole-run owner. Literal argv, shell:false, detached owned process group.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const here=import.meta.dirname,root=path.resolve(here,'../../../..'),label='36-h15-settlement-contract-20261021-035316',base='/tmp/'+label;
const selector='36 occupied centre|36 fitting boxed|36 cancellation away|36 snapshot|36 exact cache|36 dense no-approach|36 primary home|36 later allocation|visitors retain live identities|36 phased landing search|36 reduced motion';
const testFiles=['actor-places.test.mjs','owned-places.test.mjs','actors.test.mjs','allocation-work.test.mjs'].map(n=>path.join(root,'apps/ui/src/scene/meshy',n));
const loader=path.join(here,'h15-loader.mjs'),proof=path.join(here,'h15-proof.mjs');
const proofArgv=['--loader',loader,proof,base+'.diagnostics.json'];
const testArgv=['--loader',loader,'--test','--test-concurrency=2','--test-name-pattern='+selector,...testFiles];
if(process.argv.includes('--child')){
 const execute=args=>new Promise(resolve=>{const child=spawn(process.execPath,args,{shell:false,cwd:root,stdio:'inherit'});child.on('error',error=>{console.error(JSON.stringify({event:'spawn-failed',message:error.message}));resolve(1);});child.on('close',code=>resolve(code??1));});
 console.log(JSON.stringify({event:'single-run-proof-begin'}));const result=await execute(proofArgv);if(result!==0)process.exit(result);
 console.log(JSON.stringify({event:'unchanged-original-safety-tests-begin',concurrency:2}));process.exit(await execute(testArgv));
}
const artifacts=['.log','.receipt.json','.cleanup.json','.diagnostics.json','.modules.jsonl'];for(const suffix of artifacts)if(fs.existsSync(base+suffix))throw Error('Refusing overwrite '+base+suffix);
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files=[...testFiles,...['actor-places','actor-travel','allocation-work','actors','places','garden-route','actor-envelope','daily-routines'].map(n=>path.join(root,'apps/ui/src/scene/meshy',n+'.mjs')),...fs.readdirSync(here).filter(n=>/\.(mjs|txt|json)$/.test(n)).map(n=>path.join(here,n))];
const hashes=Object.fromEntries(files.map(p=>[path.relative(root,p),hash(p)]));
const meta={label,base:'bddf906e630bd2a7669e0630198e8bbb3da154a9',productionBase:'993523f244483f554079ece4ebb07c4c9ff8e93c',shell:false,cwd:root,proofArgv,testArgv,hashes,boundMilliseconds:60000,started:new Date().toISOString()};
fs.closeSync(fs.openSync(base+'.modules.jsonl','wx'));
const fd=fs.openSync(base+'.log','wx'),start=performance.now();let killed=null,firstFailure=null,lineBuffer='';
const child=spawn(process.execPath,[import.meta.filename,'--child'],{shell:false,cwd:root,detached:true,stdio:['ignore','pipe','pipe']});meta.childPid=child.pid;console.log(JSON.stringify({event:'sole-run-started',pid:child.pid,label,boundMilliseconds:60000}));
const kill=reason=>{if(killed)return;killed=reason;try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}};
const timer=setTimeout(()=>kill('60-second-bound'),60000);
const output=buffer=>{fs.writeSync(fd,buffer);lineBuffer+=buffer.toString();let index;while((index=lineBuffer.indexOf('\n'))>=0){const line=lineBuffer.slice(0,index);lineBuffer=lineBuffer.slice(index+1);if(line.startsWith('{'))console.log(line);if(/^not ok /.test(line)){firstFailure=line;console.log(JSON.stringify({event:'STOP-first-original-test-failure',line}));kill('first-original-test-failure');}}};
child.stdout.on('data',output);child.stderr.on('data',output);
child.on('error',error=>{firstFailure=error.message;kill('spawn-failed');});
child.on('close',(code,signal)=>{
 clearTimeout(timer);fs.closeSync(fd);let present=false,probe;try{process.kill(-child.pid,0);present=true;probe='exists';process.kill(-child.pid,'SIGKILL');}catch(error){probe=error.code;}
 const cleanup={childPid:child.pid,groupPresentAtReceipt:present,probe,cleanupSignal:present?'SIGKILL':null,finished:new Date().toISOString()};
 const receipt={...meta,finished:new Date().toISOString(),elapsedMilliseconds:performance.now()-start,code,signal,killed,firstFailure,cleanup};
 fs.writeFileSync(base+'.receipt.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});fs.writeFileSync(base+'.cleanup.json',JSON.stringify(cleanup,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({event:'sole-run-finished',label,elapsedMilliseconds:receipt.elapsedMilliseconds,code,signal,killed,cleanup}));process.exitCode=code===0&&!killed&&!present?0:1;
});

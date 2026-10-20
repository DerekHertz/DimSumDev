import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {readEvents,correlation}=createRequire(import.meta.url)('./summarize-trace.cjs');
test('bounded-memory trace reader processes event lines and excludes metadata trailer',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bao-trace-'));
 try{const file=path.join(dir,'trace.json');await fs.writeFile(file,'{"traceEvents":[\n{"name":"start","args":{"text":"brace } and escaped \\\" quote"}},\n{"name":"end"}\n],"metadata":{"name":"not-an-event"}}');const events=[];await readEvents(file,e=>events.push(e));assert.deepEqual(events.map(e=>e.name),['start','end']);await fs.writeFile(file,JSON.stringify({traceEvents:[{name:'adjacent',args:{text:'[}'}},{name:'second'}],metadata:{name:'ignore'}}));const adjacent=[];await readEvents(file,e=>adjacent.push(e.name));assert.deepEqual(adjacent,['adjacent','second']);await fs.writeFile(file,'{"wrong":[]}');await assert.rejects(()=>readEvents(file,()=>{}),/trace event array/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('correlation preserves direction and refuses no variance by returning null',()=>{assert.equal(correlation([1,2,3],[2,4,6]),1);assert.equal(correlation([1,2,3],[6,4,2]),-1);assert.equal(correlation([1,1],[2,3]),null);});

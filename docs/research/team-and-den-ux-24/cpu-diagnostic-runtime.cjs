const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {CATEGORIES,OutputBudget,TaskLog,parseEvents}=require('./cpu-diagnostic-core.cjs');
class Diagnostic{
 constructor(output,scope,startProcess=spawn){this.scope=scope;this.sink=new OutputBudget(output);this.block=0;this.active=false;this.logger=null;this.cdp=null;this.stream=null;this.startProcess=startProcess;this.brackets=[];}
 save(result){this.sink.write('cpu-diagnostic-raw.json',JSON.stringify(result));}
 status(result){this.sink.write('cpu-diagnostic-status.json',JSON.stringify(result),true);}
 assertNoCounters(){assert.equal(this.logger,null,'No counter logger may run during warmup/sample');}
 async collectCounters(bracket){
  this.scope.check();this.assertNoCounters();assert.ok(['pre','post'].includes(bracket));const receipt={bracket,startedUtc:new Date().toISOString(),startedMonotonicMs:performance.now(),samples:0};this.brackets.push(receipt);let timer;
  try{await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('15000ms CPU bracket deadline; no retry')),15000);
   this.logger=this.startProcess('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'cpu-counters.ps1'),'-DurationSeconds','10'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
   let buffer='';this.logger.stdout.setEncoding('utf8');this.logger.stdout.on('data',chunk=>{try{buffer+=chunk;assert.ok(buffer.length<1048576,'CPU logger line bound');let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(line){const row=JSON.parse(line);assert.equal(row.source,'Win32_PerfFormattedData_Counters_ProcessorInformation');this.sink.append('cpu-counters.ndjson',JSON.stringify({...row,bracket,receivedUtc:new Date().toISOString(),receivedMonotonicMs:performance.now()})+'\n');receipt.samples++;}}}catch(error){reject(error);}});
   this.logger.on('error',()=>reject(Error('Owned CPU logger spawn failed')));
   this.logger.stderr.on('data',()=>reject(Error('Owned CPU logger emitted stderr; payload omitted')));
   this.logger.on('close',code=>{this.logger=null;receipt.finishedUtc=new Date().toISOString();receipt.finishedMonotonicMs=performance.now();if(code!==0)reject(Error('Owned CPU logger exited unsuccessfully'));else if(receipt.samples!==2)reject(Error('CPU bracket did not retain exactly two samples; no retry'));else resolve();});
  });}finally{clearTimeout(timer);}
 }
 async start(cdp){this.scope.check();this.assertNoCounters();this.cdp=cdp;this.block++;assert.ok(this.block<=6);await cdp.send('Tracing.start',{categories:'-*,'+CATEGORIES.join(','),options:'record-until-full',transferMode:'ReturnAsStream',bufferUsageReportingInterval:1000});this.active=true;}
 async finish(row){
  this.scope.check();const cdp=this.cdp,completed=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const receipt=await completed;this.active=false;assert.ok(receipt.stream,'trace stream');this.stream=receipt.stream;
  const filter=new TaskLog(this.sink,'block'+this.block,()=>this.scope.check());let inputBytes=0;
  const scope=this.scope;
  async function* chunks(){for(;;){scope.check();const part=await cdp.send('IO.read',{handle:receipt.stream,size:65536});const data=Buffer.from(part.data,part.base64Encoded?'base64':'utf8');inputBytes+=data.length;yield data.toString('utf8');if(part.eof)break;}}
  try{await parseEvents(chunks(),e=>filter.visit(e));row.taskTiming=await filter.finish();row.taskTiming.inputBytes=inputBytes;row.taskTiming.dataLossOccurred=receipt.dataLossOccurred??false;assert.equal(row.taskTiming.dataLossOccurred,false,'trace data loss');}finally{if(this.stream){this.stream=null;await cdp.send('IO.close',{handle:receipt.stream});}}
 }
 async close(){
  if(this.logger){this.logger.kill();this.logger=null;}
  // Best-effort protocol cleanup is bounded; owned BrowserServer close/kill is
  // the final guarantee even if the target no longer responds to protocol.
  const cleanup=[];if(this.stream){const handle=this.stream;this.stream=null;cleanup.push(this.cdp.send('IO.close',{handle}));}if(this.active){cleanup.push(this.cdp.send('Tracing.end'));}
  let timer;try{await Promise.race([Promise.allSettled(cleanup),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}
 }
}
module.exports={Diagnostic};

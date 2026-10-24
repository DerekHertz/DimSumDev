export function createFrameWork({now=()=>performance.now(),budgetMs=2}={}){
 const jobs=new Map(),waiting=new Map();let running=null;
 function cancel(key){const job=jobs.get(key);jobs.delete(key);waiting.delete(job);if(job&&job!==running)job.return?.();}
 return {
  has:key=>jobs.has(key),
  submit(key,job){cancel(key);jobs.set(key,job);},
  cancel,
  update(){
   if(!jobs.size)return;const deadline=now()+budgetMs;let remaining=jobs.size;
   while(jobs.size&&remaining>0&&now()<deadline){
    const [key,job]=jobs.entries().next().value;running=job;let result;
    const ready=waiting.get(job);
    if(ready&&!ready()){running=null;jobs.delete(key);jobs.set(key,job);remaining--;continue;}
    waiting.delete(job);
    try{result=job.next();}catch(error){jobs.delete(key);throw error;}finally{running=null;}
    if(jobs.get(key)!==job){job.return?.();continue;}
    jobs.delete(key);if(!result.done){jobs.set(key,job);if(result.value?.ready)waiting.set(job,result.value.ready);}remaining=jobs.size;
   }
  },
  dispose(){for(const key of [...jobs.keys()])cancel(key);},
 };
}

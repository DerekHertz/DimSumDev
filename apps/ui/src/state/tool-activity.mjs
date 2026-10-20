import { sourceKey } from '../../../shared/transcript-source.mjs';
import { cleanText } from '../../../shared/safe-text.mjs';
import { LIVE_AGENT_STATES, runtimeOf } from '../shell/resident-inventory.mjs';

// Separate from the scrolling transcript: an active call may outlive its retained message.
// Retired entry ids below the floor stay retired even after their tombstone is evicted.
const LIMIT = 200;
const safe = value => typeof value === 'string' ? cleanText(value).replace(/\s+/g,' ').trim() : '';
const clip = (value, limit) => [...value].length > limit ? [...value].slice(0,limit-1).join('')+'…' : value;
const own=(object,key)=>object&&Object.hasOwn(object,key)?object[key]:undefined;
function retainRun(state,id,run){const next={...state,[id]:run};const ids=Object.keys(next);for(const id of ids.slice(0,Math.max(0,ids.length-LIMIT)))delete next[id];return next;}
export function observeTools(state = {}, runId, entry) {
 const old=own(state,runId)??{rows:[],floor:-1,ended:false};
 if(old.ended)return state;
 if(entry?.kind==='ended'||entry?.kind==='stop')return retainRun(state,runId,{rows:[],floor:old.floor,ended:true});
 const key=sourceKey(entry?.source), invocationId=safe(entry?.invocationId);
 if(entry?.kind!=='tool'||!key||entry.source.runId!==runId||entry.id!==entry.source.entryId||!invocationId||invocationId!==entry.invocationId||invocationId.length>200)return state;
 const at=old.rows.findIndex(row=>row.key===key);
 if(at<0&&entry.id<=old.floor)return state;
 const terminal=entry.status!=='running'||typeof entry.result==='string';
 if(at>=0&&old.rows[at].terminal)return state;
 const {project,runtime,role,entryId}=entry.source;
 const row={key,source:{project,runtime,role,runId,entryId},invocationId,terminal,name:clip(safe(entry.name),100),summary:clip(safe(entry.summary),200)};
 let rows=old.rows.filter(row=>row.key!==key);rows.push(row);rows.sort((a,b)=>a.source.entryId-b.source.entryId);
 let floor=old.floor;
 while(rows.length>LIMIT){const at=rows.findIndex(row=>row.terminal);const [removed]=rows.splice(at<0?0:at,1);floor=Math.max(floor,removed.source.entryId);}
 return retainRun(state,runId,{...old,rows,floor});
}
export function reconcileTools(previous={}, snapshot) {
 let next={};
 // Only runs in the authoritative snapshot survive. Preserve terminal tombstones, replace active assertions.
 for(const agent of snapshot?.agents??[]){
  if(!agent?.id)continue;
  const old=own(previous,agent.id);
  const entries=snapshot?.transcripts?.[agent.id]?.entries??[];
  next=retainRun(next,agent.id,{rows:old?.rows.filter(row=>row.terminal||entries.some(entry=>sourceKey(entry.source)===row.key&&entry.status==='running'))??[],floor:old?.floor??-1,ended:old?.ended===true||!LIVE_AGENT_STATES.includes(agent.state)});
  for(const entry of snapshot?.transcripts?.[agent.id]?.entries??[])next=observeTools(next,agent.id,entry);
 }
 return next;
}
export function toolActivityFor(state, agent, connection) {
 if(connection?.phase!=='live'||!LIVE_AGENT_STATES.includes(agent?.state))return null;
 const run=own(state,agent.id);if(!run||run.ended)return null;
 const counts=new Map();for(const row of run.rows)counts.set(row.invocationId,(counts.get(row.invocationId)??0)+1);
 const rows=run.rows.filter(row=>!row.terminal&&counts.get(row.invocationId)===1&&row.name&&row.source.project===agent.project&&row.source.role===agent.role&&row.source.runtime===runtimeOf(agent));
 if(!rows.length)return null;
 rows.sort((a,b)=>b.source.entryId-a.source.entryId);
 const waiting=agent.state==='waiting_on_user'||agent.state==='needs-you';
 const suffix=rows.length>1?` +${rows.length-1}`:'';
 const latest=rows[0],label=waiting?`Waiting on you · ${latest.name}`:[latest.name,latest.summary].filter(Boolean).join(' · ');
 return {text:clip(label,64-suffix.length)+suffix,count:rows.length,waiting,sources:rows.map(row=>row.source)};
}

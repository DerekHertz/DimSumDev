import { liveActorsFromSnapshot } from '../review/live-actors.mjs';
import { actorBindings } from '../scene/meshy/layout.mjs';
import { RESIDENTS, residentKey } from './resident-inventory.mjs';
export { RESIDENTS } from './resident-inventory.mjs';

// Presentation metadata only. Agent state and ticket identity always come from the live snapshot.
export function deskResidents(snapshot, options = {}) {
  const bindings = options.bindings ?? actorBindings(liveActorsFromSnapshot(snapshot, options));
  const rows=RESIDENTS.flatMap(resident => {
    const primary = bindings.get(resident.id);
    const visitors = [...bindings].filter(([id, actor]) => residentKey(actor.role,actor.runtime) === resident.id && id !== resident.id);
    return [{ ...resident, projectId:options.projectId, ...primary, id: resident.id, state: primary?.state ?? 'resident', ref: primary?.ref ?? null, visitor: false },
      ...visitors.map(([id, actor]) => ({ ...resident, ...actor, id, visitor: true }))];
  });
  return rows.map(row=>({...row,sceneNotes:(options.scenePresentations??[]).flatMap(p=>{
    if(p.id===row.id&&p.ref===(row.ref??null)&&(p.agentId??null)===(row.agentId??null))return[p.presentation];
    if(p.guest&&!row.visitor&&residentKey(p.role,p.runtime)===row.id)return['Meeting visitor · '+p.presentation];
    return[];
  })}));
}

export function deskActivity(snapshot, options) {
  const actors = liveActorsFromSnapshot(snapshot, options);
  return {
    working: actors.filter(actor => actor.state === 'working').length,
    waiting: actors.filter(actor => actor.state === 'needs-you').length,
    blocked: actors.filter(actor => actor.state === 'blocked').length,
    resting: RESIDENTS.length - new Set(actors.map(actor => residentKey(actor.role,actor.runtime))).size,
    visitors: actors.filter(actor => actor.split).length,
  };
}

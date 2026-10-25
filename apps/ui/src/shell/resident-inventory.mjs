// Browser-safe presentation inventory. Coverage is checked against the trusted recipes.
export const DISPATCHABLE_ROLES = Object.freeze(['orchestrator','product','architect','release-manager','developer','runner','code-reviewer','qa','security','sre','designer','technical-writer']);
export const runtimeOf = row => row?.runtime === undefined ? 'claude' : ['claude','codex'].includes(row.runtime) ? row.runtime : null;
export const projectOf = row => row?.projectId === undefined ? null : typeof row.projectId === 'string' && row.projectId.trim() ? row.projectId : undefined;
export const residentKey = (role,runtime='claude') => runtime === 'claude' ? role : `${runtime}:${role}`;
export const sameResident = (a,b) => runtimeOf(a) !== null && runtimeOf(a) === runtimeOf(b) && a?.role === b?.role && projectOf(a) !== undefined && projectOf(a) === projectOf(b);
export const boundAgentKey = row => JSON.stringify([projectOf(row),runtimeOf(row),row?.role,row?.ref]);
export const RUNTIME_UNAVAILABLE = 'Codex conversations and tasks are unavailable in this den. Runtime support has not been enabled.';
export const LIVE_AGENT_STATES = Object.freeze(['working','waiting_on_user','needs-you','blocked','throttled','idle']);
const roles = [
 ['orchestrator','Bao','The Pass'],['product','The Planner','The Pass'],['architect','The Architect','The Pass'],['release-manager','The Release Manager','The Pass'],
 ['developer','The Maker','Steamers'],['runner','The Runner','Steamers'],
 ['code-reviewer','The Code Reviewer','Tea'],['qa','The Taster','Tea'],['security','The Guardian','Pantry'],['sre','The SRE','Pantry'],
 ['designer','The Stylist','Front of House'],['technical-writer','The Technical Writer','Front of House'],
];
export const RESIDENTS = Object.freeze(roles.flatMap(([role,name,team]) => {
 const dispatchable=DISPATCHABLE_ROLES.includes(role);
 return (dispatchable?['claude','codex']:['claude']).map(runtime=>Object.freeze({id:residentKey(role,runtime),role,name:role==='orchestrator'&&runtime==='codex'?'Jiao':name,team,runtime,dispatchable}));
}));

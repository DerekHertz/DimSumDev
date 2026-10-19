// Browser-safe presentation inventory. Coverage is checked against the trusted recipes.
export const DISPATCHABLE_ROLES = Object.freeze(['orchestrator','product','architect','developer','scout','runner','qa','security','designer','herald']);
export const runtimeOf = row => row?.runtime === undefined ? 'claude' : ['claude','codex'].includes(row.runtime) ? row.runtime : null;
export const projectOf = row => row?.projectId === undefined ? null : typeof row.projectId === 'string' && row.projectId.trim() ? row.projectId : undefined;
export const residentKey = (role,runtime='claude') => runtime === 'claude' ? role : `${runtime}:${role}`;
export const sameResident = (a,b) => runtimeOf(a) !== null && runtimeOf(a) === runtimeOf(b) && a?.role === b?.role && projectOf(a) !== undefined && projectOf(a) === projectOf(b);
export const boundAgentKey = row => JSON.stringify([projectOf(row),runtimeOf(row),row?.role,row?.ref]);
export const RUNTIME_UNAVAILABLE = 'Codex conversations and tasks are unavailable in this den. Runtime support has not been enabled.';
export const LIVE_AGENT_STATES = Object.freeze(['working','waiting_on_user','needs-you','blocked','throttled','idle']);
const roles = [
 ['orchestrator','Bao','The Pass'],['product','The Planner','The Pass'],['architect','The Architect','The Pass'],
 ['developer','The Maker','Steamers'],['scout','The Scout','Steamers'],['runner','The Runner','Steamers'],
 ['qa','The Taster','Tea'],['security','The Guardian','Pantry'],['designer','The Stylist','Front of House'],['herald','The Herald','Front of House'],
 ['debugger','The Debugger','Steamers'],['release-manager','The Drummer','Festival'],['knowledge-keeper','The Librarian','Library'],['docs-writer','The Painter','Library'],['stem-cub','The Cub','Cubs'],
];
// team-and-den-ux/04 (spec section 3): Team lists every role in the charter. These four have role definitions (ADR 0029)
// but no panda in the den until team-and-den-ux/03 seats them, so Team shows them with a placeholder and no Talk.
export const UNSEATED_ROLES = Object.freeze([
  ['code-reviewer', 'Code reviewer', 'Tea'], ['release-manager', 'Release manager', 'The Pass'],
  ['sre', 'SRE', 'Pantry'], ['technical-writer', 'Technical writer', 'Front of House'],
].map(([role, name, team]) => Object.freeze({ id: `unseated:${role}`, role, name, team, runtime: 'claude', dispatchable: false, unseated: true })));
export const RESIDENTS = Object.freeze(roles.flatMap(([role,name,team]) => {
 const dispatchable=DISPATCHABLE_ROLES.includes(role);
 return (dispatchable?['claude','codex']:['claude']).map(runtime=>Object.freeze({id:residentKey(role,runtime),role,name:role==='orchestrator'&&runtime==='codex'?'Jiao':name,team,runtime,dispatchable}));
}));

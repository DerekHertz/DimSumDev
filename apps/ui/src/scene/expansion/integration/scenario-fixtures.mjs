const base={seq:0,tickets:[],agents:[],placements:[],approvals:[],deliveries:[],frontier:[],requests:[],sessions:[],usage:null,libraryRev:0};
const ticket={ref:'mockup/repair-dumpling',title:'Repair the dumpling counter',type:'bug',status:'claimed',holder: { role:'developer',since:'2026-10-13T16:00:00Z'}};
const agent={id:'preview-maker',role:'developer',ref:ticket.ref,state:'working',capabilities:{approve:true,message:true,stop:true}};
const library={connections:[{name:'preview-repo',title:'Recipe repository',purpose:'Mock connection for visual testing',status:{state:'connected'},roles:[{role:'developer',usable:true}],tools:[],uses:{count:0}}],skills:[{name:'preview-recipe',description:'Mock recipe for the expansion gallery',roles:['developer','qa']}]};
const actor={role:'developer',ref:ticket.ref,state:'working',activity:'Working',bubble:'Checking the batch',task:ticket.title,split:false};
export const SCENARIOS={
 idle:{label:'Quiet',snapshot:{...base},actors:[],library,connection:{phase:'live'}},
 working:{label:'Work under way',snapshot:{...base,seq:1,tickets:[ticket],agents:[agent],deliveries:[{id:'preview-delivery',ref:ticket.ref,title:ticket.title,state:'running',step:'qa',evidence:{}}]},actors:[actor],library,connection:{phase:'live'}},
 attention:{label:'Needs your answer',snapshot:{...base,seq:2,tickets:[ticket],agents:[{...agent,state:'waiting_on_user'}],approvals:[{id:'preview-permission',agentId:agent.id,status:'pending',tool:'Read',summary:'Inspect the failed recipe',expiresAt:'2099-01-01T00:00:00Z'}],deliveries:[{id:'preview-delivery',ref:ticket.ref,state:'paused',step:'qa',pause:{kind:'visual-verdict',reason:'Waiting for your visual review'}}]},actors:[{...actor,state:'needs-you'}],library,connection:{phase:'live'}},
 merged:{label:'Delivered',snapshot:{...base,seq:3,deliveries:[{id:'preview-delivery',ref:ticket.ref,state:'merged',step:'resolve',pr:{number:42,url:'https://example.com/preview/pr/42'},evidence:{qa:'pass',ci:'pass'}}]},actors:[],library,connection:{phase:'live'}},
 offline:{label:'Bridge offline',snapshot:{...base},actors:[],library:null,connection:{phase:'offline'}}
};

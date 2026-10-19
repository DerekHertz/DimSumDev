/** Stable scene contract. +Y up, +Z forward, 1 scene unit is approximately 1 metre. */
export const CONTRACT_VERSION=1;
export const LIVE_ROLES=Object.freeze(['orchestrator','product','architect','developer','scout','qa','security','designer','herald']);
export const ZONES=Object.freeze([
 {id:'repair',assetId:'zone-repair',label:'Repair & investigation',kind:'work',position:[-20,0,-1],radius:2.1,roles:['developer','qa'],conceptRoles:['debugger'],source:['tickets','agents','placements'],panel:'ticket',camera:{position:[-16,2.5,4],target:[-20,1.2,-1]},approach:[-17.3,0,-.1]},
 {id:'archive',assetId:'zone-archive',label:'Archive & brush garden',kind:'work',position:[11,0,-14],radius:1.6,roles:['designer','herald'],conceptRoles:['knowledge-keeper','docs-writer'],source:['library'],panel:'library',camera:{position:[15,2.2,-9],target:[11,1.2,-14]},approach:[9,0,-13.8]},
 {id:'release',assetId:'zone-release',label:'Release & dispatch',kind:'work',position:[20,0,5],radius:2.1,roles:['orchestrator','herald'],conceptRoles:['release-manager'],source:['deliveries'],panel:'delivery',camera:{position:[24,2.4,11],target:[20,1.3,5]},approach:[17.3,0,5]},
 {id:'pond',assetId:'zone-pond',label:'Koi pond & tea bridge',kind:'leisure',position:[-21,0,9],radius:2.4,roles:[],conceptRoles:[],source:[],panel:'leisure',camera:{position:[-17,2.5,14],target:[-21,.6,9]},approach:[-18.2,0,9]},
 {id:'balance',assetId:'zone-balance',label:'Bamboo balance yard',kind:'leisure',position:[21,0,-8],radius:2.2,roles:[],conceptRoles:[],source:[],panel:'leisure',camera:{position:[25,2.2,-2],target:[21,1,-8]},approach:[18.4,0,-7]},
 {id:'festival',assetId:'zone-festival',label:'Picnic & festival lawn',kind:'leisure',position:[0,0,0],radius:2.3,roles:[],conceptRoles:[],source:[],panel:'leisure',camera:{position:[4,2.5,6],target:[0,.8,0]},approach:[-3,0,0]}
]);
export const INTERACTIONS=Object.freeze([
 {id:'repair.inspect',zone:'repair',part:'trace-board',intent:'open-ticket',label:'Inspect repair work'},
 {id:'repair.talk',zone:'repair',part:'tool-rack',intent:'open-role',role:'developer',label:'Talk to the Maker'},
 {id:'repair.lucky-bao',zone:'repair',part:'lucky-bao',intent:'discover',label:'Lift the little basket'},
 {id:'archive.library',zone:'archive',part:'archive-chest',intent:'open-library',label:'Browse recipes and connections'},
 {id:'archive.notes',zone:'archive',part:'ink-desk',intent:'open-role',role:'herald',label:'Draft an illustrated note'},
 {id:'release.delivery',zone:'release',part:'release-ledger',intent:'open-delivery',label:'Inspect delivery progress'},
 {id:'release.announce',zone:'release',part:'outbound-basket',intent:'open-role',role:'herald',label:'Talk to the Herald'},
 {id:'release.drum',zone:'release',part:'festival-drum',intent:'leisure',activity:'drum',label:'Tap the festival drum'},
 {id:'pond.koi',zone:'pond',part:'koi',intent:'leisure',activity:'koi',label:'Watch the koi'},
 {id:'pond.tea',zone:'pond',part:'tea-ledge',intent:'discover',label:'Tap twice to say thanks'},
 {id:'balance.gong',zone:'balance',part:'gong',intent:'leisure',activity:'gong',label:'Ring the small gong'},
 {id:'balance.target',zone:'balance',part:'target',intent:'leisure',activity:'balance',label:'Try the dumpling target'},
 {id:'festival.picnic',zone:'festival',part:'picnic-set',intent:'leisure',activity:'picnic',label:'Open the picnic basket'},
 {id:'festival.dragon',zone:'festival',part:'dragon-costume',intent:'leisure',activity:'dragon',label:'Wake the festival dragon'},
 {id:'festival.menu',zone:'festival',part:'secret-menu',intent:'discover',label:'Peek at the secret menu'}
]);
export const STATES=Object.freeze(['idle','working','needs-you','blocked','complete','unavailable']);

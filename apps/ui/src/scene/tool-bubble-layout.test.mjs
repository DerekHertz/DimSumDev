import test from 'node:test';
import assert from 'node:assert/strict';
import { placeToolBubbles } from './tool-bubble-layout.mjs';
test('42 near/far presentation and collision priority keep permissions and focus inspectable without sheet/action occlusion',()=>{
 const rows=[{id:'low',x:200,y:150,height:80},{id:'focus',x:200,y:150,height:80,focused:true},{id:'permission',x:600,y:150,height:20,waiting:true},{id:'covered',x:800,y:150,height:80}];
 const out=placeToolBubbles(rows,{width:1000,height:600,blocked:[{x:700,y:0,width:300,height:600}]});
 assert.equal(out.some(r=>r.id==='low'),false);assert.equal(out.some(r=>r.id==='covered'),false);
 assert.equal(out.find(r=>r.id==='focus').compact,false);assert.equal(out.find(r=>r.id==='permission').compact,true);
 assert.equal(placeToolBubbles([{id:'edge',x:3,y:30,height:90}],{width:375,height:600}).length,0);
});

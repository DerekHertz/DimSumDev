import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRole, actorBindings, meshMotion, WALK_START, NAVIGATION_TARGETS, PLAYER_EYE_HEIGHT, RESIDENT_HEIGHT } from './layout.mjs';
import { isWalkBlocked, startWalk,walk } from '../procedural/walk.mjs';

test('all external wardrobe role IDs map to the permanent canonical residents', () => {
  assert.equal(canonicalRole('release'), 'release-manager');
  assert.equal(canonicalRole('keeper'), 'knowledge-keeper');
  assert.equal(canonicalRole('writer'), 'docs-writer');
  assert.equal(canonicalRole('cub'), 'stem-cub');
  assert.equal(canonicalRole('developer'), 'developer');
});
test('concurrent live refs keep their own resident or visitor identity through refresh and removal', () => {
  const live = [{role:'developer',ref:'work/02'}, {role:'developer',ref:'work/03'}, {role:'qa',ref:'work/04'}, {role:'debugger',ref:'work/05'}];
  const first=actorBindings(live);
  assert.equal(first.get('developer').ref,'work/02');
  assert.equal(first.get('developer#work/03').ref,'work/03');
  assert.equal(first.has('debugger'),false,'decorative roles cannot imply backend agents');
  const next=actorBindings([{role:'developer',ref:'work/01'},...live],first);
  assert.equal(next.get('developer').ref,'work/02');
  assert.equal(next.get('developer#work/01').ref,'work/01');
  assert.equal(actorBindings([],next).size,0,'a removed bridge actor leaves no visitor');
});
test('Meshy motion is finite gentle root movement and reduced motion stops it', () => {
  assert.deepEqual(meshMotion(2,3,true),{lift:0,roll:0,turn:0});
  for(let t=0;t<20;t+=.13){const p=meshMotion(t,3,false);assert.ok(Math.abs(p.lift)<=.014&&Math.abs(p.roll)<=.009&&Math.abs(p.turn)<=.025);}
});
test('new walking world may set its own floor, spawn and collision boundaries without old obstacles', () => {
  const state=startWalk(WALK_START);
  assert.equal(state.x,0);assert.equal(state.z,42);assert.equal(state.groundY,.36);
  const world={floorRadius:29,floorCenter:{x:0,z:-1},obstacles:[{type:'box',x:2,z:24,halfX:.4,halfZ:1.5}],avoid:[]};
  assert.equal(isWalkBlocked(0,24,world),false,'central gate passage stays open');
  assert.equal(isWalkBlocked(2,24,world),true,'gate post stops the walker');
  assert.equal(isWalkBlocked(0,27.9,world),true,'body stays inside the shifted island');
  assert.deepEqual(NAVIGATION_TARGETS.library,[0,1,24]);
});
test('first-person eye height follows a regular adult resident while walking and climbing', () => {
  const start=startWalk(WALK_START);
  assert.equal(RESIDENT_HEIGHT,2.04);assert.equal(PLAYER_EYE_HEIGHT,1.82);assert.equal(start.y,2.18);
  const world={eyeHeight:PLAYER_EYE_HEIGHT,floorRadius:70,obstacles:[],avoid:[],navigation:{groundAt:()=>.36}};
  assert.equal(walk(start,{forward:1,reducedMotion:true},.1,world).y,2.18);
  const raised={...world,navigation:{groundAt:()=>.46}};
  assert.ok(Math.abs(walk(start,{forward:1,reducedMotion:true},.1,raised).y-2.28)<1e-8);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildSnapshot} from './snapshot.mjs';
import {queueDrawerModel} from '../ui/src/overlay/queue-drawer-model.mjs';

test('snapshot and Queue exclude off-relay history while retaining active, review and missing blockers',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'snapshot-queue-'));
 const issues=path.join(root,'.scratch','work','issues');
 try{
  await mkdir(issues,{recursive:true});
  await writeFile(path.join(root,'.scratch','goals.md'),'# Goals\n\n| Key | Goal | Why | Done when |\n|---|---|---|---|\n| `den` | Den | Active work | Done |\n');
  for(const [number,status,blockedBy] of [
   ['01','closed','none'],['02','parked','none'],['03','resolved','none'],
   ['04','ready-for-agent','01, 02, 03'],['05','in-review','none'],
   ['06','ready-for-agent','05'],['07','ready-for-agent','99'],
  ])await writeFile(path.join(issues,number+'-ticket.md'),`# ${number}: Work\n\n**Status:** ${status}\n\n**Goal:** den\n\n**Blocked by:** ${blockedBy}\n\n## Comments\nHistorical evidence stays here.\n`);
  const snapshot=await buildSnapshot(root);
  const queue=queueDrawerModel(snapshot);
  assert.deepEqual(snapshot.tickets.map(t=>t.ref),['work/04-ticket','work/05-ticket','work/06-ticket','work/07-ticket']);
  assert.deepEqual(snapshot.frontier,['work/04-ticket']);
  assert.deepEqual(snapshot.tickets[0].blockedBy,[]);
  assert.equal(queue.openCount,4);
  assert.deepEqual(queue.goals[0].counts,{open:4,ready:1,review:1,you:0,waiting:2});
  assert.deepEqual(queue.goals[0].next,['work/04-ticket']);
  assert.deepEqual(queue.goals[0].tickets.find(t=>t.ref==='work/07-ticket').waitsOn,['99']);
  assert.match(await readFile(path.join(issues,'01-ticket.md'),'utf8'),/Historical evidence stays here/);
 }finally{await rm(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {CAST_PROFILES} from './cast-profiles.mjs';

// team-and-den-ux/35: the deformed-triangle clearance of bao-acceptance.test.mjs, for every other cast character.
// Furniture is the welcome circle and meeting-table proxies; seats are the exact table solids; every home on both runtimes is routable.
const script = new URL('../../../assets-src/den/cast-clearance.mjs', import.meta.url).pathname;
// The tortoise's shell is wider than the table's seat ring can take at any seat (accepted by the user for now; fix tracked in team-and-den-ux/54).
const KNOWN_SEAT_CROSSINGS = {tortoise: 1210};

for (const id of Object.keys(CAST_PROFILES)) test(`${id} clears its homes, furniture and the meeting-table seats and can reach its home`, {timeout: 120000}, () => {
  const output = `/tmp/cast-clearance-${id}-${process.pid}.json`;
  try {
    execFileSync(process.execPath, [script, id, output], {timeout: 100000, stdio: 'pipe'});
    const {summary, homes, seats, navigation} = JSON.parse(readFileSync(output));
    assert.equal(homes.length, id === 'jiao' ? 1 : 2, 'one home per runtime');
    assert.equal(summary.furnitureCrossings, 0, 'no triangle enters the welcome furniture at home');
    assert.equal(summary.deskCrossings, 0, 'no triangle enters its workstation desk');
    assert.equal(summary.seatCrossings, KNOWN_SEAT_CROSSINGS[id] ?? 0, 'table seat crossings');
    assert.ok(seats.length >= 21 && navigation.length === homes.length);
    assert.equal(summary.unreachableHomes, 0, 'a route reaches every home');
    assert.equal(summary.unreachableSeats, 0, 'a route reaches every seat');
    assert.ok(summary.lowestPoint >= homes[0].position[1] - .02, 'no pose sinks through its floor');
  } finally { rmSync(output, {force: true}); }
});

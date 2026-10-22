import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAST, castCharacterId } from './cast.mjs';
import { ROLE_PORTRAITS, ROLE_PORTRAIT_FALLBACKS } from '../../shell/role-portraits.mjs';

// team-and-den-ux/35: a cached portrait for each cast role (both runtimes share a species) and for Jiao.
const bytesOf = url => readFileSync(new URL('../../../public' + url, import.meta.url));
const castRoles = Object.keys(CAST).filter(role => role !== 'orchestrator');

test('every cast role shows its species on both runtimes, within 40 KiB, with the old portrait as its fallback', () => {
  assert.equal(castRoles.length, 9);
  for (const role of castRoles) {
    const expected = `/den/portraits/${role}-${castCharacterId(role)}.webp`;
    for (const key of [role, 'codex:' + role]) {
      assert.equal(ROLE_PORTRAITS[key], expected, key);
      const old = ROLE_PORTRAIT_FALLBACKS[key];
      assert.ok(old && old !== expected && bytesOf(old).length > 1000, key + ' keeps its old portrait as the fallback');
    }
    const webp = bytesOf(expected);
    assert.equal(webp.subarray(0, 4).toString(), 'RIFF'); assert.equal(webp.subarray(8, 12).toString(), 'WEBP');
    assert.ok(webp.length > 5000 && webp.length <= 40 * 1024, `${role} portrait ${webp.length} bytes, cap 40 KiB`);
  }
});

test('Jiao has her own portrait on codex:orchestrator only; Bao keeps his', () => {
  assert.equal(ROLE_PORTRAITS['codex:orchestrator'], '/den/portraits/orchestrator-jiao.webp');
  assert.equal(ROLE_PORTRAITS.orchestrator, '/den/portraits/bao-jade.webp');
  assert.equal(Object.entries(ROLE_PORTRAITS).filter(([, url]) => url.includes('jiao')).length, 1);
  const jiao = bytesOf(ROLE_PORTRAITS['codex:orchestrator']);
  assert.ok(jiao.length > 5000 && jiao.length <= 40 * 1024, `${jiao.length} bytes`);
  assert.ok(bytesOf(ROLE_PORTRAIT_FALLBACKS['codex:orchestrator']).length > 1000);
});

test('the red panda, the dragon and the uncast roles keep their portraits', () => {
  assert.equal(ROLE_PORTRAITS.developer, '/den/portraits/developer-red-panda.webp');
  assert.equal(ROLE_PORTRAITS['codex:developer'], '/den/portraits/developer-red-panda.webp');
  assert.equal(ROLE_PORTRAITS['technical-writer'], '/den/portraits/technical-writer-cloud-dragon.webp');
  assert.equal(ROLE_PORTRAITS['codex:technical-writer'], '/den/portraits/technical-writer-cloud-dragon.webp');
  assert.equal(ROLE_PORTRAITS.scout, '/den/portraits/scout.webp');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, safeToolInput } from './safe-text.mjs';
import { unsafeText, probes } from '../bridge/agents/fixtures/transcript-tools-40.mjs';

test('safe recorded input retains harmless command text around inline secrets', () => {
  const safe = safeToolInput({ command: `echo visible ${unsafeText()}` });
  assert.match(safe.command, /^echo visible /);
  for (const probe of probes) assert.equal(JSON.stringify(safe).includes(probe), false);
  assert.match(safe.command, /masked/);
});

test('credential fields are masked even when their value has no token prefix', () => {
  const credential = ['syntheticCredential', 'Value40'].join('');
  const password = ['synthetic', 'Password40'].join('');
  const safe = safeToolInput({ token: credential, password, nested: { API_TOKEN: credential }, command: 'echo visible' });
  assert.equal(safe.command, 'echo visible');
  assert.equal(JSON.stringify(safe).includes(credential), false);
  assert.equal(JSON.stringify(safe).includes(password), false);
});

test('safe input rejects unsupported, cyclic and ambiguous-key payloads without serialization', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const credentialKey = value => ['token', '=', '"', value, '"'].join('');
  for (const value of [[], new Date(), cyclic, { call: () => 'unsafe' }, { [credentialKey('syntheticCredentialValue40')]: 'one', [credentialKey('otherSyntheticValue40')]: 'two' }]) {
    assert.equal(safeToolInput(value), undefined);
  }
  assert.equal(cleanText('hello\u202e'), 'hello\\u202e');
});

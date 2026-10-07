/* fork(claude-chat) — the OAuth store's bounds: registration is unauthenticated, so the client
   list must not grow without limit, and a grant's tokens are only ever stored hashed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, MAX_CLIENTS, MAX_GRANTS_PER_USER, sha256 } from '../coach/chat-bridge/store.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-store-'));
const tokens = n => ({ access: 'ogm_at_a' + n, accessExp: Date.now() + 1000, refresh: 'ogm_rt_r' + n, refreshExp: Date.now() + 100000 });

test('unused clients are pruned after a day and the registry is bounded', () => {
  let t = 1_000_000;
  const s = createStore(dir(), { now: () => t });
  const first = s.registerClient({ name: 'a', redirectUris: ['x'] });
  s.createGrant({ uid: 'u', sv: 0, clientId: first.id, scope: 'coach' }, tokens(0));
  for (let i = 1; i < MAX_CLIENTS; i++) assert.ok(s.registerClient({ name: 'c' + i, redirectUris: ['x'] }));
  // Full: the oldest client without a grant makes room; the one with a grant is kept.
  assert.ok(s.registerClient({ name: 'overflow', redirectUris: ['x'] }));
  assert.ok(s.client(first.id), 'a client somebody authorised is never evicted');
  assert.equal(s._data().clients.length, MAX_CLIENTS);
  // A day later every client nobody authorised is gone.
  t += 25 * 3600 * 1000;
  s.registerClient({ name: 'late', redirectUris: ['x'] });
  assert.equal(s._data().clients.length, 2);
});

test('grants store hashes only, rotate, detect reuse, and are capped per profile', () => {
  const d = dir();
  const s = createStore(d);
  const c = s.registerClient({ name: 'c', redirectUris: ['x'] });
  const g = s.createGrant({ uid: 'u', sv: 0, clientId: c.id, scope: 'coach' }, tokens(1));
  const disk = fs.readFileSync(path.join(d, 'oauth.json'), 'utf8');
  assert.ok(!disk.includes('ogm_at_a1') && disk.includes(sha256('ogm_at_a1')));
  assert.equal(s.byAccess('ogm_at_a1').id, g.id);
  s.rotate(g, tokens(2));
  assert.equal(s.byAccess('ogm_at_a1'), null);
  assert.deepEqual(s.byRefresh('ogm_rt_r1'), { grant: g, reused: true });
  assert.deepEqual(s.byRefresh('ogm_rt_r2'), { grant: g, reused: false });
  // Survives a restart.
  assert.equal(createStore(d).byAccess('ogm_at_a2').id, g.id);
  for (let i = 0; i < MAX_GRANTS_PER_USER + 5; i++) s.createGrant({ uid: 'u', sv: 0, clientId: c.id, scope: 'coach' }, tokens(100 + i));
  assert.equal(s.grantsOf('u').length, MAX_GRANTS_PER_USER);
  assert.equal(s.revokeUser('u'), MAX_GRANTS_PER_USER);
});

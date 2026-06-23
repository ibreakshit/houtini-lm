import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliPool, scoreProfileForTask } from '../src/backends/cli/pool.js';
import type { CliConfig } from '../src/backends/cli/profiles.js';

const cfg: CliConfig = { tieBreak: 'round-robin', profiles: [
  { id: 'codex-a', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'], concurrency: 1 },
  { id: 'codex-b', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'], concurrency: 1 },
  { id: 'claude-big', provider: 'claude', bin: 'claude', model: 'claude-3-5-sonnet', capabilities: ['analysis'], contextWindow: 1_000_000 },
], defaults: { cooldownMs: 1000 } };

test('scoring rewards capability match, coder bonus, big-context analysis', () => {
  assert.equal(scoreProfileForTask(cfg.profiles[0], 'code'), 15);     // 10 cap + 5 codex
  assert.equal(scoreProfileForTask(cfg.profiles[2], 'analysis'), 12); // 10 cap + 2 ctx
  assert.equal(scoreProfileForTask(cfg.profiles[2], 'code'), 0);
});

test('LRU tie-break rotates equally-scored profiles', () => {
  let t = 1000; const pool = new CliPool(cfg, () => t);
  const first = pool.listAvailable('code')[0].id;   // both codex tie → lastUsedAt 0 → array order
  pool.markUsed(first); t = 1001;
  const second = pool.listAvailable('code')[0].id;
  assert.notEqual(first, second);                   // the other codex now leads (older lastUsedAt)
});

test('cooldown removes a profile until it expires', () => {
  let t = 1000; const pool = new CliPool(cfg, () => t);
  pool.markCooldown('codex-a', 500);
  assert.deepEqual(pool.listAvailable('code').map(p => p.id), ['codex-b']);
  t = 1600;
  assert.equal(pool.listAvailable('code').length, 2);
});

test('auth-blocked is sticky (does not expire on a timer)', () => {
  let t = 1000; const pool = new CliPool(cfg, () => t);
  pool.markAuthBlocked('codex-a'); t = 999999;
  assert.deepEqual(pool.listAvailable('code').map(p => p.id), ['codex-b']);
});

test('concurrency cap excludes in-flight profiles', () => {
  const pool = new CliPool(cfg, () => 1000);
  pool.acquire('codex-a'); pool.acquire('codex-b');
  assert.deepEqual(pool.listAvailable('code'), []);
  pool.release('codex-a');
  assert.deepEqual(pool.listAvailable('code').map(p => p.id), ['codex-a']);
});

test('tieBreak first-loaded keeps config order (no rotation)', () => {
  const cfg: CliConfig = { tieBreak: 'first-loaded', profiles: [
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
  ]};
  let t = 1000; const pool = new CliPool(cfg, () => t);
  const first = pool.listAvailable('chat')[0].id; pool.markUsed(first); t = 1001;
  assert.equal(pool.listAvailable('chat')[0].id, first);            // does NOT rotate
});
test('tieBreak round-robin rotates by LRU', () => {
  const cfg: CliConfig = { tieBreak: 'round-robin', profiles: [
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
  ]};
  let t = 1000; const pool = new CliPool(cfg, () => t);
  const first = pool.listAvailable('chat')[0].id; pool.markUsed(first); t = 1001;
  assert.notEqual(pool.listAvailable('chat')[0].id, first);         // rotates
});
test('omitted tieBreak defaults to first-loaded (no rotation)', () => {
  const cfg: CliConfig = { profiles: [   // NOTE: no tieBreak field
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
  ]};
  let t = 1000; const pool = new CliPool(cfg, () => t);
  const first = pool.listAvailable('chat')[0].id; pool.markUsed(first); t = 1001;
  assert.equal(pool.listAvailable('chat')[0].id, first);   // default = no rotation
});
test('explicit role match beats tie-break order', () => {
  const cfg: CliConfig = { tieBreak: 'first-loaded', profiles: [
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'claude', bin: 'claude', model: 'm', capabilities: ['chat'], roles: ['analysis'] },
  ]};
  const pool = new CliPool(cfg, () => 1000);
  assert.equal(pool.listAvailable('chat', 'analysis')[0].id, 'b');  // role wins
});

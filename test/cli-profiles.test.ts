import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliConfig, profileToModelInfo } from '../src/backends/cli/profiles.js';

test('parses a valid config', () => {
  const cfg = parseCliConfig({ profiles: [
    { id: 'codex-a', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'] },
  ]});
  assert.equal(cfg.profiles.length, 1);
  assert.equal(cfg.profiles[0].enabled, true); // defaulted
});

test('rejects missing required fields', () => {
  assert.throws(() => parseCliConfig({ profiles: [{ id: 'x', provider: 'codex' }] }), /bin|model/);
});

test('rejects duplicate ids', () => {
  assert.throws(() => parseCliConfig({ profiles: [
    { id: 'a', provider: 'llm', bin: 'llm', model: 'm', capabilities: [] },
    { id: 'a', provider: 'llm', bin: 'llm', model: 'm', capabilities: [] },
  ]}), /duplicate/i);
});

test('rejects unknown provider', () => {
  assert.throws(() => parseCliConfig({ profiles: [
    { id: 'a', provider: 'bogus', bin: 'x', model: 'm', capabilities: [] },
  ]}), /provider/i);
});

test('profileToModelInfo maps capabilities and availability', () => {
  const mi = profileToModelInfo(
    { id: 'codex-a', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'], contextWindow: 256000 },
    false,
  );
  assert.equal(mi.id, 'codex-a');
  assert.equal(mi.state, 'not-loaded');
  assert.equal(mi.context_length, 256000);
});

// --- Validation gap fixes ---

test('rejects null profile entry', () => {
  assert.throws(
    () => parseCliConfig({ profiles: [null] }),
    /must be an object/,
  );
});

test('rejects capabilities present but not an array', () => {
  assert.throws(
    () => parseCliConfig({ profiles: [{ id: 'a', provider: 'llm', bin: 'llm', model: 'm', capabilities: 'code' }] }),
    /capabilities/,
  );
});

test('rejects contextWindow present with wrong type', () => {
  assert.throws(
    () => parseCliConfig({ profiles: [{ id: 'a', provider: 'llm', bin: 'llm', model: 'm', capabilities: [], contextWindow: 'big' }] }),
    /contextWindow/,
  );
});

test('absent capabilities defaults to [] without throwing', () => {
  const cfg = parseCliConfig({ profiles: [{ id: 'a', provider: 'llm', bin: 'llm', model: 'm' }] });
  assert.deepEqual(cfg.profiles[0].capabilities, []);
});

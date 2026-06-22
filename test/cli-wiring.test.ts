import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliBackend } from '../src/backends/cli/index.js';
import { parseCliConfig } from '../src/backends/cli/profiles.js';

// Pure wiring check: a config drives a backend whose listModels reflects profiles.
test('parseCliConfig → CliBackend.listModels round-trip', async () => {
  const cfg = parseCliConfig({ profiles: [{ id: 'p1', provider: 'llm', bin: 'llm', model: 'm', capabilities: ['chat'] }] });
  const be = new CliBackend(cfg, { now: () => 1 });
  const m = await be.listModels();
  assert.equal(m[0].id, 'p1');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseCli } from '../src/backends/cli/activation.js';

test('unset backend never activates CLI even with a config (backward compat)', () => {
  assert.equal(shouldUseCli('', '/some/config.json'), false);
});
test('openai-compat never activates CLI', () => {
  assert.equal(shouldUseCli('openai-compat', '/some/config.json'), false);
});
test('cli activates (config presence enforced by caller)', () => {
  assert.equal(shouldUseCli('cli', ''), true);
  assert.equal(shouldUseCli('cli', '/c.json'), true);
});
test('auto activates only with a config', () => {
  assert.equal(shouldUseCli('auto', ''), false);
  assert.equal(shouldUseCli('auto', '/c.json'), true);
});

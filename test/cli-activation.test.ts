import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseCli, resolveOverride } from '../src/backends/cli/activation.js';

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

// resolveOverride
test('resolveOverride: per-call model wins and overridden=true', () => {
  const r = resolveOverride('my-model', 'env-profile', 'lm-default');
  assert.equal(r.pinned, 'my-model');
  assert.equal(r.overridden, true);
});
test('resolveOverride: envProfile used when no per-call, overridden=true', () => {
  const r = resolveOverride(undefined, 'env-profile', 'lm-default');
  assert.equal(r.pinned, 'env-profile');
  assert.equal(r.overridden, true);
});
test('resolveOverride: lmModel used as soft default, overridden=false', () => {
  const r = resolveOverride(undefined, '', 'lm-default');
  assert.equal(r.pinned, 'lm-default');
  assert.equal(r.overridden, false);
});
test('resolveOverride: all empty → pinned empty, overridden false', () => {
  const r = resolveOverride(undefined, '', '');
  assert.equal(r.pinned, '');
  assert.equal(r.overridden, false);
});

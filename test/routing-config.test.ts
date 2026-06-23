import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutingConfig, evalEscalate, describeRules, DEFAULT_ROUTING_CONFIG } from '../src/backends/routing-config.js';
const sig = (o = {}) => ({ taskType: undefined, tool: undefined, inputChars: 0, fileCount: 0, ...o });

test('default: code_task_files >=2 files escalates', () => {
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ tool: 'code_task_files', fileCount: 2 })), true);
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ tool: 'code_task_files', fileCount: 1 })), false);
});
test('default: input >=28000 chars escalates', () => {
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ inputChars: 28000 })), true);
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ inputChars: 27999 })), false);
});
test('default: analysis >=12000 escalates; small analysis local', () => {
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ taskType: 'analysis', inputChars: 12000 })), true);
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ taskType: 'analysis', inputChars: 5000 })), false);
});
test('minInputTokens compares chars/4', () => {
  const cfg = parseRoutingConfig({ escalateToCliWhen: [{ minInputTokens: 1000 }], default: 'local' });
  assert.equal(evalEscalate(cfg, sig({ inputChars: 4000 })), true);
  assert.equal(evalEscalate(cfg, sig({ inputChars: 3996 })), false);
});
test('AND within a rule, OR across rules', () => {
  const cfg = parseRoutingConfig({ escalateToCliWhen: [{ taskType: 'code', minInputChars: 100 }], default: 'local' });
  assert.equal(evalEscalate(cfg, sig({ taskType: 'code', inputChars: 100 })), true);
  assert.equal(evalEscalate(cfg, sig({ taskType: 'code', inputChars: 50 })), false);
  assert.equal(evalEscalate(cfg, sig({ taskType: 'chat', inputChars: 9999 })), false);
});
test('parse rejects bad default / non-array rules', () => {
  assert.throws(() => parseRoutingConfig({ escalateToCliWhen: [], default: 'bogus' }), /default/);
  assert.throws(() => parseRoutingConfig({ escalateToCliWhen: {}, default: 'local' }), /escalateToCliWhen/);
});
test('describeRules is readable', () => { assert.match(describeRules(DEFAULT_ROUTING_CONFIG), /code_task_files/); });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/backends/router.js';
import { DEFAULT_ROUTING_CONFIG } from '../src/backends/routing-config.js';
import type { InferenceBackend } from '../src/types.js';
const be = (name: string): InferenceBackend => ({ name,
  async chat() { return { content: name, rawContent: name, model: name, finishReason: 'stop', truncated: false, generationMs: 1 }; },
  async listModels() { return [{ id: `${name}-m` }]; }, async embed() { return { model: name, data: [] }; } });
test('grounded defaults: code_task_files(3) → cli, small chat → local', async () => {
  const r = new Router({ local: be('local'), cli: be('cli') }, DEFAULT_ROUTING_CONFIG);
  assert.equal((await r.chat([{ role: 'user', content: 'x' }], { tool: 'code_task_files', taskType: 'code', fileCount: 3 })).content, 'cli');
  assert.equal((await r.chat([{ role: 'user', content: 'hi' }], { tool: 'chat', taskType: 'chat' })).content, 'local');
});

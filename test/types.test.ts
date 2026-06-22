import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InferenceBackend, ChatMessage, StreamingResult, ModelInfo } from '../src/types.js';

test('a minimal object can satisfy InferenceBackend', async () => {
  const fake: InferenceBackend = {
    name: 'fake',
    async chat(_messages: ChatMessage[]): Promise<StreamingResult> {
      return { content: 'hi', rawContent: 'hi', model: 'm', finishReason: 'stop', truncated: false, generationMs: 1 };
    },
    async listModels(): Promise<ModelInfo[]> { return [{ id: 'm' }]; },
  };
  const out = await fake.chat([{ role: 'user', content: 'x' }], {});
  assert.equal(out.content, 'hi');
  const models = await fake.listModels();
  assert.equal(models[0].id, 'm');
});

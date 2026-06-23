import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/backends/router.js';
import type { InferenceBackend, ChatMessage, ChatOptions, StreamingResult, ModelInfo } from '../src/types.js';
function fake(name: string): InferenceBackend {
  return {
    name,
    async chat(_m: ChatMessage[], _o: ChatOptions): Promise<StreamingResult> {
      return { content: name, rawContent: name, model: name, finishReason: 'stop', truncated: false, generationMs: 1 };
    },
    async listModels(): Promise<ModelInfo[]> { return [{ id: `${name}-m` }]; },
    async embed() { return { model: name, data: [] }; },
  };
}
const cfg = { escalateToCliWhen: [{ minInputChars: 100 }], default: 'local' as const };
const msg = (n: number): ChatMessage[] => [{ role: 'user', content: 'x'.repeat(n) }];

test('exact override → backend owning the id (no rules)', async () => {
  const r = new Router({ local: fake('local'), cli: fake('cli'), cliHasProfile: (id) => id === 'codex-a' }, cfg);
  assert.equal((await r.chat(msg(9999), { overridden: true, model: 'codex-a' })).content, 'cli');
  assert.equal((await r.chat(msg(9999), { overridden: true, model: 'gpt-oss' })).content, 'local');
});
test('tier:cli wins over rules; tier:local forces local', async () => {
  const r = new Router({ local: fake('local'), cli: fake('cli') }, cfg);
  assert.equal((await r.chat(msg(5), { tier: 'cli' })).content, 'cli');
  assert.equal((await r.chat(msg(9999), { tier: 'local' })).content, 'local');
});
test('no directive → rules decide', async () => {
  const r = new Router({ local: fake('local'), cli: fake('cli') }, cfg);
  assert.equal((await r.chat(msg(100), {})).content, 'cli');
  assert.equal((await r.chat(msg(50), {})).content, 'local');
});
test('embed always local; tier:cli with no cli → local', async () => {
  assert.equal((await new Router({ local: fake('local'), cli: fake('cli') }, cfg).chat(msg(9999), { tool: 'embed' })).content, 'local');
  assert.equal((await new Router({ local: fake('local') }, cfg).chat(msg(9999), { tier: 'cli' })).content, 'local');
});
test('listModels merges + tags tier', async () => {
  const models = await new Router({ local: fake('local'), cli: fake('cli') }, cfg).listModels();
  assert.deepEqual(models.map((m) => [m.id, m.tier]).sort(), [['cli-m', 'cli'], ['local-m', 'local']]);
});

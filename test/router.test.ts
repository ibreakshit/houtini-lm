import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router, formatRouterTopology } from '../src/backends/router.js';
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
test('chat tags the resolved tier on the result (incl. rule escalation)', async () => {
  const r = new Router({ local: fake('local'), cli: fake('cli') }, cfg);
  assert.equal((await r.chat(msg(5), { tier: 'cli' })).tier, 'cli');   // explicit directive
  assert.equal((await r.chat(msg(50), {})).tier, 'local');             // rules → local
  assert.equal((await r.chat(msg(100), {})).tier, 'cli');              // rules escalate → cli
});
test('listModels merges + tags tier', async () => {
  const models = await new Router({ local: fake('local'), cli: fake('cli') }, cfg).listModels();
  assert.deepEqual(models.map((m) => [m.id, m.tier]).sort(), [['cli-m', 'cli'], ['local-m', 'local']]);
});

// ── routeTier tests ─────────────────────────────────────────────────────────
test('routeTier: large code_task_files signal → cli under default config', () => {
  const r = new Router({ local: fake('local'), cli: fake('cli') }, cfg);
  // 3 files + large input chars → escalate rule fires
  const tier = r.routeTier(msg(200), { tool: 'code_task_files', taskType: 'code', fileCount: 3 });
  assert.equal(tier, 'cli');
});
test('routeTier: small chat signal → local', () => {
  const r = new Router({ local: fake('local'), cli: fake('cli') }, cfg);
  assert.equal(r.routeTier(msg(10), { tool: 'chat', taskType: 'chat' }), 'local');
});
test('routeTier: tier:cli explicit → cli', () => {
  const r = new Router({ local: fake('local'), cli: fake('cli') }, cfg);
  assert.equal(r.routeTier(msg(5), { tier: 'cli' }), 'cli');
});
test('routeTier: tier:cli but no CLI → local', () => {
  const r = new Router({ local: fake('local') }, cfg);
  assert.equal(r.routeTier(msg(9999), { tier: 'cli' }), 'local');
});

// ── formatRouterTopology tests ───────────────────────────────────────────────
test('formatRouterTopology: groups by tier, all ids present', () => {
  const models: ModelInfo[] = [
    { id: 'local-a', tier: 'local' },
    { id: 'local-b', tier: 'local' },
    { id: 'cli-x', tier: 'cli' },
  ];
  const out = formatRouterTopology(models, 'rules here');
  assert.ok(out.includes('local: local-a, local-b'), `missing local ids: ${out}`);
  assert.ok(out.includes('cli: cli-x'), `missing cli id: ${out}`);
  assert.ok(out.includes('rules here'), `missing routing summary: ${out}`);
});
test('formatRouterTopology: empty cli tier renders without ragged line', () => {
  const models: ModelInfo[] = [{ id: 'local-only', tier: 'local' }];
  const out = formatRouterTopology(models, 'summary');
  assert.ok(out.includes('cli: (none)'), `should show (none) for empty cli: ${out}`);
  assert.ok(out.includes('local: local-only'), `missing local id: ${out}`);
});
test('formatRouterTopology: routing summary is included verbatim', () => {
  const models: ModelInfo[] = [{ id: 'x', tier: 'local' }];
  const summary = 'escalate when fileCount >= 3 AND inputChars >= 4000\nCaller guidance line';
  const out = formatRouterTopology(models, summary);
  assert.ok(out.includes(summary), `summary not in output: ${out}`);
});

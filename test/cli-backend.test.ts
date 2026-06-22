import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CliBackend } from '../src/backends/cli/index.js';
import type { CliConfig } from '../src/backends/cli/profiles.js';
import type { ProcessResult } from '../src/backends/cli/exec.js';

const cfg: CliConfig = { profiles: [
  { id: 'cl-a', provider: 'claude', bin: 'claude', model: 'sonnet', capabilities: ['chat'], concurrency: 1 },
  { id: 'cl-b', provider: 'claude', bin: 'claude', model: 'sonnet', capabilities: ['chat'], concurrency: 1 },
], defaults: { cooldownMs: 1000 } };

const ok = (text: string): ProcessResult => ({ stdout: JSON.stringify({ result: text }), stderr: '', exitCode: 0, timedOut: false });
const rate = (): ProcessResult => ({ stdout: '', stderr: '429 rate limit', exitCode: 1, timedOut: false });
const authErr = (): ProcessResult => ({ stdout: '', stderr: '401 please login', exitCode: 1, timedOut: false });

test('chat runs the selected profile and returns content', async () => {
  const be = new CliBackend(cfg, { runProcessFn: async () => ok('answer'), now: () => 1000 });
  const r = await be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat' });
  assert.equal(r.content, 'answer');
});

test('failover: first profile rate-limited, second succeeds', async () => {
  let call = 0;
  const be = new CliBackend(cfg, { now: () => 1000, runProcessFn: async () => (++call === 1 ? rate() : ok('second')) });
  const r = await be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat' });
  assert.equal(r.content, 'second');
  assert.equal(call, 2);
});

test('explicit override does NOT fail over (D6) and surfaces the error', async () => {
  const be = new CliBackend(cfg, { now: () => 1000, runProcessFn: async () => rate() });
  await assert.rejects(
    be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat', model: 'cl-a', overridden: true }),
    /rate|429/i,
  );
});

test('auth error marks profile auth-blocked and fires webhook', async () => {
  const alerts: unknown[] = [];
  const fetchFn = (async (_u: string, init: { body: string }) => { alerts.push(JSON.parse(init.body)); return { ok: true } as Response; }) as unknown as typeof fetch;
  let call = 0;
  const be = new CliBackend(cfg, {
    now: () => 1000, alertWebhook: 'http://hook', fetchFn,
    runProcessFn: async () => (++call === 1 ? authErr() : ok('recovered')),
  });
  const r = await be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat' });
  assert.equal(r.content, 'recovered');
  assert.equal((alerts[0] as { kind: string }).kind, 'auth');
  // auth-blocked is sticky: listModels shows cl-a not-loaded
  const m = await be.listModels();
  assert.equal(m.find((x) => x.id === 'cl-a')?.state, 'not-loaded');
});

test('listModels returns all profiles as ModelInfo', async () => {
  const be = new CliBackend(cfg, { now: () => 1000 });
  const m = await be.listModels();
  assert.equal(m.length, 2);
});

test('runOnce writes schema file before spawn when responseFormat.json_schema is set', async () => {
  const schema = { type: 'object', additionalProperties: false, properties: { answer: { type: 'number' } }, required: ['answer'] };
  const codexCfg: CliConfig = { profiles: [
    { id: 'cx-a', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code', 'chat'], concurrency: 1 },
  ] };
  const codexStdout = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":391}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3,"reasoning_output_tokens":0}}',
  ].join('\n');

  let capturedSchemaPath: string | undefined;
  let capturedSchemaContent: Record<string, unknown> | undefined;
  let schemaExistsAtCallTime = false;
  const be = new CliBackend(codexCfg, {
    now: () => 1000,
    runProcessFn: async (argv) => {
      const idx = argv.indexOf('--output-schema');
      if (idx !== -1) {
        capturedSchemaPath = argv[idx + 1];
        schemaExistsAtCallTime = existsSync(capturedSchemaPath);
        capturedSchemaContent = JSON.parse(readFileSync(capturedSchemaPath, 'utf8')) as Record<string, unknown>;
      }
      return { stdout: codexStdout, stderr: '', exitCode: 0, timedOut: false };
    },
  });

  const r = await be.chat(
    [{ role: 'user', content: 'q' }],
    { taskType: 'chat', responseFormat: { type: 'json_schema', json_schema: { name: 'r', schema } } },
  );
  assert.equal(r.content, '{"answer":391}');
  assert.ok(capturedSchemaContent !== undefined, 'schema file should have been written before spawn');
  assert.deepEqual(capturedSchemaContent, schema);
  assert.ok(schemaExistsAtCallTime, 'schema file must exist at the moment the process is spawned');
  // Verify the temp dir (parent of schema path) was cleaned up by the finally block
  assert.ok(capturedSchemaPath !== undefined, 'schema path must have been captured');
  const { dirname } = await import('node:path');
  assert.ok(!existsSync(dirname(capturedSchemaPath!)), 'temp dir must be cleaned up after chat() resolves');
});

test('pre-run error (unknown provider) releases the pool slot — no leak', async () => {
  const cfg = { profiles: [{ id: 'bad', provider: 'bogus', bin: 'x', model: 'm', capabilities: ['chat'], concurrency: 1 }] } as any;
  const be = new CliBackend(cfg, { now: () => 1, runProcessFn: async () => ({ stdout: '{"result":"x"}', stderr: '', exitCode: 0, timedOut: false }) });
  await assert.rejects(be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat', model: 'bad', overridden: true }));
  const m = await be.listModels();
  assert.equal(m.find((x) => x.id === 'bad')?.state, 'loaded'); // slot released, not leaked
});

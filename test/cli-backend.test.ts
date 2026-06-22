import { test } from 'node:test';
import assert from 'node:assert/strict';
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

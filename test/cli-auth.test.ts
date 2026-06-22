import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliBackend } from '../src/backends/cli/index.js';
import type { CliConfig } from '../src/backends/cli/profiles.js';
import type { ProcessResult } from '../src/backends/cli/exec.js';

const cfg: CliConfig = { profiles: [
  { id: 'only', provider: 'gemini', bin: 'gemini', model: 'gemini-2.5-pro', capabilities: ['chat'] },
]};
const authErr = (): ProcessResult => ({ stdout: '', stderr: '403 invalid api key', exitCode: 1, timedOut: false });

test('single-profile auth failure: blocked, alerted, then unavailable', async () => {
  const alerts: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_u: string, init: { body: string }) => { alerts.push(JSON.parse(init.body)); return { ok: true } as Response; }) as unknown as typeof fetch;
  const be = new CliBackend(cfg, { now: () => 5, alertWebhook: 'http://hook', fetchFn, runProcessFn: async () => authErr() });
  await assert.rejects(be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat' }), /No available|auth/i);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'auth');
  assert.equal(alerts[0].provider, 'gemini');
  const m = await be.listModels();
  assert.equal(m[0].state, 'not-loaded');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliBackend } from '../src/backends/cli/index.js';
import type { CliConfig } from '../src/backends/cli/profiles.js';
import type { ProcessResult } from '../src/backends/cli/exec.js';

const cfg: CliConfig = { profiles: [
  { id: 'only', provider: 'claude', bin: 'claude', model: 'claude-sonnet', capabilities: ['chat'] },
]};
const authErr = (): ProcessResult => ({ stdout: '', stderr: '403 invalid api key', exitCode: 1, timedOut: false });

test('single-profile auth failure: blocked, alerted, then unavailable', async () => {
  const alerts: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_u: string, init: { body: string }) => { alerts.push(JSON.parse(init.body)); return { ok: true } as Response; }) as unknown as typeof fetch;
  const be = new CliBackend(cfg, { now: () => 5, alertWebhook: 'http://hook', fetchFn, runProcessFn: async () => authErr() });
  await assert.rejects(be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat' }), /No available|auth/i);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'auth');
  assert.equal(alerts[0].provider, 'claude');
  const m = await be.listModels();
  assert.equal(m[0].state, 'not-loaded');
});

test('explicit override auth failure: rejects, fires alert webhook, sticky auth-block recorded', async () => {
  const alerts: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_u: string, init: { body: string }) => { alerts.push(JSON.parse(init.body)); return { ok: true } as Response; }) as unknown as typeof fetch;
  const be = new CliBackend(cfg, { now: () => 42, alertWebhook: 'http://hook', fetchFn, runProcessFn: async () => authErr() });
  // overridden:true with a known profile id — no failover, but side effects must still fire
  await assert.rejects(
    be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat', overridden: true, model: 'only' }),
    /auth/i,
  );
  assert.equal(alerts.length, 1, 'alert webhook should have fired once');
  assert.equal(alerts[0].kind, 'auth');
  const m = await be.listModels();
  assert.equal(m[0].state, 'not-loaded', 'profile should be sticky auth-blocked after override failure');
});

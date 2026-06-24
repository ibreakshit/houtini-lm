import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate: point the DB at a throwaway dir BEFORE importing the module, since
// model-cache resolves DB_DIR from HOUTINI_LM_HOME at module load. This keeps
// the real ~/.houtini-lm/model-cache.db untouched.
process.env.HOUTINI_LM_HOME = mkdtempSync(join(tmpdir(), 'houtini-telemetry-'));
process.env.HOUTINI_LM_TELEMETRY = '1';

const { recordCall, getRecentCalls, getUsageSummary, initDb } = await import('../src/model-cache.js');

beforeEach(async () => {
  const database = await initDb();
  database.run('DELETE FROM call_log');
});

test('recordCall persists a row with the call fields', async () => {
  await recordCall({
    modelId: 'gpt-5.5',
    tier: 'cli',
    tool: 'chat',
    promptTokens: 1000,
    completionTokens: 200,
    reasoningTokens: 50,
    ttftMs: 800,
    tokPerSec: 42,
  });

  const rows = await getRecentCalls(10);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.modelId, 'gpt-5.5');
  assert.equal(r.tier, 'cli');
  assert.equal(r.tool, 'chat');
  assert.equal(r.promptTokens, 1000);
  assert.equal(r.completionTokens, 200);
  assert.equal(r.reasoningTokens, 50);
  assert.equal(r.ttftMs, 800);
  assert.equal(r.ok, true);
});

test('tokensSaved equals prompt + completion', async () => {
  await recordCall({ modelId: 'gpt-oss-120b', promptTokens: 1500, completionTokens: 320 });
  const [r] = await getRecentCalls(1);
  assert.equal(r.tokensSaved, 1820);
});

test('records a failed call with ok=0 and zero tokens', async () => {
  await recordCall({ modelId: 'm', promptTokens: 0, completionTokens: 0, ok: false });
  const [r] = await getRecentCalls(1);
  assert.equal(r.ok, false);
  assert.equal(r.tokensSaved, 0);
});

test('recordCall prunes to HOUTINI_LM_TELEMETRY_MAX, keeping newest', async () => {
  process.env.HOUTINI_LM_TELEMETRY_MAX = '3';
  try {
    for (let i = 1; i <= 5; i++) {
      await recordCall({ modelId: 'm', promptTokens: i, completionTokens: 0 });
    }
  } finally {
    delete process.env.HOUTINI_LM_TELEMETRY_MAX;
  }
  const rows = await getRecentCalls(100);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.promptTokens), [5, 4, 3]);
});

test('getUsageSummary aggregates calls + tokensSaved by tier and tool', async () => {
  await recordCall({ modelId: 'a', tier: 'local', tool: 'chat', promptTokens: 100, completionTokens: 10 });
  await recordCall({ modelId: 'b', tier: 'cli', tool: 'code_task', promptTokens: 200, completionTokens: 20 });
  await recordCall({ modelId: 'c', tier: 'cli', tool: 'chat', promptTokens: 300, completionTokens: 30 });

  const summary = await getUsageSummary();
  assert.equal(summary.totalCalls, 3);
  assert.equal(summary.totalTokensSaved, 660);

  const cli = summary.byTier.find((t) => t.tier === 'cli');
  assert.equal(cli?.calls, 2);
  assert.equal(cli?.tokensSaved, 550);

  const chat = summary.byTool.find((t) => t.tool === 'chat');
  assert.equal(chat?.calls, 2);
  assert.equal(chat?.tokensSaved, 440);
});

test('recordCall is a no-op when HOUTINI_LM_TELEMETRY=0', async () => {
  process.env.HOUTINI_LM_TELEMETRY = '0';
  try {
    await recordCall({ modelId: 'x', promptTokens: 9, completionTokens: 9 });
  } finally {
    process.env.HOUTINI_LM_TELEMETRY = '1';
  }
  assert.equal((await getRecentCalls(10)).length, 0);
});

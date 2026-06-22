import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter } from '../src/backends/cli/adapters/index.js';
import type { CliProfile } from '../src/backends/cli/profiles.js';

const codexP: CliProfile = { id: 'cx', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'], configHome: '/tmp/cx' };
const claudeP: CliProfile = { id: 'cl', provider: 'claude', bin: 'claude', model: 'sonnet', capabilities: ['chat'], configHome: '/tmp/cl' };
const gemP: CliProfile = { id: 'gm', provider: 'gemini', bin: 'gemini', model: 'gemini-2.5-pro', capabilities: ['analysis'] };

test('codex builds a read-only non-interactive exec invocation with CODEX_HOME and outFile', () => {
  const inv = getAdapter('codex').buildInvocation(codexP, 'hi', {}, '/tmp/out.txt');
  assert.deepEqual(inv.argv.slice(0, 2), ['codex', 'exec']);
  assert.ok(inv.argv.includes('--skip-git-repo-check'));
  assert.ok(inv.argv.includes('read-only'));   // -s read-only
  assert.ok(!inv.argv.includes('-a'));         // no approval flag (codex exec has no -a)
  assert.equal(inv.env.CODEX_HOME, '/tmp/cx');
  assert.equal(inv.outFile, '/tmp/out.txt');
  assert.equal(inv.stdin, 'hi');
});

test('codex parseOutput prefers outFileContent', () => {
  const out = getAdapter('codex').parseOutput({ stdout: 'noise', stderr: '', exitCode: 0, timedOut: false, outFileContent: 'final answer' });
  assert.equal(out.content, 'final answer');
});

test('claude builds -p json invocation with CLAUDE_CONFIG_DIR, plan lockdown, and parses result', () => {
  const a = getAdapter('claude');
  const inv = a.buildInvocation(claudeP, 'hi', {}, '/tmp/o');
  assert.ok(inv.argv.includes('-p'));
  assert.ok(inv.argv.includes('--output-format') && inv.argv.includes('json'));
  assert.ok(inv.argv.includes('--permission-mode') && inv.argv.includes('plan'));  // read-only plan mode
  assert.equal(inv.env.CLAUDE_CONFIG_DIR, '/tmp/cl');
  const out = a.parseOutput({ stdout: JSON.stringify({ result: 'A', usage: { input_tokens: 3, output_tokens: 5 } }), stderr: '', exitCode: 0, timedOut: false });
  assert.equal(out.content, 'A');
  assert.equal(out.usage?.prompt_tokens, 3);
});

test('gemini builds invocation with read-only approval-mode plan', () => {
  const inv = getAdapter('gemini').buildInvocation(gemP, 'hi', {}, '/tmp/o');
  assert.ok(inv.argv.includes('--approval-mode') && inv.argv.includes('plan'));
});

test('gemini parses JSON response text', () => {
  const out = getAdapter('gemini').parseOutput({ stdout: JSON.stringify({ response: 'G' }), stderr: '', exitCode: 0, timedOut: false });
  assert.equal(out.content, 'G');
});

test('classifyError detects auth and rate-limit from stderr', () => {
  const a = getAdapter('codex');
  assert.equal(a.classifyError({ stdout: '', stderr: '401 Unauthorized: please login', exitCode: 1, timedOut: false }), 'auth');
  assert.equal(a.classifyError({ stdout: '', stderr: 'Error: 429 rate limit exceeded', exitCode: 1, timedOut: false }), 'rate');
  assert.equal(a.classifyError({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }), 'ok');
  assert.equal(a.classifyError({ stdout: '', stderr: 'api key not valid', exitCode: 1, timedOut: false }), 'auth');
  assert.equal(a.classifyError({ stdout: '', stderr: 'invalid credentials provided', exitCode: 1, timedOut: false }), 'auth');
});

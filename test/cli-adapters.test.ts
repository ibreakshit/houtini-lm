import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter } from '../src/backends/cli/adapters/index.js';
import { classifyByText } from '../src/backends/cli/adapters/types.js';
import type { CliProfile } from '../src/backends/cli/profiles.js';

const codexP: CliProfile = { id: 'cx', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'], configHome: '/tmp/cx' };
const claudeP: CliProfile = { id: 'cl', provider: 'claude', bin: 'claude', model: 'sonnet', capabilities: ['chat'], configHome: '/tmp/cl' };

test('codex builds a read-only non-interactive exec invocation with --json and CODEX_HOME', () => {
  const inv = getAdapter('codex').buildInvocation(codexP, 'hi', {}, '/tmp/out.txt');
  assert.ok(inv.argv.includes('exec'));
  assert.ok(inv.argv.includes('--skip-git-repo-check'));
  assert.ok(inv.argv.includes('read-only'));   // -s read-only
  assert.ok(inv.argv.includes('--json'));
  assert.ok(inv.argv.includes('-m'));
  assert.ok(inv.argv.includes(codexP.model));
  assert.ok(!inv.argv.includes('-a'));         // no approval flag (codex exec has no -a)
  assert.ok(!inv.argv.includes('-o'));         // no outFile flag
  assert.equal(inv.outFile, undefined);
  assert.equal(inv.env.CODEX_HOME, '/tmp/cx');
  assert.equal(inv.stdin, 'hi');
  // no schema — schemaFile must be absent
  assert.equal(inv.schemaFile, undefined);
  assert.ok(!inv.argv.includes('--output-schema'));
});

test('codex buildInvocation with json_schema adds --output-schema and schemaFile', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { answer: { type: 'number' } }, required: ['answer'] };
  const inv = getAdapter('codex').buildInvocation(
    codexP, 'hi',
    { responseFormat: { type: 'json_schema', json_schema: { name: 'r', schema } } },
    '/tmp/x.json',
  );
  assert.ok(inv.argv.includes('--json'));
  assert.ok(inv.argv.includes('--output-schema'));
  assert.ok(inv.argv.includes('/tmp/x.json'));
  assert.ok(inv.schemaFile !== undefined);
  assert.deepEqual(JSON.parse(inv.schemaFile!.content), schema);
});

test('codex parseOutput parses JSONL --json output for content and usage', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"391"}}',
    '{"type":"turn.completed","usage":{"input_tokens":12739,"cached_input_tokens":2432,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join('\n');
  const out = getAdapter('codex').parseOutput({ stdout, stderr: '', exitCode: 0, timedOut: false });
  assert.equal(out.content, '391');
  assert.equal(out.usage.prompt_tokens, 12739);
  assert.equal(out.usage.completion_tokens, 5);
  assert.equal(out.usage.total_tokens, 12744);
});

test('claude builds -p json invocation with CLAUDE_CONFIG_DIR, plan lockdown, and parses result', () => {
  const a = getAdapter('claude');
  const inv = a.buildInvocation(claudeP, 'hi', {}, '/tmp/o');
  assert.ok(inv.argv.includes('-p'));
  assert.ok(inv.argv.includes('--output-format') && inv.argv.includes('json'));
  assert.ok(inv.argv.includes('--permission-mode') && inv.argv.includes('plan'));  // read-only plan mode
  assert.ok(inv.argv.includes('--disallowed-tools'));  // no tools at all
  // verify the core built-in tools are explicitly disallowed
  for (const t of ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task']) {
    assert.ok(inv.argv.includes(t), `expected ${t} in --disallowed-tools list`);
  }
  assert.equal(inv.env.CLAUDE_CONFIG_DIR, '/tmp/cl');
  const out = a.parseOutput({ stdout: JSON.stringify({ result: 'A', usage: { input_tokens: 3, output_tokens: 5 } }), stderr: '', exitCode: 0, timedOut: false });
  assert.equal(out.content, 'A');
  assert.equal(out.usage?.prompt_tokens, 3);
});


test('classifyError detects auth and rate-limit from stderr', () => {
  const a = getAdapter('codex');
  assert.equal(a.classifyError({ stdout: '', stderr: '401 Unauthorized: please login', exitCode: 1, timedOut: false }), 'auth');
  assert.equal(a.classifyError({ stdout: '', stderr: 'Error: 429 rate limit exceeded', exitCode: 1, timedOut: false }), 'rate');
  assert.equal(a.classifyError({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }), 'ok');
  assert.equal(a.classifyError({ stdout: '', stderr: 'api key not valid', exitCode: 1, timedOut: false }), 'auth');
  assert.equal(a.classifyError({ stdout: '', stderr: 'invalid credentials provided', exitCode: 1, timedOut: false }), 'auth');
});

test('classifyByText auth/rate patterns (narrowed: no forbidden/access-denied/permission-denied)', () => {
  const make = (stderr: string, exitCode = 1) => ({ stdout: '', stderr, exitCode, timedOut: false as const });
  // auth: unambiguous phrases still → auth
  assert.equal(classifyByText(make('Authentication Failed')), 'auth');
  assert.equal(classifyByText(make('not authenticated')), 'auth');
  assert.equal(classifyByText(make('expired token')), 'auth');
  assert.equal(classifyByText(make('expired credential')), 'auth');
  // narrowed: these must NOT classify as auth (benign filesystem errors)
  assert.equal(classifyByText(make('permission denied')), 'error');
  assert.equal(classifyByText(make('Forbidden')), 'error');
  assert.equal(classifyByText(make('Access Denied to resource')), 'error');
  // rate: codeless phrase cases
  assert.equal(classifyByText(make('resource exhausted')), 'rate');
  assert.equal(classifyByText(make('usage limit exceeded')), 'rate');
  assert.equal(classifyByText(make('too many requests sent')), 'rate');
  // baseline: clean exit => ok
  assert.equal(classifyByText({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }), 'ok');
  // baseline: unrecognised error => error
  assert.equal(classifyByText(make('some other failure')), 'error');
});

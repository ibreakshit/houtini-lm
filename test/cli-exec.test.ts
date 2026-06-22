import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/backends/cli/exec.js';

test('captures stdout and exit code', async () => {
  const r = await runProcess([process.execPath, '-e', "process.stdout.write('hello')"]);
  assert.equal(r.stdout, 'hello');
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
});

test('feeds stdin', async () => {
  const r = await runProcess(
    [process.execPath, '-e', "process.stdin.on('data',d=>process.stdout.write(d))"],
    { stdin: 'piped-input' },
  );
  assert.match(r.stdout, /piped-input/);
});

test('times out and reports timedOut', async () => {
  const r = await runProcess([process.execPath, '-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
});

test('does not crash when child exits before consuming stdin', async () => {
  const r = await runProcess([process.execPath, '-e', 'process.exit(0)'], { stdin: 'x'.repeat(1_000_000) });
  assert.ok(r); // resolved, no unhandled EPIPE
  assert.equal(r.timedOut, false);
});

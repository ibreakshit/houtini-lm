import { spawn as realSpawn } from 'node:child_process';

export interface ProcessResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; }
export interface RunOptions {
  env?: Record<string, string>; stdin?: string; timeoutMs?: number; cwd?: string;
  spawnFn?: typeof realSpawn;
}

export function runProcess(argv: string[], opts: RunOptions = {}): Promise<ProcessResult> {
  const spawnFn = opts.spawnFn ?? realSpawn;
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawnFn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, done = false;
    const finish = (exitCode: number | null) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs) : undefined;
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { stderr += String(e); finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => { /* ignore EPIPE / ERR_STREAM_DESTROYED — child closed stdin early */ });
    if (opts.stdin !== undefined) { child.stdin?.write(opts.stdin); child.stdin?.end(); }
    else { child.stdin?.end(); }
  });
}

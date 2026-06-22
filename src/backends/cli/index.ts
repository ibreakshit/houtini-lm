import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InferenceBackend, ChatMessage, ChatOptions, StreamingResult, ModelInfo } from '../../types.js';
import type { CliConfig, CliProfile } from './profiles.js';
import { CliPool } from './pool.js';
import { getAdapter } from './adapters/index.js';
import { runProcess } from './exec.js';
import { sendAlert } from './alert.js';

export class CliError extends Error {
  constructor(public kind: 'auth' | 'rate' | 'timeout' | 'error', message: string) {
    super(message);
    this.name = 'CliError';
  }
}

function renderPrompt(messages: ChatMessage[]): string {
  return messages.map((m) => (m.role === 'system' ? `# System\n${m.content}` : m.content)).join('\n\n');
}

let tmpSeq = 0;
function tmpFilePath(): string { return join(tmpdir(), `houtini-cli-${process.pid}-${tmpSeq++}.txt`); }

export class CliBackend implements InferenceBackend {
  name = 'cli';
  private pool: CliPool;
  private runProcessFn: typeof runProcess;
  private fetchFn: typeof fetch;
  private now: () => number;
  private alertWebhook?: string;
  private timeoutMs: number;

  constructor(config: CliConfig, deps: {
    runProcessFn?: typeof runProcess;
    fetchFn?: typeof fetch;
    now?: () => number;
    alertWebhook?: string;
    timeoutMs?: number;
  } = {}) {
    this.now = deps.now ?? Date.now;
    this.pool = new CliPool(config, this.now);
    this.runProcessFn = deps.runProcessFn ?? runProcess;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.alertWebhook = deps.alertWebhook;
    this.timeoutMs = deps.timeoutMs ?? config.defaults?.timeoutMs ?? 180_000;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.pool.toModelInfos();
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<StreamingResult> {
    const prompt = renderPrompt(messages);
    const taskType = options.taskType ?? 'chat';

    // Spec D6: override is verbatim — run exactly that profile, no failover
    if (options.overridden && options.model) {
      const p = this.pool.get(options.model);
      if (!p) throw new CliError('error', `Unknown profile override: ${options.model}`);
      return this.runOnce(p, prompt, options);
    }

    const candidates = this.pool.listAvailable(taskType);
    if (candidates.length === 0) {
      throw new CliError('error', `No available CLI profiles for task "${taskType}"`);
    }

    let lastErr: unknown;
    for (const p of candidates) {
      try {
        return await this.runOnce(p, prompt, options);
      } catch (e) {
        lastErr = e;
        const kind = e instanceof CliError ? e.kind : 'error';
        if (kind === 'auth') {
          this.handleAuth(p);
          continue;
        }
        if (kind === 'rate' || kind === 'timeout') {
          this.pool.markCooldown(p.id);
          continue;
        }
        // 'error' kind: don't burn other accounts on a logic bug — surface immediately
        throw e;
      }
    }
    throw lastErr;
  }

  private handleAuth(p: CliProfile): void {
    this.pool.markAuthBlocked(p.id);
    process.stderr.write(`[houtini-lm][AUTH] profile "${p.id}" (${p.provider}) auth-blocked\n`);
    void sendAlert(
      this.alertWebhook,
      { profile: p.id, provider: p.provider, kind: 'auth', ts: this.now() },
      this.fetchFn,
    );
  }

  private async runOnce(p: CliProfile, prompt: string, options: ChatOptions): Promise<StreamingResult> {
    const start = this.now();
    this.pool.acquire(p.id);
    const adapter = getAdapter(p.provider);
    const outFile = tmpFilePath();
    const inv = adapter.buildInvocation(p, prompt, options, outFile);
    try {
      const result = await this.runProcessFn(inv.argv, {
        env: { ...process.env, ...inv.env } as Record<string, string>,
        stdin: inv.stdin,
        timeoutMs: this.timeoutMs,
      });
      if (result.timedOut) throw new CliError('timeout', `profile "${p.id}" timed out`);
      const kind = adapter.classifyError(result);
      if (kind === 'auth') throw new CliError('auth', `profile "${p.id}" auth error: ${result.stderr.slice(0, 200)}`);
      if (kind === 'rate') throw new CliError('rate', `profile "${p.id}" rate-limited`);
      if (kind === 'error') throw new CliError('error', `profile "${p.id}" failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
      let outFileContent: string | undefined;
      if (inv.outFile) {
        try { outFileContent = await readFile(inv.outFile, 'utf8'); } catch { /* none */ }
      }
      const parsed = adapter.parseOutput({ ...result, outFileContent });
      this.pool.markUsed(p.id);
      return {
        content: parsed.content,
        rawContent: parsed.content,
        model: p.model,
        usage: parsed.usage,
        finishReason: 'stop',
        truncated: false,
        generationMs: this.now() - start,
      };
    } finally {
      this.pool.release(p.id);
      if (inv.outFile) void rm(inv.outFile, { force: true }).catch(() => {});
    }
  }
}

import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText, homeEnv } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const geminiAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, _f: string): Invocation {
    return { argv: [p.bin, '-p', prompt, '-m', p.model, '--approval-mode', 'plan', '-o', 'json'], env: homeEnv(p) };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput {
    try {
      const j = JSON.parse(raw.stdout);
      const text = j.response ?? j.text ?? '';
      const um = j.usageMetadata ?? j.stats?.usage;
      const usage = um ? {
        prompt_tokens: um.promptTokenCount ?? 0, completion_tokens: um.candidatesTokenCount ?? 0,
        total_tokens: um.totalTokenCount ?? 0,
      } : undefined;
      return { content: String(text).trim(), usage };
    } catch { return { content: raw.stdout.trim() }; }
  },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};

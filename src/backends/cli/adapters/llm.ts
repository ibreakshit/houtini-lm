import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText, homeEnv } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const llmAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, _f: string): Invocation {
    return { argv: [p.bin, '-m', p.model, '--no-stream', prompt], env: homeEnv(p) };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput { return { content: raw.stdout.trim() }; },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};

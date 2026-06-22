import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText, homeEnv } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const codexAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, outFile: string): Invocation {
    return {
      argv: [p.bin, 'exec', '--skip-git-repo-check', '-s', 'read-only', '-m', p.model, '-o', outFile],
      env: homeEnv(p),
      stdin: prompt,
      outFile,
    };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput {
    return { content: (raw.outFileContent ?? raw.stdout).trim() };
  },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};

import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const customAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, _f: string): Invocation {
    const tmpl = p.argvTemplate ?? [p.bin, '{prompt}'];
    const viaArg = p.promptVia !== 'stdin';
    const argv = tmpl.map((t) => t.replace('{model}', p.model).replace('{prompt}', viaArg ? prompt : ''));
    return { argv, env: p.configHome ? { HOME: p.configHome } : {}, stdin: viaArg ? undefined : prompt };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput {
    return { content: raw.stdout.trim() };
  },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};

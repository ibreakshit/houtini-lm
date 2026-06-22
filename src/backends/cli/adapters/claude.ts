import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText, homeEnv } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const claudeAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, _f: string): Invocation {
    return {
      argv: [p.bin, '-p', '--model', p.model, '--output-format', 'json', '--no-session-persistence', '--permission-mode', 'plan', '--disallowed-tools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task'],
      env: homeEnv(p),
      stdin: prompt,
    };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput {
    try {
      const j = JSON.parse(raw.stdout);
      const u = j.usage ?? {};
      const usage = (u.input_tokens != null || u.output_tokens != null) ? {
        prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0,
        total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      } : undefined;
      return { content: String(j.result ?? '').trim(), usage };
    } catch { return { content: raw.stdout.trim() }; }
  },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};

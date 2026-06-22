import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText, homeEnv } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const codexAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, _outFile: string): Invocation {
    return {
      argv: [p.bin, 'exec', '--skip-git-repo-check', '-s', 'read-only', '--json', '-m', p.model],
      env: homeEnv(p),
      stdin: prompt,
    };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput {
    const lines = raw.stdout.split('\n');
    const contentParts: string[] = [];
    let usage: ParsedOutput['usage'] | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj.type === 'item.completed') {
          const item = obj.item as Record<string, unknown> | undefined;
          if (item && item.type === 'agent_message' && typeof item.text === 'string') {
            contentParts.push(item.text);
          }
        } else if (obj.type === 'turn.completed') {
          const u = obj.usage as Record<string, unknown> | undefined;
          if (u) {
            const inputTokens = (u.input_tokens as number) ?? 0;
            const outputTokens = (u.output_tokens as number) ?? 0;
            const reasoningOutputTokens = (u.reasoning_output_tokens as number) ?? 0;
            usage = {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens + reasoningOutputTokens,
              total_tokens: inputTokens + outputTokens + reasoningOutputTokens,
              ...(reasoningOutputTokens ? { completion_tokens_details: { reasoning_tokens: reasoningOutputTokens } } : {}),
            };
          }
        }
      } catch {
        // non-JSON line — skip
      }
    }

    return { content: contentParts.join('\n').trim(), usage };
  },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};

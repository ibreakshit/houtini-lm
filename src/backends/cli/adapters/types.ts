import type { CliProfile, Provider } from '../profiles.js';
import type { ChatOptions, StreamingResult } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export type CliErrorKind = 'ok' | 'auth' | 'rate' | 'error';
export interface Invocation { argv: string[]; env: Record<string, string>; stdin?: string; outFile?: string; schemaFile?: { path: string; content: string }; }
export interface ParsedOutput { content: string; usage?: StreamingResult['usage']; }
export interface CliAdapter {
  buildInvocation(p: CliProfile, prompt: string, options: ChatOptions, outFile: string): Invocation;
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput;
  classifyError(raw: ProcessResult): CliErrorKind;
}

const AUTH_RE = /\b(401|403|unauthor|not (logged|authenticated)|please (log ?in|authenticate)|invalid api key|missing api key|credential|api key not valid|invalid credentials|authentication failed|not authenticated|expired (token|credential))\b/i;
const RATE_RE = /\b(429|rate.?limit|quota|too many requests|exceeded your|resource exhausted|usage limit)\b/i;

/** Shared default error classifier — adapters can reuse or wrap. */
export function classifyByText(raw: ProcessResult): CliErrorKind {
  if (raw.exitCode === 0 && !raw.timedOut) return 'ok';
  const hay = `${raw.stderr}\n${raw.stdout}`;
  if (AUTH_RE.test(hay)) return 'auth';
  if (RATE_RE.test(hay)) return 'rate';
  return 'error';
}

/** Merge configHome into a provider-specific env var. */
export function homeEnv(p: CliProfile): Record<string, string> {
  if (!p.configHome) return {};
  switch (p.provider) {
    case 'codex': return { CODEX_HOME: p.configHome };
    case 'claude': return { CLAUDE_CONFIG_DIR: p.configHome };
    default: return {};
  }
}

export type { CliProfile, Provider, ChatOptions, ProcessResult };

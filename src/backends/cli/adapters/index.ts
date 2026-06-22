import type { CliAdapter } from './types.js';
import type { Provider } from '../profiles.js';
import { codexAdapter } from './codex.js';
import { claudeAdapter } from './claude.js';
import { llmAdapter } from './llm.js';
import { customAdapter } from './custom.js';

const REGISTRY: Record<Provider, CliAdapter> = {
  codex: codexAdapter, claude: claudeAdapter, llm: llmAdapter, custom: customAdapter,
};
export function getAdapter(provider: Provider): CliAdapter {
  const a = REGISTRY[provider];
  if (!a) throw new Error(`No adapter for provider: ${provider}`);
  return a;
}
export type { CliAdapter } from './types.js';

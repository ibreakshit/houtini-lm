/** Decide whether to activate the CLI backend, per HOUTINI_LM_BACKEND semantics.
 *  'cli'  → true (config required; caller enforces fatal-if-missing)
 *  'auto' → true only if a config path is set, else OpenAI
 *  '' (unset) | 'openai-compat' | anything else → false (OpenAI path) */
export function shouldUseCli(backend: string, configPath: string): boolean {
  if (backend === 'cli') return true;
  if (backend === 'auto') return configPath !== '';
  return false;
}

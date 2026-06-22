/** Decide whether to activate the CLI backend, per HOUTINI_LM_BACKEND semantics.
 *  'cli'  → true (config required; caller enforces fatal-if-missing)
 *  'auto' → true only if a config path is set, else OpenAI
 *  '' (unset) | 'openai-compat' | anything else → false (OpenAI path) */
export function shouldUseCli(backend: string, configPath: string): boolean {
  if (backend === 'cli') return true;
  if (backend === 'auto') return configPath !== '';
  return false;
}

/** Resolve which model/profile id to use and whether it is an explicit (no-failover) override.
 *  Precedence: per-call model param > env profile pin (CLI only) > soft default (LM_MODEL).
 *  Only the first two are "overridden" (verbatim, no failover); LM_MODEL is a soft default. */
export function resolveOverride(perCallModel: string | undefined, envProfile: string, lmModel: string): { pinned: string; overridden: boolean } {
  const explicit = (perCallModel && perCallModel.length ? perCallModel : '') || envProfile;
  const pinned = explicit || lmModel || '';
  return { pinned, overridden: explicit.length > 0 };
}

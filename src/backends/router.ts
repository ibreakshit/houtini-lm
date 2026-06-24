import type { InferenceBackend, ChatMessage, ChatOptions, StreamingResult, ModelInfo, EmbedResult, Tier } from '../types.js';
import { evalEscalate, describeRules, type RoutingConfig, type RoutingSignals } from './routing-config.js';
export type { Tier };

/**
 * Format the router topology (local/cli tiers) plus the routing summary.
 * Pure function — no I/O. Extracted so both discover and list_models handlers
 * share identical output and the logic is independently testable.
 *
 * @param models - merged ModelInfo[] returned by Router.listModels() (items have .tier set)
 * @param routingSummary - string from Router.describeRouting()
 */
export function formatRouterTopology(models: ModelInfo[], routingSummary: string): string {
  const byTier = (t: string) => models.filter((m) => (m as { tier?: string }).tier === t).map((m) => m.id);
  const localIds = byTier('local');
  const cliIds = byTier('cli');
  let out = `\n\nRouting topology:\n`;
  out += `  local: ${localIds.length > 0 ? localIds.join(', ') : '(none)'}\n`;
  out += `  cli: ${cliIds.length > 0 ? cliIds.join(', ') : '(none)'}\n`;
  out += `\nRouting rules:\n${routingSummary}`;
  return out;
}

const CALLER_GUIDANCE =
  'Escalate with tier:"cli" for correctness-critical reasoning, subtle-bug hunts, whole-module ' +
  'generation, or current/niche-knowledge tasks (no size signal). Local is fast and reliable for ' +
  'single-function review, test stubs, explainers, and reformatting.';

export class Router implements InferenceBackend {
  name = 'router';
  private local: InferenceBackend;
  private cli?: InferenceBackend;
  private cliHasProfile: (id: string) => boolean;
  constructor(deps: { local: InferenceBackend; cli?: InferenceBackend; cliHasProfile?: (id: string) => boolean }, private config: RoutingConfig) {
    this.local = deps.local; this.cli = deps.cli; this.cliHasProfile = deps.cliHasProfile ?? (() => false);
  }
  private inputChars(m: ChatMessage[]): number { return m.reduce((n, x) => n + x.content.length, 0); }

  /**
   * Pure tier resolver — returns the routing decision without dispatching or side-effects.
   * Used by code_task_files preflight to gate the local-only prefill check.
   */
  routeTier(messages: ChatMessage[], o: ChatOptions): Tier {
    if (o.overridden && o.model) return (this.cli && this.cliHasProfile(o.model)) ? 'cli' : 'local'; // 1 exact
    if (o.tool === 'embed') return 'local';                                                            // embed local
    if (o.tier === 'cli') return this.cli ? 'cli' : 'local';                                          // 2 tier
    if (o.tier === 'local' || !this.cli) return 'local';                                               // 2 tier
    const signals: RoutingSignals = { taskType: o.taskType, tool: o.tool, inputChars: this.inputChars(messages), fileCount: o.fileCount ?? 0 };
    return evalEscalate(this.config, signals) ? 'cli' : 'local';                                       // 3 rules
  }

  chat(messages: ChatMessage[], options: ChatOptions): Promise<StreamingResult> {
    // Emit the "tier:cli but no CLI" note ONLY in the tier:cli-decisive branch (not override, not embed).
    if (!(options.overridden && options.model) && options.tool !== 'embed' && options.tier === 'cli' && !this.cli) {
      process.stderr.write('[houtini-lm][router] tier:"cli" but no CLI configured — using local\n');
    }
    const tier = this.routeTier(messages, options);
    const backend = tier === 'cli' ? this.cli! : this.local;
    return backend.chat(messages, options).then((r) => ({ ...r, tier }));
  }
  async listModels(): Promise<ModelInfo[]> {
    const local = (await this.local.listModels()).map((m) => ({ ...m, tier: 'local' as const }));
    const cli = this.cli ? (await this.cli.listModels()).map((m) => ({ ...m, tier: 'cli' as const })) : [];
    return [...local, ...cli];
  }
  embed(input: string | string[], model?: string): Promise<EmbedResult> {
    if (!this.local.embed) throw new Error('local backend does not support embeddings');
    return this.local.embed(input, model);
  }
  describeRouting(): string { return `${describeRules(this.config)}\n${CALLER_GUIDANCE}`; }
}

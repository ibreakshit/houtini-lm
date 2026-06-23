import type { InferenceBackend, ChatMessage, ChatOptions, StreamingResult, ModelInfo, EmbedResult } from '../types.js';
import { evalEscalate, describeRules, type RoutingConfig, type RoutingSignals } from './routing-config.js';

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
  private pick(messages: ChatMessage[], o: ChatOptions): InferenceBackend {
    if (o.overridden && o.model) return (this.cli && this.cliHasProfile(o.model)) ? this.cli : this.local; // 1 exact
    if (o.tool === 'embed') return this.local;                                                              // embed local
    if (o.tier === 'cli') { if (this.cli) return this.cli; process.stderr.write('[houtini-lm][router] tier:"cli" but no CLI configured — using local\n'); return this.local; }
    if (o.tier === 'local' || !this.cli) return this.local;                                                 // 2 tier
    const signals: RoutingSignals = { taskType: o.taskType, tool: o.tool, inputChars: this.inputChars(messages), fileCount: o.fileCount ?? 0 };
    return evalEscalate(this.config, signals) ? this.cli : this.local;                                      // 3 rules
  }
  chat(messages: ChatMessage[], options: ChatOptions): Promise<StreamingResult> { return this.pick(messages, options).chat(messages, options); }
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

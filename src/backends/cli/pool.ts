import type { CliConfig, CliProfile } from './profiles.js';
import { profileToModelInfo } from './profiles.js';
import type { ModelInfo, TaskType } from '../../types.js';

const DEFAULT_COOLDOWN_MS = 60_000;

export function scoreProfileForTask(p: CliProfile, taskType: TaskType): number {
  let score = p.capabilities.includes(taskType) ? 10 : 0;
  if (taskType === 'code' && (p.provider === 'codex' || /cod(e|ex)/i.test(p.model))) score += 5;
  if (taskType === 'analysis' && (p.contextWindow ?? 0) > 100_000) score += 2;
  return score;
}

interface State { lastUsedAt: number; cooldownUntil: number; authBlocked: boolean; inFlight: number; }

export class CliPool {
  private states = new Map<string, State>();
  private byId = new Map<string, CliProfile>();
  private cooldownMs: number;
  constructor(private config: CliConfig, private now: () => number = Date.now) {
    this.cooldownMs = config.defaults?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    for (const p of config.profiles) {
      this.byId.set(p.id, p);
      this.states.set(p.id, { lastUsedAt: 0, cooldownUntil: 0, authBlocked: false, inFlight: 0 });
    }
  }
  get(id: string): CliProfile | undefined { return this.byId.get(id); }
  private isAvailable(p: CliProfile, now: number): boolean {
    if (p.enabled === false) return false;
    const s = this.states.get(p.id)!;
    return !s.authBlocked && s.cooldownUntil <= now && s.inFlight < (p.concurrency ?? 1);
  }
  listAvailable(taskType: TaskType): CliProfile[] {
    const now = this.now();
    return this.config.profiles
      .filter((p) => this.isAvailable(p, now) && scoreProfileForTask(p, taskType) > 0)
      .sort((a, b) =>
        scoreProfileForTask(b, taskType) - scoreProfileForTask(a, taskType)
        || this.states.get(a.id)!.lastUsedAt - this.states.get(b.id)!.lastUsedAt);
  }
  acquire(id: string): void { const s = this.states.get(id); if (s) s.inFlight++; }
  release(id: string): void { const s = this.states.get(id); if (s && s.inFlight > 0) s.inFlight--; }
  markUsed(id: string): void { const s = this.states.get(id); if (s) s.lastUsedAt = this.now(); }
  markCooldown(id: string, ms?: number): void { const s = this.states.get(id); if (s) s.cooldownUntil = this.now() + (ms ?? this.cooldownMs); }
  markAuthBlocked(id: string): void { const s = this.states.get(id); if (s) s.authBlocked = true; }
  toModelInfos(): ModelInfo[] {
    const now = this.now();
    return this.config.profiles.map((p) => profileToModelInfo(p, this.isAvailable(p, now)));
  }
}

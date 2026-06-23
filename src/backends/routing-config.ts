import { readFile } from 'node:fs/promises';
import type { TaskType, Tier } from '../types.js';

export interface RoutingRule { taskType?: TaskType; tool?: string; minInputChars?: number; minInputTokens?: number; minFiles?: number; }
export interface RoutingConfig { escalateToCliWhen: RoutingRule[]; default: Tier; }
export interface RoutingSignals { taskType?: TaskType; tool?: string; inputChars: number; fileCount: number; }

const TASK_TYPES: TaskType[] = ['code', 'chat', 'analysis', 'embedding'];

/** Grounded in the 2026-06-21 gpt-oss-120b shakedown (houtini-lm-usage.md). */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  escalateToCliWhen: [
    { tool: 'code_task_files', minFiles: 2 },
    { minInputChars: 28000 },
    { taskType: 'analysis', minInputChars: 12000 },
    { taskType: 'code', minInputChars: 16000 },
  ],
  default: 'local',
};

export function parseRoutingConfig(raw: unknown): RoutingConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('routing config must be an object');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.escalateToCliWhen)) throw new Error('routing config: "escalateToCliWhen" must be an array');
  if (o.default !== 'local' && o.default !== 'cli') throw new Error('routing config: "default" must be "local" or "cli"');
  const rules: RoutingRule[] = o.escalateToCliWhen.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`escalateToCliWhen[${i}]: must be an object`);
    const rr = r as Record<string, unknown>;
    if (rr.taskType !== undefined && !TASK_TYPES.includes(rr.taskType as TaskType)) throw new Error(`escalateToCliWhen[${i}]: bad taskType`);
    if (rr.tool !== undefined && typeof rr.tool !== 'string') throw new Error(`escalateToCliWhen[${i}]: "tool" must be a string`);
    for (const k of ['minInputChars', 'minInputTokens', 'minFiles'] as const)
      if (rr[k] !== undefined && typeof rr[k] !== 'number') throw new Error(`escalateToCliWhen[${i}]: "${k}" must be a number`);
    return { taskType: rr.taskType as TaskType | undefined, tool: rr.tool as string | undefined,
      minInputChars: rr.minInputChars as number | undefined, minInputTokens: rr.minInputTokens as number | undefined,
      minFiles: rr.minFiles as number | undefined };
  });
  return { escalateToCliWhen: rules, default: o.default };
}

export async function loadRoutingConfig(path: string): Promise<RoutingConfig> {
  return parseRoutingConfig(JSON.parse(await readFile(path, 'utf8')));
}

function ruleMatches(r: RoutingRule, s: RoutingSignals): boolean {
  if (r.taskType !== undefined && r.taskType !== s.taskType) return false;
  if (r.tool !== undefined && r.tool !== s.tool) return false;
  if (r.minInputChars !== undefined && s.inputChars < r.minInputChars) return false;
  if (r.minInputTokens !== undefined && Math.floor(s.inputChars / 4) < r.minInputTokens) return false;
  if (r.minFiles !== undefined && s.fileCount < r.minFiles) return false;
  return true;
}

export function evalEscalate(config: RoutingConfig, signals: RoutingSignals): boolean {
  return config.escalateToCliWhen.some((r) => ruleMatches(r, signals)) || config.default === 'cli';
}

export function describeRules(config: RoutingConfig): string {
  if (config.escalateToCliWhen.length === 0) return `defaults → CLI for: (no escalation rules); else ${config.default}`;
  const parts = config.escalateToCliWhen.map((r) => {
    const c: string[] = [];
    if (r.tool) c.push(`tool=${r.tool}`);
    if (r.taskType) c.push(r.taskType);
    if (r.minFiles) c.push(`≥${r.minFiles} files`);
    if (r.minInputChars) c.push(`≥${r.minInputChars} chars`);
    if (r.minInputTokens) c.push(`≥${r.minInputTokens} tok`);
    return c.join(' & ');
  });
  return `defaults → CLI for: ${parts.join(' · ')}; else ${config.default}`;
}

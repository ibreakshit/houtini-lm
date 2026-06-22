import { readFile } from 'node:fs/promises';
import type { ModelInfo, TaskType } from '../../types.js';

export type Provider = 'codex' | 'gemini' | 'claude' | 'llm' | 'custom';
const PROVIDERS: Provider[] = ['codex', 'gemini', 'claude', 'llm', 'custom'];
const TASK_TYPES: TaskType[] = ['code', 'chat', 'analysis', 'embedding'];

export interface CliProfile {
  id: string; provider: Provider; bin: string; model: string;
  configHome?: string; capabilities: TaskType[]; contextWindow?: number;
  concurrency?: number; weight?: number; enabled?: boolean;
  argvTemplate?: string[]; promptVia?: 'stdin' | 'arg'; parse?: 'text' | 'json'; jsonPath?: string;
}
export interface CliConfig { profiles: CliProfile[]; defaults?: { timeoutMs?: number; cooldownMs?: number }; }

export function parseCliConfig(raw: unknown): CliConfig {
  if (!raw || typeof raw !== 'object') throw new Error('CLI config must be an object');
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.profiles) || obj.profiles.length === 0) throw new Error('CLI config requires a non-empty "profiles" array');
  const seen = new Set<string>();
  const profiles: CliProfile[] = obj.profiles.map((p, i) => {
    const r = p as Record<string, unknown>;
    const where = `profiles[${i}]`;
    if (typeof r.id !== 'string' || !r.id) throw new Error(`${where}: "id" is required`);
    if (seen.has(r.id)) throw new Error(`duplicate profile id: ${r.id}`);
    seen.add(r.id);
    if (!PROVIDERS.includes(r.provider as Provider)) throw new Error(`${where}: unknown provider "${String(r.provider)}"`);
    if (typeof r.bin !== 'string' || !r.bin) throw new Error(`${where}: "bin" is required`);
    if (typeof r.model !== 'string' || !r.model) throw new Error(`${where}: "model" is required`);
    const caps = Array.isArray(r.capabilities) ? r.capabilities : [];
    for (const c of caps) if (!TASK_TYPES.includes(c as TaskType)) throw new Error(`${where}: unknown capability "${String(c)}"`);
    return {
      id: r.id, provider: r.provider as Provider, bin: r.bin, model: r.model,
      configHome: typeof r.configHome === 'string' ? r.configHome : undefined,
      capabilities: caps as TaskType[],
      contextWindow: typeof r.contextWindow === 'number' ? r.contextWindow : undefined,
      concurrency: typeof r.concurrency === 'number' ? r.concurrency : 1,
      weight: typeof r.weight === 'number' ? r.weight : 1,
      enabled: r.enabled !== false,
      argvTemplate: Array.isArray(r.argvTemplate) ? (r.argvTemplate as string[]) : undefined,
      promptVia: r.promptVia === 'arg' ? 'arg' : r.promptVia === 'stdin' ? 'stdin' : undefined,
      parse: r.parse === 'json' ? 'json' : r.parse === 'text' ? 'text' : undefined,
      jsonPath: typeof r.jsonPath === 'string' ? r.jsonPath : undefined,
    };
  });
  const defaults = (obj.defaults && typeof obj.defaults === 'object') ? obj.defaults as CliConfig['defaults'] : undefined;
  return { profiles, defaults };
}

export async function loadCliConfig(path: string): Promise<CliConfig> {
  const text = await readFile(path, 'utf8');
  return parseCliConfig(JSON.parse(text));
}

export function profileToModelInfo(p: CliProfile, available: boolean): ModelInfo {
  return {
    id: p.id,
    type: 'llm',
    state: available ? 'loaded' : 'not-loaded',
    context_length: p.contextWindow,
    max_context_length: p.contextWindow,
    owned_by: p.provider,
  };
}

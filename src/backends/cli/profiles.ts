import { readFile } from 'node:fs/promises';
import type { ModelInfo, TaskType } from '../../types.js';

export type Provider = 'codex' | 'claude' | 'llm' | 'custom';
const PROVIDERS: Provider[] = ['codex', 'claude', 'llm', 'custom'];
const TASK_TYPES: TaskType[] = ['code', 'chat', 'analysis', 'embedding'];

export interface CliProfile {
  id: string; provider: Provider; bin: string; model: string;
  configHome?: string; capabilities: TaskType[]; contextWindow?: number;
  concurrency?: number; weight?: number; enabled?: boolean;
  argvTemplate?: string[]; promptVia?: 'stdin' | 'arg'; parse?: 'text' | 'json'; jsonPath?: string;
  roles?: string[];
}
export interface CliConfig { profiles: CliProfile[]; defaults?: { timeoutMs?: number; cooldownMs?: number }; tieBreak?: 'first-loaded' | 'round-robin'; }

export function parseCliConfig(raw: unknown): CliConfig {
  if (!raw || typeof raw !== 'object') throw new Error('CLI config must be an object');
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.profiles) || obj.profiles.length === 0) throw new Error('CLI config requires a non-empty "profiles" array');
  const seen = new Set<string>();
  const profiles: CliProfile[] = obj.profiles.map((p, i) => {
    const where = `profiles[${i}]`;
    if (typeof p !== 'object' || p === null) throw new Error(`${where}: must be an object`);
    const r = p as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id) throw new Error(`${where}: "id" is required`);
    if (seen.has(r.id)) throw new Error(`duplicate profile id: ${r.id}`);
    seen.add(r.id);
    if (!PROVIDERS.includes(r.provider as Provider)) throw new Error(`${where}: unknown provider "${String(r.provider)}"`);
    if (typeof r.bin !== 'string' || !r.bin) throw new Error(`${where}: "bin" is required`);
    if (typeof r.model !== 'string' || !r.model) throw new Error(`${where}: "model" is required`);
    // capabilities: absent → default []; present → must be an array of valid TaskType
    let caps: TaskType[];
    if ('capabilities' in r) {
      if (!Array.isArray(r.capabilities)) throw new Error(`${where}: "capabilities" must be an array`);
      for (const c of r.capabilities) if (!TASK_TYPES.includes(c as TaskType)) throw new Error(`${where}: unknown capability "${String(c)}"`);
      caps = r.capabilities as TaskType[];
    } else {
      caps = [];
    }
    // numeric fields: absent → default; present with wrong type → throw
    if ('contextWindow' in r && typeof r.contextWindow !== 'number') throw new Error(`${where}: "contextWindow" must be a number`);
    if ('concurrency' in r && typeof r.concurrency !== 'number') throw new Error(`${where}: "concurrency" must be a number`);
    if ('weight' in r && typeof r.weight !== 'number') throw new Error(`${where}: "weight" must be a number`);
    // argvTemplate: if present must be string[]
    if ('argvTemplate' in r) {
      if (!Array.isArray(r.argvTemplate) || (r.argvTemplate as unknown[]).some(el => typeof el !== 'string'))
        throw new Error(`${where}: "argvTemplate" must be an array of strings`);
    }
    // roles: if present must be string[]
    if ('roles' in r) {
      if (!Array.isArray(r.roles) || (r.roles as unknown[]).some(el => typeof el !== 'string'))
        throw new Error(`${where}: "roles" must be an array of strings`);
    }
    return {
      id: r.id, provider: r.provider as Provider, bin: r.bin, model: r.model,
      configHome: typeof r.configHome === 'string' ? r.configHome : undefined,
      capabilities: caps,
      contextWindow: typeof r.contextWindow === 'number' ? r.contextWindow : undefined,
      concurrency: typeof r.concurrency === 'number' ? r.concurrency : 1,
      weight: typeof r.weight === 'number' ? r.weight : 1,
      enabled: r.enabled !== false,
      argvTemplate: Array.isArray(r.argvTemplate) ? (r.argvTemplate as string[]) : undefined,
      promptVia: r.promptVia === 'arg' ? 'arg' : r.promptVia === 'stdin' ? 'stdin' : undefined,
      parse: r.parse === 'json' ? 'json' : r.parse === 'text' ? 'text' : undefined,
      jsonPath: typeof r.jsonPath === 'string' ? r.jsonPath : undefined,
      roles: Array.isArray(r.roles) ? (r.roles as string[]) : undefined,
    };
  });
  // defaults numeric fields: if present with wrong type → throw
  if (obj.defaults && typeof obj.defaults === 'object') {
    const d = obj.defaults as Record<string, unknown>;
    if ('timeoutMs' in d && typeof d.timeoutMs !== 'number') throw new Error('"defaults.timeoutMs" must be a number');
    if ('cooldownMs' in d && typeof d.cooldownMs !== 'number') throw new Error('"defaults.cooldownMs" must be a number');
  }
  // tieBreak: if present must be a valid value
  if ('tieBreak' in obj && obj.tieBreak !== 'first-loaded' && obj.tieBreak !== 'round-robin')
    throw new Error(`"tieBreak" must be "first-loaded" or "round-robin"`);
  const defaults = (obj.defaults && typeof obj.defaults === 'object') ? obj.defaults as CliConfig['defaults'] : undefined;
  const tieBreak = (obj.tieBreak === 'first-loaded' || obj.tieBreak === 'round-robin') ? obj.tieBreak : undefined;
  return { profiles, defaults, tieBreak };
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

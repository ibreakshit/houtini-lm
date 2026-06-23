# Tiered multi-backend routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Per the user's workflow: after each task's commit, run a Codex review of the diff (`codex:rescue`) and address findings before the next task.**

**Goal:** Let one houtini instance hold both a local backend and a CLI backend and route each call per-call — caller directive first, deterministic shape/size rules as the fallback — so simple work stays on cheap local models and hard work escalates to the CLI tier.

**Architecture:** All new routing logic lives in **new files** under `src/backends/` (`router.ts`, `routing-config.ts`). The baseline `src/index.ts` is **not restructured** — its existing local SSE path stays exactly where it is; routing is attached through a few small, generic hooks (an `activeBackend` dispatch + a thin local-adapter built by dependency injection in the bootstrap). The CLI work's own files (`src/backends/cli/*`, `src/types.ts`) are fork-owned and edited freely.

**Tech Stack:** TypeScript (ES2022, `moduleResolution: bundler`, strict), `node:test` via `tsx`. No new runtime dependencies.

## Global Constraints
- **Upstream-mergeable / minimum baseline edits (PRIMARY):** put all new routing logic in NEW files. The only *upstream-baseline* file edited is `src/index.ts`, and only via the surgical, cataloged hooks in Tasks 5–6 — **do NOT relocate or restructure the existing local SSE path** (that maximizes divergence from upstream). Prefer deleting the fork's own prior inline branches (moving `index.ts` *toward* baseline) over adding new ones. `src/backends/cli/*` and `src/types.ts` are fork-owned (created by the CLI work), not upstream baseline — edit them freely.
- **ESM with explicit `.js` import extensions.** Node `>=18`. **No new runtime dependencies.** Strict TS.
- **Opt-in + backward compatible:** routing activates ONLY under `HOUTINI_LM_BACKEND=router`. `openai-compat` / `cli` / `auto` / unset behave exactly as today; `tier` is ignored in those modes.
- **Routing is deterministic & upfront:** caller exact override (`model`/`HOUTINI_LM_PROFILE`) → caller `tier` hint → escalation rules. NO cascade, confidence, or classifier; exactly two tiers (`local`, `cli`).
- **CLI escalation only moves up.** `embed` is always local. `tier:"cli"` with no CLI configured → local + a one-line stderr note.
- **CLI tie-break:** role match → `tieBreak` (`first-loaded` default | `round-robin` opt-in) → cooldown/auth failover.
- **Grounded escalation defaults** (from `houtini-lm-usage.md`): `code_task_files` ≥2 files; input ≥28 000 chars; `analysis` ≥12 000 chars; `code` ≥16 000 chars; else local.
- **The local SSE path stays behavior-identical** — it is referenced, never moved or rewritten.

---

## File structure
**New files (all routing logic — zero baseline coupling):**
```
src/backends/routing-config.ts   CREATE  RoutingRule/Config/Signals types; parse/validate; evalEscalate(); describeRules(); DEFAULT_ROUTING_CONFIG
src/backends/router.ts           CREATE  Router (InferenceBackend): override→tier→rules precedence; tier-tagged listModels; describeRouting()
test/routing-config.test.ts      CREATE
test/router.test.ts              CREATE
test/routing-wiring.test.ts      CREATE
```
**Fork-owned files (created by the CLI work — not upstream baseline):**
```
src/types.ts                     MODIFY  + Tier; extend ChatOptions (tier, tool, fileCount)
src/backends/cli/profiles.ts     MODIFY  + CliProfile.roles?; + CliConfig.tieBreak?
src/backends/cli/pool.ts         MODIFY  role-aware + tieBreak-aware listAvailable
src/backends/cli/index.ts        MODIFY  + CliBackend.hasProfile(); pass role to pool
test/cli-pool.test.ts            MODIFY  + tieBreak/role cases
```
**Upstream baseline — the ONLY baseline file, edited via the cataloged hooks in Tasks 5–6:**
```
src/index.ts                     MODIFY  Task 5: 3 generic dispatch hooks + bootstrap + thin local adapter
                                         Task 6: tier param (4 schemas) + handler threading + discover/list_models grouping
```
> **Tasks 1–4 do not touch `src/index.ts` at all.** Only Tasks 5–6 do, and each `index.ts` edit is listed explicitly so the reviewer can confirm the surface is minimal.

---

### Task 1: Routing types + ChatOptions extension (fork-owned `src/types.ts`)

**Files:** Modify `src/types.ts`. (No index.ts.)

**Interfaces — Produces:** `Tier = 'local' | 'cli'`; `ChatOptions` gains `tier?: Tier`, `tool?: string`, `fileCount?: number`. (`RoutingRule`/`RoutingConfig`/`RoutingSignals` live in `routing-config.ts`, Task 3, to keep routing types with the routing code.)

- [ ] **Step 1: Add the type + fields** — in `src/types.ts`, add `export type Tier = 'local' | 'cli';` near `TaskType`, and add to `ChatOptions` (after `onProgress?`):
```ts
  tier?: Tier;            // caller routing directive (router mode only)
  tool?: string;          // originating tool name, for routing rules
  fileCount?: number;     // code_task_files path count, for routing rules
```
- [ ] **Step 2: Typecheck** — `npm run build` → clean (additive optional fields).
- [ ] **Step 3: Commit** — `git commit -m "feat(routing): Tier type + ChatOptions routing fields"`
- [ ] **Step 4: Codex review.**

---

### Task 2: CLI pool — `tieBreak` + role-aware selection (fork-owned cli files)

**Files:** Modify `src/backends/cli/profiles.ts`, `src/backends/cli/pool.ts`, `src/backends/cli/index.ts`; Test `test/cli-pool.test.ts`. (No index.ts.)

**Interfaces — Produces:** `CliConfig.tieBreak?: 'first-loaded' | 'round-robin'`; `CliProfile.roles?: string[]`; `CliPool.listAvailable(taskType, role?)`; `CliBackend.hasProfile(id): boolean`.

- [ ] **Step 1: Write the failing tests** (append to `test/cli-pool.test.ts`)
```ts
test('tieBreak first-loaded keeps config order (no rotation)', () => {
  const cfg: CliConfig = { tieBreak: 'first-loaded', profiles: [
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
  ]};
  let t = 1000; const pool = new CliPool(cfg, () => t);
  const first = pool.listAvailable('chat')[0].id; pool.markUsed(first); t = 1001;
  assert.equal(pool.listAvailable('chat')[0].id, first);            // does NOT rotate
});
test('tieBreak round-robin rotates by LRU', () => {
  const cfg: CliConfig = { tieBreak: 'round-robin', profiles: [
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
  ]};
  let t = 1000; const pool = new CliPool(cfg, () => t);
  const first = pool.listAvailable('chat')[0].id; pool.markUsed(first); t = 1001;
  assert.notEqual(pool.listAvailable('chat')[0].id, first);         // rotates
});
test('explicit role match beats tie-break order', () => {
  const cfg: CliConfig = { tieBreak: 'first-loaded', profiles: [
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'claude', bin: 'claude', model: 'm', capabilities: ['chat'], roles: ['analysis'] },
  ]};
  const pool = new CliPool(cfg, () => 1000);
  assert.equal(pool.listAvailable('chat', 'analysis')[0].id, 'b');  // role wins
});
```
- [ ] **Step 2: Run → FAIL** (`npx tsx --test test/cli-pool.test.ts`).
- [ ] **Step 3: Implement**
  - `profiles.ts`: add `roles?: string[]` to `CliProfile`; `tieBreak?: 'first-loaded' | 'round-robin'` to `CliConfig`. In `parseCliConfig`: if `roles` present it must be a string array (else throw `profiles[i]: "roles" must be an array of strings`); if top-level `tieBreak` present it must be `'first-loaded'`|`'round-robin'` (else throw). Keep existing validation.
  - `pool.ts`: replace `listAvailable`:
```ts
listAvailable(taskType: TaskType, role?: string): CliProfile[] {
  const now = this.now();
  const tieBreak = this.config.tieBreak ?? 'first-loaded';
  const index = new Map(this.config.profiles.map((p, i) => [p.id, i]));
  const roleScore = (p: CliProfile) => (role && p.roles?.includes(role) ? 1 : 0);
  return this.config.profiles
    .filter((p) => this.isAvailable(p, now) && scoreProfileForTask(p, taskType) > 0)
    .sort((a, b) =>
      roleScore(b) - roleScore(a)
      || scoreProfileForTask(b, taskType) - scoreProfileForTask(a, taskType)
      || (tieBreak === 'round-robin'
            ? this.states.get(a.id)!.lastUsedAt - this.states.get(b.id)!.lastUsedAt
            : index.get(a.id)! - index.get(b.id)!));     // first-loaded = config order
}
```
  - `cli/index.ts` (`CliBackend`): add `hasProfile(id: string): boolean { return this.pool.get(id) !== undefined; }`; where `chat()` calls `this.pool.listAvailable(taskType)`, change to `this.pool.listAvailable(taskType, options.taskType)` (MVP role == taskType). Leave override/failover unchanged.
- [ ] **Step 4: Run → PASS**; `npm run build` → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): role-aware selection + configurable tieBreak"`
- [ ] **Step 6: Codex review.**

---

### Task 3: Routing config (NEW `src/backends/routing-config.ts`)

**Files:** Create `src/backends/routing-config.ts`, `test/routing-config.test.ts`. (No index.ts.)

**Interfaces — Produces:** `RoutingRule`, `RoutingConfig`, `RoutingSignals`; `parseRoutingConfig(raw)`; `loadRoutingConfig(path)`; `evalEscalate(config, signals)`; `describeRules(config)`; `DEFAULT_ROUTING_CONFIG`.

- [ ] **Step 1: Write the failing test** (`test/routing-config.test.ts`)
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutingConfig, evalEscalate, describeRules, DEFAULT_ROUTING_CONFIG } from '../src/backends/routing-config.js';
const sig = (o = {}) => ({ taskType: undefined, tool: undefined, inputChars: 0, fileCount: 0, ...o });

test('default: code_task_files >=2 files escalates', () => {
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ tool: 'code_task_files', fileCount: 2 })), true);
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ tool: 'code_task_files', fileCount: 1 })), false);
});
test('default: input >=28000 chars escalates', () => {
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ inputChars: 28000 })), true);
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ inputChars: 27999 })), false);
});
test('default: analysis >=12000 escalates; small analysis local', () => {
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ taskType: 'analysis', inputChars: 12000 })), true);
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ taskType: 'analysis', inputChars: 5000 })), false);
});
test('minInputTokens compares chars/4', () => {
  const cfg = parseRoutingConfig({ escalateToCliWhen: [{ minInputTokens: 1000 }], default: 'local' });
  assert.equal(evalEscalate(cfg, sig({ inputChars: 4000 })), true);
  assert.equal(evalEscalate(cfg, sig({ inputChars: 3996 })), false);
});
test('AND within a rule, OR across rules', () => {
  const cfg = parseRoutingConfig({ escalateToCliWhen: [{ taskType: 'code', minInputChars: 100 }], default: 'local' });
  assert.equal(evalEscalate(cfg, sig({ taskType: 'code', inputChars: 100 })), true);
  assert.equal(evalEscalate(cfg, sig({ taskType: 'code', inputChars: 50 })), false);
  assert.equal(evalEscalate(cfg, sig({ taskType: 'chat', inputChars: 9999 })), false);
});
test('parse rejects bad default / non-array rules', () => {
  assert.throws(() => parseRoutingConfig({ escalateToCliWhen: [], default: 'bogus' }), /default/);
  assert.throws(() => parseRoutingConfig({ escalateToCliWhen: {}, default: 'local' }), /escalateToCliWhen/);
});
test('describeRules is readable', () => { assert.match(describeRules(DEFAULT_ROUTING_CONFIG), /code_task_files/); });
```
- [ ] **Step 2: Run → FAIL** — module not found.
- [ ] **Step 3: Implement `src/backends/routing-config.ts`**
```ts
import { readFile } from 'node:fs/promises';
import type { TaskType } from '../types.js';

export interface RoutingRule { taskType?: TaskType; tool?: string; minInputChars?: number; minInputTokens?: number; minFiles?: number; }
export type Tier = 'local' | 'cli';
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
  if (!raw || typeof raw !== 'object') throw new Error('routing config must be an object');
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
```
> Note: `Tier` is also exported from `src/types.ts` (Task 1); re-export here is intentional so this module is self-contained. If the implementer prefers, import `Tier` from `../types.js` instead — pick one and keep it consistent.
- [ ] **Step 4: Run → PASS**; `npm run build` → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(routing): escalation-rule config with grounded defaults"`
- [ ] **Step 6: Codex review.**

---

### Task 4: Router (NEW `src/backends/router.ts`)

**Files:** Create `src/backends/router.ts`, `test/router.test.ts`. (No index.ts.)

**Interfaces — Produces:** `class Router implements InferenceBackend`, constructor `(deps: { local: InferenceBackend; cli?: InferenceBackend; cliHasProfile?: (id: string) => boolean }, config: RoutingConfig)`, plus `describeRouting(): string`.

- [ ] **Step 1: Write the failing test** (`test/router.test.ts`)
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/backends/router.js';
import type { InferenceBackend, ChatMessage, ChatOptions, StreamingResult, ModelInfo } from '../src/types.js';
function fake(name: string): InferenceBackend {
  return {
    name,
    async chat(_m: ChatMessage[], _o: ChatOptions): Promise<StreamingResult> {
      return { content: name, rawContent: name, model: name, finishReason: 'stop', truncated: false, generationMs: 1 };
    },
    async listModels(): Promise<ModelInfo[]> { return [{ id: `${name}-m` }]; },
    async embed() { return { model: name, data: [] }; },
  };
}
const cfg = { escalateToCliWhen: [{ minInputChars: 100 }], default: 'local' as const };
const msg = (n: number): ChatMessage[] => [{ role: 'user', content: 'x'.repeat(n) }];

test('exact override → backend owning the id (no rules)', async () => {
  const r = new Router({ local: fake('local'), cli: fake('cli'), cliHasProfile: (id) => id === 'codex-a' }, cfg);
  assert.equal((await r.chat(msg(9999), { overridden: true, model: 'codex-a' })).content, 'cli');
  assert.equal((await r.chat(msg(9999), { overridden: true, model: 'gpt-oss' })).content, 'local');
});
test('tier:cli wins over rules; tier:local forces local', async () => {
  const r = new Router({ local: fake('local'), cli: fake('cli') }, cfg);
  assert.equal((await r.chat(msg(5), { tier: 'cli' })).content, 'cli');
  assert.equal((await r.chat(msg(9999), { tier: 'local' })).content, 'local');
});
test('no directive → rules decide', async () => {
  const r = new Router({ local: fake('local'), cli: fake('cli') }, cfg);
  assert.equal((await r.chat(msg(100), {})).content, 'cli');
  assert.equal((await r.chat(msg(50), {})).content, 'local');
});
test('embed always local; tier:cli with no cli → local', async () => {
  assert.equal((await new Router({ local: fake('local'), cli: fake('cli') }, cfg).chat(msg(9999), { tool: 'embed' })).content, 'local');
  assert.equal((await new Router({ local: fake('local') }, cfg).chat(msg(9999), { tier: 'cli' })).content, 'local');
});
test('listModels merges + tags tier', async () => {
  const models = await new Router({ local: fake('local'), cli: fake('cli') }, cfg).listModels();
  assert.deepEqual(models.map((m) => [m.id, m.tier]).sort(), [['cli-m', 'cli'], ['local-m', 'local']]);
});
```
- [ ] **Step 2: Run → FAIL** — module not found.
- [ ] **Step 3: Implement `src/backends/router.ts`**
```ts
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
```
- [ ] **Step 4: Run → PASS**; `npm run build` → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(routing): Router with override→tier→rules precedence"`
- [ ] **Step 6: Codex review** — precedence order + embed/tier-without-cli edges.

---

### Task 5: Attach routing to `src/index.ts` — minimal generic hooks (BASELINE EDIT — cataloged)

**Files:** Modify `src/index.ts`; Test `test/routing-wiring.test.ts`.

**This is the first of two tasks that touch the baseline. Every edit is listed; the net effect deletes more fork-specific inline branching than it adds.**

**Interfaces:** Consumes `Router` (`./backends/router.js`), `loadRoutingConfig`/`DEFAULT_ROUTING_CONFIG` (`./backends/routing-config.js`), `CliBackend`, `InferenceBackend`.

- [ ] **Step 1: Imports + one new env const + the `activeBackend` var.**
  - Add imports: `import { Router } from './backends/router.js';` and `import { loadRoutingConfig, DEFAULT_ROUTING_CONFIG } from './backends/routing-config.js';`
  - Add `const HOUTINI_LM_ROUTING_CONFIG = process.env.HOUTINI_LM_ROUTING_CONFIG || '';` next to the existing `HOUTINI_LM_*` consts (45-48).
  - Add `let activeBackend: InferenceBackend | null = null;` next to the existing `let cliBackend` (49). **Keep `cliBackend`** — `routeToModel` (1322) still reads it for `HOUTINI_LM_PROFILE` resolution.

- [ ] **Step 2: Build a thin local adapter (no path extraction).** Add near the bootstrap a small object that *references the existing functions* — nothing is moved:
```ts
function localEmbed(input: string | string[], model?: string): Promise<EmbedResult> { /* the body currently inline in the `case 'embed'` handler, lifted verbatim into this function */ }
const localBackend: InferenceBackend = {
  name: 'local',
  chat: (messages, options) => chatCompletionStreamingInner(messages, options),
  listModels: () => listModelsRaw(),
  embed: (input, model) => localEmbed(input, model),
};
```
  (Only `localEmbed` is lifted — ~10 lines moved out of the embed handler into a function the handler then calls; `chatCompletionStreamingInner` and `listModelsRaw` are referenced as-is.)

- [ ] **Step 3: Revert the fork's inline CLI branches toward baseline, replace with one generic dispatch.**
  - In `chatCompletionStreamingInner` (635-648): **delete** the `if (cliBackend) { …heartbeat… return cliBackend.chat(…) }` block. The function becomes the pure local SSE path again (closer to upstream). The heartbeat moves to Step 4.
  - In `listModelsRaw` (1089): **delete** `if (cliBackend) return cliBackend.listModels();` — pure local again.

- [ ] **Step 4: The three generic seams.**
  - `chatCompletionStreaming` (613-619): replace the body with:
```ts
  if (activeBackend) {
    if (options.progressToken === undefined) return activeBackend.chat(messages, options);
    const hb = setInterval(() => { try { server.notification({ method: 'notifications/progress', params: { progressToken: options.progressToken, progress: 0, message: 'Working…' } }); } catch { /* best-effort */ } }, PREFILL_KEEPALIVE_MS);
    try { return await activeBackend.chat(messages, options); } finally { clearInterval(hb); }
  }
  return withInferenceLock(() => chatCompletionStreamingInner(messages, options));
```
  (Make `chatCompletionStreaming` `async`. This is the heartbeat from the deleted CLI branch, now generic for any `activeBackend`.)
  - `listModelsRaw`: as the FIRST line add `if (activeBackend) return activeBackend.listModels();` (one line — replaces the deleted cli-specific one).
  - `embed` handler (2255): replace the cli-specific guard with `const be = activeBackend ?? localBackend; if (!be.embed) return { content: [{ type: 'text', text: 'Embeddings are not available with this backend.' }], isError: true }; const res = await be.embed(input, embedModel);` then format `res` exactly as the existing local handler did. (When `activeBackend` is null, `localBackend.embed` = `localEmbed` = today's path.)

- [ ] **Step 5: Add `router` mode to `initBackend` (51-58).** Prepend a branch; leave the existing cli/local logic intact:
```ts
  if (HOUTINI_LM_BACKEND === 'router') {
    if (!HOUTINI_LM_CLI_CONFIG) throw new Error('HOUTINI_LM_BACKEND=router requires HOUTINI_LM_CLI_CONFIG');
    const cfg = await loadCliConfig(HOUTINI_LM_CLI_CONFIG);
    cliBackend = new CliBackend(cfg, { alertWebhook: HOUTINI_LM_ALERT_WEBHOOK || undefined });
    const routing = HOUTINI_LM_ROUTING_CONFIG ? await loadRoutingConfig(HOUTINI_LM_ROUTING_CONFIG) : DEFAULT_ROUTING_CONFIG;
    activeBackend = new Router({ local: localBackend, cli: cliBackend, cliHasProfile: (id) => cliBackend!.hasProfile(id) }, routing);
    process.stderr.write(`[houtini-lm] router active: local + cli (${cfg.profiles.length} profile(s))\n`);
    return;
  }
```
  After the existing cli branch sets `cliBackend`, also set `activeBackend = cliBackend;` so the generic seams cover cli mode too. (Unset/openai-compat: `activeBackend` stays null → seams fall through to local exactly as today.)

- [ ] **Step 6: Write the wiring test** (`test/routing-wiring.test.ts`)
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/backends/router.js';
import { DEFAULT_ROUTING_CONFIG } from '../src/backends/routing-config.js';
import type { InferenceBackend } from '../src/types.js';
const be = (name: string): InferenceBackend => ({ name,
  async chat() { return { content: name, rawContent: name, model: name, finishReason: 'stop', truncated: false, generationMs: 1 }; },
  async listModels() { return [{ id: `${name}-m` }]; }, async embed() { return { model: name, data: [] }; } });
test('grounded defaults: code_task_files(3) → cli, small chat → local', async () => {
  const r = new Router({ local: be('local'), cli: be('cli') }, DEFAULT_ROUTING_CONFIG);
  assert.equal((await r.chat([{ role: 'user', content: 'x' }], { tool: 'code_task_files', taskType: 'code', fileCount: 3 })).content, 'cli');
  assert.equal((await r.chat([{ role: 'user', content: 'hi' }], { tool: 'chat', taskType: 'chat' })).content, 'local');
});
```

- [ ] **Step 7: Verify** — `npm run test:unit` (all pass); `npm run build` (clean); backward-compat smoke: with no env, `node dist/index.js` boots with no router/cli log (local default unchanged); router smoke: `HOUTINI_LM_BACKEND=router HOUTINI_LM_CLI_CONFIG=<pool> node dist/index.js` logs `router active`.

- [ ] **Step 8: Commit** — `git commit -m "feat(routing): attach Router to index.ts via generic activeBackend dispatch"`

- [ ] **Step 9: Codex review** — confirm (a) backward compat: unset/openai-compat/auto unchanged; (b) the deleted CLI branches are fully replaced by the generic dispatch (cli mode still works); (c) `cliBackend` still set for `HOUTINI_LM_PROFILE`; (d) heartbeat parity; (e) `index.ts` edit surface is minimal.

---

### Task 6: Caller surface — `tier` param + discovery transparency (BASELINE EDIT — cataloged)

**Files:** Modify `src/index.ts`. (Builds on Task 5.)

**The second and final baseline-editing task. Edits are confined to the tool schemas, the handler option-threading, and the two discovery handlers.**

- [ ] **Step 1: Add the `tier` param to four tool schemas.** In the `inputSchema.properties` of `chat` (1517), `custom_prompt` (1567), `code_task` (1618), `code_task_files` (1661), add:
```ts
        tier: { type: 'string', enum: ['local', 'cli'], description: 'Route to the local (cheap) or cli (powerful) tier. Omit for default rules. Ignored unless HOUTINI_LM_BACKEND=router.' },
```

- [ ] **Step 2: Thread signals from each handler into the chat options.** In the `chat`/`custom_prompt`/`code_task`/`code_task_files` handlers, where they call `chatCompletionStreaming(messages, { … })`, add `tier: args.tier, tool: '<that tool name>'` (and for `code_task_files` also `fileCount: paths.length`). These join the existing `taskType`/`overridden`.

- [ ] **Step 3: Discovery grouping.** In the `discover` (2096) and `list_models` (2228) handlers, when routing is active, group by tier and append the rules summary:
```ts
  if (activeBackend instanceof Router) {
    const models = await activeBackend.listModels();
    const byTier = (t: string) => models.filter((m) => (m as { tier?: string }).tier === t).map((m) => m.id);
    // render: `local: ${byTier('local').join(', ')}` / `cli: ${byTier('cli').join(', ')}`
    // then append: activeBackend.describeRouting()
  }
```
  Keep the existing non-router rendering unchanged (the `instanceof Router` guard makes this purely additive).

- [ ] **Step 4: Verify** — `npm run build` clean; `npm run test:unit` all pass; manual: in router mode, a `discover` call shows the `local:`/`cli:` grouping + the rules summary line.

- [ ] **Step 5: Commit** — `git commit -m "feat(routing): tier param + discover/list_models tier grouping & rules summary"`

- [ ] **Step 6: Codex review** — schema validity; `tier` ignored cleanly in non-router modes; discovery additive (no change to non-router output).

---

## Self-review

**Spec coverage:** §3.1 registry → Task 5 (`localBackend` + Router holds `{local,cli}`); §3.2 precedence → Task 4; §3.3 rules+grounded defaults → Task 3; §3.4 tieBreak/roles → Task 2; §3.5 transparency (`tier`, discover grouping, `describeRouting`) → Tasks 4+6; §3.6 activation/backcompat → Task 5; §3.7 scope → honored. ✓

**Placeholder scan:** One intentional reference rather than reproduction — `localEmbed` (Task 5 Step 2) is "the embed handler's current local body, lifted verbatim into a function." That's a ~10-line move of *existing* code, not new logic, so it isn't reproduced. Everything else is complete code.

**Type consistency:** `Tier` (types.ts Task 1 + re-exported routing-config.ts Task 3 — note flags the dup), `RoutingRule/Config/Signals` (routing-config.ts Task 3) used verbatim in Task 4; `evalEscalate(config,signals)`/`describeRules(config)` match Task 3↔4; `Router({local,cli?,cliHasProfile?},config)` matches Task 4↔5; `CliBackend.hasProfile(id)` Task 2↔5; `CliPool.listAvailable(taskType,role?)` Task 2 def+use; `localBackend: InferenceBackend` Task 5; `ModelInfo.tier` written by Router.listModels (Task 4), read by discovery (Task 6) via `ModelInfo`'s index signature. ✓

**Design note — upstream compatibility (per user direction):** All new routing logic is in NEW files (`router.ts`, `routing-config.ts`). The baseline `src/index.ts` is touched only by Tasks 5–6, and those edits **delete the fork's prior inline `cliBackend` branches** and replace them with a single generic `activeBackend` dispatch — net, `index.ts` ends up *closer* to upstream while gaining routing. The local SSE path is referenced, never relocated. This maximizes clean-merge potential with `houtini-ai/houtini-lm`.

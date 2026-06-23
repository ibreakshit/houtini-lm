# Tiered multi-backend routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Per the user's workflow: after each task's commit, run a Codex review of the diff (`codex:rescue`) and address findings before the next task.**

**Goal:** Let one houtini instance hold both a local backend and a CLI backend and route each call per-call — caller directive first, deterministic shape/size rules as the fallback — so simple work stays on cheap local models and hard work escalates to the CLI tier.

**Architecture:** Wrap the existing inline local path as an in-module `InferenceBackend` (`localBackend`); keep `CliBackend` as-is. Add a dependency-injected `Router` (new file) that, per call, resolves `(backend)` by precedence — exact override → caller `tier` → deterministic escalation rules — and delegates. A new `HOUTINI_LM_BACKEND=router` mode wires `{ local, cli }` into the Router behind the three existing seams. `openai-compat`/`cli`/`auto` modes are unchanged.

**Tech Stack:** TypeScript (ES2022, `moduleResolution: bundler`, strict), `node:test` via `tsx`. No new runtime dependencies.

## Global Constraints
- **ESM with explicit `.js` import extensions.** Node `>=18`. **No new runtime dependencies.** Strict TS (must compile under `npm run build`).
- **Opt-in + backward compatible:** the router activates ONLY under `HOUTINI_LM_BACKEND=router`. `openai-compat` / `cli` / `auto` / unset behave exactly as today; the `tier` param is ignored in those modes.
- **Routing is deterministic & upfront:** caller directive (`model`/`HOUTINI_LM_PROFILE` exact override → `tier` hint) → else escalation rules. NO cascade, NO confidence, NO classifier, NO N-tier ladder (exactly `local` + `cli`).
- **CLI escalation only moves up** (local → cli, never down). `embed` is always local (CLI can't embed). `tier:"cli"` with no CLI configured → local + a one-line stderr note.
- **CLI tie-break:** explicit role match → else `tieBreak` (`first-loaded` default | `round-robin` opt-in) → cooldown/auth failover.
- **Grounded escalation defaults** (from `houtini-lm-usage.md`, 2026-06-21 gpt-oss shakedown): `code_task_files` ≥2 files; any input ≥28 000 chars; `analysis` ≥12 000 chars; `code` ≥16 000 chars; else local.
- **The local SSE path must remain behavior-identical** after being wrapped as a backend (same streaming, footer, reasoning handling, stats, `withInferenceLock` serialization).

---

## File structure
```
src/types.ts                       MODIFY  + Tier, RoutingRule, RoutingConfig, RoutingSignals; extend ChatOptions (tier, tool, fileCount)
src/backends/cli/profiles.ts       MODIFY  + CliProfile.roles?; CliConfig.tieBreak?; validate both
src/backends/cli/pool.ts           MODIFY  role-aware + tieBreak-aware selection; CliBackend gets hasProfile()
src/backends/cli/index.ts          MODIFY  CliBackend.hasProfile(id); pass role into pool select
src/backends/routing-config.ts     CREATE  parse/validate rules; evalEscalate(); describeRules()
src/backends/router.ts             CREATE  Router (InferenceBackend): precedence + dispatch + listModels merge + describeRouting()
src/index.ts                       MODIFY  wrap local path as localBackend; HOUTINI_LM_BACKEND=router bootstrap; seams → activeBackend; tier param + thread tool/fileCount; discover/list_models tier grouping
test/routing-config.test.ts        CREATE
test/router.test.ts                CREATE
test/cli-pool.test.ts              MODIFY  + tieBreak/role cases
test/routing-wiring.test.ts        CREATE
```

---

### Task 1: Routing types + ChatOptions extension

**Files:** Modify `src/types.ts`; Test `test/router.test.ts` (created in Task 4 consumes these — this task is type-only + a compile check).

**Interfaces — Produces:**
```ts
export type Tier = 'local' | 'cli';
export interface RoutingRule {
  taskType?: TaskType;
  tool?: string;
  minInputChars?: number;
  minInputTokens?: number;   // compared against chars/4 estimate
  minFiles?: number;
}
export interface RoutingConfig { escalateToCliWhen: RoutingRule[]; default: Tier; }
export interface RoutingSignals { taskType?: TaskType; tool?: string; inputChars: number; fileCount: number; }
```
ChatOptions gains: `tier?: Tier;` `tool?: string;` `fileCount?: number;`

- [ ] **Step 1: Add the types**

In `src/types.ts`, after the `EmbedResult` interface add the block above. Then extend `ChatOptions` (currently lines 69-78) by adding three optional fields:
```ts
  tier?: Tier;            // caller routing directive (router mode)
  tool?: string;          // originating tool name, for routing rules
  fileCount?: number;     // code_task_files path count, for routing rules
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: clean compile (these are additive optional fields + new exports; nothing else changes).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(routing): add Tier/RoutingRule/RoutingConfig types + ChatOptions routing fields"
```

- [ ] **Step 4: Codex review** the diff; address findings.

---

### Task 2: CLI pool — `tieBreak` + role-aware selection

**Files:** Modify `src/backends/cli/profiles.ts`, `src/backends/cli/pool.ts`, `src/backends/cli/index.ts`; Test `test/cli-pool.test.ts`.

**Interfaces:**
- Consumes: `CliProfile`, `CliConfig`, `TaskType`.
- Produces: `CliConfig.tieBreak?: 'first-loaded' | 'round-robin'`; `CliProfile.roles?: string[]`; `CliPool.listAvailable(taskType, role?)`; `CliBackend.hasProfile(id): boolean`.

- [ ] **Step 1: Write the failing tests** (append to `test/cli-pool.test.ts`)

```ts
test('tieBreak first-loaded keeps config order (no rotation)', () => {
  const cfg: CliConfig = { tieBreak: 'first-loaded', profiles: [
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
  ]};
  let t = 1000; const pool = new CliPool(cfg, () => t);
  const first = pool.listAvailable('chat')[0].id;
  pool.markUsed(first); t = 1001;
  assert.equal(pool.listAvailable('chat')[0].id, first);   // first-loaded does NOT rotate
});

test('tieBreak round-robin rotates by LRU', () => {
  const cfg: CliConfig = { tieBreak: 'round-robin', profiles: [
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
  ]};
  let t = 1000; const pool = new CliPool(cfg, () => t);
  const first = pool.listAvailable('chat')[0].id;
  pool.markUsed(first); t = 1001;
  assert.notEqual(pool.listAvailable('chat')[0].id, first); // round-robin rotates
});

test('explicit role match beats tie-break order', () => {
  const cfg: CliConfig = { tieBreak: 'first-loaded', profiles: [
    { id: 'a', provider: 'codex', bin: 'codex', model: 'm', capabilities: ['chat'] },
    { id: 'b', provider: 'claude', bin: 'claude', model: 'm', capabilities: ['chat'], roles: ['prose'] },
  ]};
  const pool = new CliPool(cfg, () => 1000);
  assert.equal(pool.listAvailable('chat', 'prose')[0].id, 'b'); // role wins over first-loaded
});
```

- [ ] **Step 2: Run → FAIL**

Run: `npx tsx --test test/cli-pool.test.ts`
Expected: FAIL (`tieBreak`/`roles` not accepted; `listAvailable` arity).

- [ ] **Step 3: Implement**

In `src/backends/cli/profiles.ts`:
- Add to `CliProfile`: `roles?: string[];`
- Add to `CliConfig`: `tieBreak?: 'first-loaded' | 'round-robin';`
- In `parseCliConfig`: accept `roles` (must be a string array if present; else throw `profiles[i]: "roles" must be an array of strings`); accept top-level `tieBreak` (must be `'first-loaded'` | `'round-robin'` if present, default left undefined → pool treats as `'first-loaded'`); set `roles` only when present. Keep existing validation intact.

In `src/backends/cli/pool.ts`, replace `listAvailable` with a role+tieBreak-aware version:
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
            : index.get(a.id)! - index.get(b.id)!));   // first-loaded = config order
}
```

In `src/backends/cli/index.ts` (`CliBackend`): add `hasProfile(id: string): boolean { return this.pool.get(id) !== undefined; }`, and where `chat()` calls `pool.listAvailable(taskType)`, pass the role: `pool.listAvailable(taskType, options.taskType)` — MVP role == taskType (so a profile that declares `roles: ['analysis']` is preferred for analysis tasks). Keep override/failover logic unchanged.

- [ ] **Step 4: Run → PASS** (`npx tsx --test test/cli-pool.test.ts`), then `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/backends/cli/profiles.ts src/backends/cli/pool.ts src/backends/cli/index.ts test/cli-pool.test.ts
git commit -m "feat(cli): role-aware selection + configurable tieBreak (first-loaded default, round-robin opt-in)"
```

- [ ] **Step 6: Codex review.**

---

### Task 3: Routing config (rules parse + evaluate + describe)

**Files:** Create `src/backends/routing-config.ts`, `test/routing-config.test.ts`.

**Interfaces:**
- Consumes: `RoutingRule`, `RoutingConfig`, `RoutingSignals` (`../types.js`).
- Produces: `parseRoutingConfig(raw): RoutingConfig`; `loadRoutingConfig(path): Promise<RoutingConfig>`; `evalEscalate(config, signals): boolean`; `describeRules(config): string`; `DEFAULT_ROUTING_CONFIG`.

- [ ] **Step 1: Write the failing test** (`test/routing-config.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutingConfig, evalEscalate, describeRules, DEFAULT_ROUTING_CONFIG } from '../src/backends/routing-config.js';

const sig = (o = {}) => ({ taskType: undefined, tool: undefined, inputChars: 0, fileCount: 0, ...o });

test('default config: code_task_files >=2 files escalates', () => {
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ tool: 'code_task_files', fileCount: 2 })), true);
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ tool: 'code_task_files', fileCount: 1 })), false);
});
test('default config: input >=28000 chars escalates', () => {
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ inputChars: 28000 })), true);
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ inputChars: 27999 })), false);
});
test('default config: analysis >=12000 chars escalates, small analysis stays local', () => {
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ taskType: 'analysis', inputChars: 12000 })), true);
  assert.equal(evalEscalate(DEFAULT_ROUTING_CONFIG, sig({ taskType: 'analysis', inputChars: 5000 })), false);
});
test('minInputTokens compares chars/4', () => {
  const cfg = parseRoutingConfig({ escalateToCliWhen: [{ minInputTokens: 1000 }], default: 'local' });
  assert.equal(evalEscalate(cfg, sig({ inputChars: 4000 })), true);   // 4000/4 = 1000
  assert.equal(evalEscalate(cfg, sig({ inputChars: 3996 })), false);
});
test('AND within a rule, OR across rules', () => {
  const cfg = parseRoutingConfig({ escalateToCliWhen: [{ taskType: 'code', minInputChars: 100 }], default: 'local' });
  assert.equal(evalEscalate(cfg, sig({ taskType: 'code', inputChars: 100 })), true);
  assert.equal(evalEscalate(cfg, sig({ taskType: 'code', inputChars: 50 })), false);  // size fails → no match
  assert.equal(evalEscalate(cfg, sig({ taskType: 'chat', inputChars: 9999 })), false); // taskType fails
});
test('parse rejects bad default and non-array rules', () => {
  assert.throws(() => parseRoutingConfig({ escalateToCliWhen: [], default: 'bogus' }), /default/);
  assert.throws(() => parseRoutingConfig({ escalateToCliWhen: {}, default: 'local' }), /escalateToCliWhen/);
});
test('describeRules produces a readable summary', () => {
  const s = describeRules(DEFAULT_ROUTING_CONFIG);
  assert.match(s, /code_task_files/);
  assert.match(s, /local/);
});
```

- [ ] **Step 2: Run → FAIL** (`npx tsx --test test/routing-config.test.ts`) — module not found.

- [ ] **Step 3: Implement `src/backends/routing-config.ts`**

```ts
import { readFile } from 'node:fs/promises';
import type { RoutingRule, RoutingConfig, RoutingSignals, Tier, TaskType } from '../types.js';

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
    for (const k of ['minInputChars', 'minInputTokens', 'minFiles'] as const)
      if (rr[k] !== undefined && typeof rr[k] !== 'number') throw new Error(`escalateToCliWhen[${i}]: "${k}" must be a number`);
    if (rr.tool !== undefined && typeof rr.tool !== 'string') throw new Error(`escalateToCliWhen[${i}]: "tool" must be a string`);
    return {
      taskType: rr.taskType as TaskType | undefined,
      tool: rr.tool as string | undefined,
      minInputChars: rr.minInputChars as number | undefined,
      minInputTokens: rr.minInputTokens as number | undefined,
      minFiles: rr.minFiles as number | undefined,
    };
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

/** True → escalate to CLI. Any rule matching (OR); conditions within a rule are ANDed. */
export function evalEscalate(config: RoutingConfig, signals: RoutingSignals): boolean {
  if (config.escalateToCliWhen.some((r) => ruleMatches(r, signals))) return true;
  return config.default === 'cli';
}

export function describeRules(config: RoutingConfig): string {
  const parts = config.escalateToCliWhen.map((r) => {
    const conds: string[] = [];
    if (r.tool) conds.push(`tool=${r.tool}`);
    if (r.taskType) conds.push(`${r.taskType}`);
    if (r.minFiles) conds.push(`≥${r.minFiles} files`);
    if (r.minInputChars) conds.push(`≥${r.minInputChars} chars`);
    if (r.minInputTokens) conds.push(`≥${r.minInputTokens} tok`);
    return conds.join(' & ');
  });
  return `defaults → CLI for: ${parts.join(' · ')}; else ${config.default}`;
}
```

- [ ] **Step 4: Run → PASS** (`npx tsx --test test/routing-config.test.ts`); `npm run build` → clean.

- [ ] **Step 5: Commit** `git commit -m "feat(routing): escalation-rule config (parse, evaluate, describe) with grounded defaults"`

- [ ] **Step 6: Codex review.**

---

### Task 4: Router

**Files:** Create `src/backends/router.ts`, `test/router.test.ts`.

**Interfaces:**
- Consumes: `InferenceBackend`, `ChatMessage`, `ChatOptions`, `StreamingResult`, `ModelInfo`, `EmbedResult`, `RoutingConfig`, `RoutingSignals` (`../types.js`); `evalEscalate`, `describeRules` (`./routing-config.js`).
- Produces: `class Router implements InferenceBackend` with constructor `(deps: { local: InferenceBackend; cli?: InferenceBackend; cliHasProfile?: (id: string) => boolean }, config: RoutingConfig)`, plus `describeRouting(): string`.

- [ ] **Step 1: Write the failing test** (`test/router.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/backends/router.js';
import type { InferenceBackend, ChatMessage, ChatOptions, StreamingResult, ModelInfo } from '../src/types.js';

function fake(name: string): InferenceBackend & { calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  return {
    name, calls,
    async chat(_m: ChatMessage[], o: ChatOptions): Promise<StreamingResult> {
      calls.push(o);
      return { content: name, rawContent: name, model: name, finishReason: 'stop', truncated: false, generationMs: 1 };
    },
    async listModels(): Promise<ModelInfo[]> { return [{ id: `${name}-m` }]; },
    async embed() { return { model: name, data: [] }; },
  };
}
const cfg = { escalateToCliWhen: [{ minInputChars: 100 }], default: 'local' as const };
const msg = (chars: number): ChatMessage[] => [{ role: 'user', content: 'x'.repeat(chars) }];

test('exact override → backend that owns the id (verbatim, no rules)', async () => {
  const local = fake('local'), cli = fake('cli');
  const r = new Router({ local, cli, cliHasProfile: (id) => id === 'codex-a' }, cfg);
  assert.equal((await r.chat(msg(9999), { overridden: true, model: 'codex-a' })).content, 'cli');
  assert.equal((await r.chat(msg(9999), { overridden: true, model: 'gpt-oss' })).content, 'local');
});
test('caller tier:cli wins over rules; tier:local forces local', async () => {
  const local = fake('local'), cli = fake('cli');
  const r = new Router({ local, cli }, cfg);
  assert.equal((await r.chat(msg(5), { tier: 'cli' })).content, 'cli');   // tiny but caller said cli
  assert.equal((await r.chat(msg(9999), { tier: 'local' })).content, 'local'); // big but caller said local
});
test('no directive → rules decide', async () => {
  const local = fake('local'), cli = fake('cli');
  const r = new Router({ local, cli }, cfg);
  assert.equal((await r.chat(msg(100), {})).content, 'cli');   // >=100 escalates
  assert.equal((await r.chat(msg(50), {})).content, 'local');
});
test('embed always local; tier:cli with no cli → local', async () => {
  const local = fake('local');
  const r1 = new Router({ local, cli: fake('cli') }, cfg);
  assert.equal((await r1.chat(msg(9999), { tool: 'embed' })).content, 'local');
  const r2 = new Router({ local }, cfg);   // no cli
  assert.equal((await r2.chat(msg(9999), { tier: 'cli' })).content, 'local');
});
test('listModels merges + tags tier', async () => {
  const r = new Router({ local: fake('local'), cli: fake('cli') }, cfg);
  const models = await r.listModels();
  assert.deepEqual(models.map((m) => [m.id, m.tier]).sort(), [['cli-m', 'cli'], ['local-m', 'local']]);
});
```

- [ ] **Step 2: Run → FAIL** — module not found.

- [ ] **Step 3: Implement `src/backends/router.ts`**

```ts
import type {
  InferenceBackend, ChatMessage, ChatOptions, StreamingResult, ModelInfo, EmbedResult,
  RoutingConfig, RoutingSignals,
} from '../types.js';
import { evalEscalate, describeRules } from './routing-config.js';

const CALLER_GUIDANCE =
  'Escalate with tier:"cli" for correctness-critical reasoning, subtle-bug hunts, whole-module ' +
  'generation, or current/niche-knowledge tasks (no size signal). Local is fast and reliable for ' +
  'single-function review, test stubs, explainers, and reformatting.';

export class Router implements InferenceBackend {
  name = 'router';
  private local: InferenceBackend;
  private cli?: InferenceBackend;
  private cliHasProfile: (id: string) => boolean;
  constructor(
    deps: { local: InferenceBackend; cli?: InferenceBackend; cliHasProfile?: (id: string) => boolean },
    private config: RoutingConfig,
  ) {
    this.local = deps.local;
    this.cli = deps.cli;
    this.cliHasProfile = deps.cliHasProfile ?? (() => false);
  }

  private inputChars(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }

  private pick(messages: ChatMessage[], options: ChatOptions): InferenceBackend {
    // 1. exact override → backend that owns the id (the backend itself runs it verbatim)
    if (options.overridden && options.model) {
      return (this.cli && this.cliHasProfile(options.model)) ? this.cli : this.local;
    }
    // 2. embed never escalates
    if (options.tool === 'embed') return this.local;
    // 3. caller tier directive
    if (options.tier === 'cli') return this.cli ?? this.noteAndLocal();
    if (options.tier === 'local' || !this.cli) return this.local;
    // 4. fallback rules
    const signals: RoutingSignals = {
      taskType: options.taskType, tool: options.tool,
      inputChars: this.inputChars(messages), fileCount: options.fileCount ?? 0,
    };
    return evalEscalate(this.config, signals) ? this.cli : this.local;
  }
  private noteAndLocal(): InferenceBackend {
    process.stderr.write('[houtini-lm][router] tier:"cli" requested but no CLI backend configured — using local\n');
    return this.local;
  }

  chat(messages: ChatMessage[], options: ChatOptions): Promise<StreamingResult> {
    return this.pick(messages, options).chat(messages, options);
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
  describeRouting(): string {
    return `${describeRules(this.config)}\n${CALLER_GUIDANCE}`;
  }
}
```

- [ ] **Step 4: Run → PASS**; `npm run build` → clean.

- [ ] **Step 5: Commit** `git commit -m "feat(routing): Router with override→tier→rules precedence + tier-tagged listModels"`

- [ ] **Step 6: Codex review** — focus on precedence order + the embed/tier-without-cli edges.

---

### Task 5: Wrap the local path as an `InferenceBackend`

**Files:** Modify `src/index.ts`; Test `test/routing-wiring.test.ts` (smoke added in Task 6).

**Interfaces:** Produces a module-level `localBackend: InferenceBackend` whose `chat`/`listModels`/`embed` are the existing local code paths, behavior-identical.

- [ ] **Step 1: Extract the local bodies into named functions (no behavior change)**
- `chatCompletionStreamingInner` (index.ts:~635): today it is `if (cliBackend) {…cli…}` followed by the inline local SSE path. **Move the local SSE body** (everything after the `if (cliBackend)` block) into a new `async function localChatStreaming(messages, options): Promise<StreamingResult>` in the same module (it keeps referencing `LM_BASE_URL`, `apiHeaders`, `fetchWithTimeout`/`fetchWithRetry`, `getProviderProfile`, the model-cache helpers, `server`, and the module constants — all still in scope). Wrap it so local serialization is preserved: `localChatStreaming` itself calls `withInferenceLock(...)` around the SSE work (this moves the lock from `chatCompletionStreaming` into the local backend, where it belongs).
- `listModelsRaw` (index.ts:~1089): keep the local body as `localListModelsRaw()` (the existing function minus the `if (cliBackend)` line).
- The `embed` handler's local fetch (index.ts:~2260): extract the local embeddings fetch into `async function localEmbed(input, model?): Promise<EmbedResult>` returning the existing shape.

- [ ] **Step 2: Build the backend object** (near the other backend bootstrap, ~index.ts:49):
```ts
const localBackend: InferenceBackend = {
  name: 'local',
  chat: (messages, options) => localChatStreaming(messages, options),
  listModels: () => localListModelsRaw(),
  embed: (input, model) => localEmbed(input, model),
};
```

- [ ] **Step 3: Verify behavior-identical**

Run: `npm run build` → clean.
Run: `npm run test:unit` → all existing tests pass.
Smoke (local path unchanged): `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | node dist/index.js` should boot without the CLI/router env and log the normal local startup (no behavior change). (Full local inference is covered by the existing `test.mjs` against a live endpoint — out of scope here.)

- [ ] **Step 4: Commit** `git commit -m "refactor(backend): wrap local SSE path as an in-module InferenceBackend (no behavior change)"`

- [ ] **Step 5: Codex review** — this touches the hot local path; ask for a careful "behavior-identical" check (lock placement, footer/reasoning handling, no dropped branches).

---

### Task 6: Bootstrap the router + wire seams + `tier` param + discovery

**Files:** Modify `src/index.ts`; Test `test/routing-wiring.test.ts`.

**Interfaces:** Consumes `localBackend` (Task 5), `CliBackend`, `Router`, `loadRoutingConfig`/`DEFAULT_ROUTING_CONFIG`.

- [ ] **Step 1: Generalize the active backend + add `router` mode**

Replace the `cliBackend: CliBackend | null` global and `initBackend` (index.ts:49-58) with an `activeBackend`:
```ts
let activeBackend: InferenceBackend | null = null;   // null ⇒ use localBackend inline default
let cliBackend: CliBackend | null = null;            // kept for HOUTINI_LM_PROFILE resolution in routeToModel
const HOUTINI_LM_ROUTING_CONFIG = process.env.HOUTINI_LM_ROUTING_CONFIG || '';

async function initBackend(): Promise<void> {
  if (HOUTINI_LM_BACKEND === 'router') {
    if (!HOUTINI_LM_CLI_CONFIG) throw new Error('HOUTINI_LM_BACKEND=router requires HOUTINI_LM_CLI_CONFIG');
    const cfg = await loadCliConfig(HOUTINI_LM_CLI_CONFIG);
    cliBackend = new CliBackend(cfg, { alertWebhook: HOUTINI_LM_ALERT_WEBHOOK || undefined });
    const routing = HOUTINI_LM_ROUTING_CONFIG ? await loadRoutingConfig(HOUTINI_LM_ROUTING_CONFIG) : DEFAULT_ROUTING_CONFIG;
    activeBackend = new Router(
      { local: localBackend, cli: cliBackend, cliHasProfile: (id) => cliBackend!.hasProfile(id) },
      routing,
    );
    process.stderr.write(`[houtini-lm] router active: local + cli (${cfg.profiles.length} profile(s))\n`);
    return;
  }
  if (shouldUseCli(HOUTINI_LM_BACKEND, HOUTINI_LM_CLI_CONFIG)) {   // existing cli mode
    if (!HOUTINI_LM_CLI_CONFIG) throw new Error('HOUTINI_LM_BACKEND=cli requires HOUTINI_LM_CLI_CONFIG to be set');
    cliBackend = new CliBackend(await loadCliConfig(HOUTINI_LM_CLI_CONFIG), { alertWebhook: HOUTINI_LM_ALERT_WEBHOOK || undefined });
    activeBackend = cliBackend;
    process.stderr.write(`[houtini-lm] CLI backend active: ...\n`);
    return;
  }
  // openai-compat / auto / unset → local default (activeBackend stays null → seams use localBackend)
}
```

- [ ] **Step 2: Point the three seams at `activeBackend ?? localBackend`**
- `chatCompletionStreaming` (613-619): replace the `if (cliBackend) … else withInferenceLock(…)` body with `return (activeBackend ?? localBackend).chat(messages, options);` (local serialization now lives inside `localBackend.chat` per Task 5, so no `withInferenceLock` here).
- `chatCompletionStreamingInner`: the `if (cliBackend) {…}` branch (635-648) is removed — its job (delegating to the CLI backend + heartbeat) now happens via `activeBackend`. The heartbeat wrapper moves into a thin shim inside `localChatStreaming`/CLI as already present, or stays in `chat` dispatch; keep the existing CLI heartbeat behavior by leaving it in `CliBackend`/the seam as-is. **(Simplest: keep `chatCompletionStreamingInner` as the local impl only; `chat()` dispatch goes through `activeBackend`.)**
- `listModelsRaw` (1089): `if (activeBackend) return activeBackend.listModels(); return localListModelsRaw();`
- `embed` handler (2255-2260): `const be = activeBackend ?? localBackend; if (!be.embed) return <unsupported text>; return be.embed(input, model);` (Router.embed routes to local; CLI-only mode still returns unsupported as today.)

- [ ] **Step 3: Add the `tier` param + thread `tool`/`fileCount`**
- In the `chat`/`code_task`/`code_task_files`/`custom_prompt` tool input schemas (1517/1618/1661/1567), add:
  ```ts
  tier: { type: 'string', enum: ['local', 'cli'], description: 'Route to the local (cheap) or cli (powerful) tier. Omit to use the default routing rules. Ignored unless HOUTINI_LM_BACKEND=router.' },
  ```
- In each handler, pass into the `chatCompletionStreaming(messages, {…})` options: `tier: args.tier`, `tool: '<that tool name>'`, and for `code_task_files` also `fileCount: paths.length`. (These join the existing `taskType`/`overridden`.)

- [ ] **Step 4: Discovery transparency** — in the `discover` (2096) and `list_models` (2228) handlers, when `activeBackend instanceof Router`, group the `listModels()` output by each `ModelInfo.tier` (`local:` / `cli:`) and append `activeBackend.describeRouting()`. (When not a Router, render as today.)

- [ ] **Step 5: Write the wiring test** (`test/routing-wiring.test.ts`)
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/backends/router.js';
import { DEFAULT_ROUTING_CONFIG } from '../src/backends/routing-config.js';
import type { InferenceBackend } from '../src/types.js';
const be = (name: string): InferenceBackend => ({
  name, async chat() { return { content: name, rawContent: name, model: name, finishReason: 'stop', truncated: false, generationMs: 1 }; },
  async listModels() { return [{ id: `${name}-m` }]; }, async embed() { return { model: name, data: [] }; },
});
test('router with grounded defaults: code_task_files(3 files) → cli, small chat → local', async () => {
  const r = new Router({ local: be('local'), cli: be('cli') }, DEFAULT_ROUTING_CONFIG);
  assert.equal((await r.chat([{ role: 'user', content: 'x' }], { tool: 'code_task_files', taskType: 'code', fileCount: 3 })).content, 'cli');
  assert.equal((await r.chat([{ role: 'user', content: 'hi' }], { tool: 'chat', taskType: 'chat' })).content, 'local');
});
```

- [ ] **Step 6: Verify**

Run: `npm run test:unit` → all pass.
Run: `npm run build` → clean.
Smoke (router mode, no quota): write a pool config + `HOUTINI_LM_BACKEND=router HOUTINI_LM_CLI_CONFIG=<pool> node dist/index.js` and confirm stderr logs `router active: local + cli`. Backward-compat smoke: unset env → no router log (local default).

- [ ] **Step 7: Commit** `git commit -m "feat(routing): HOUTINI_LM_BACKEND=router mode — wire Router into seams, add tier param + discovery transparency"`

- [ ] **Step 8: Codex review** — riskiest task (touches index.ts seams + bootstrap). Focus: backward compat (non-router modes unchanged), `activeBackend ?? localBackend` correctness, the `cliBackend` reference still set for `HOUTINI_LM_PROFILE` resolution in `routeToModel`, lock placement.

---

## Self-review

**Spec coverage:** §3.1 registry → Tasks 5+6 (localBackend + Router holds {local,cli}); §3.2 precedence → Task 4; §3.3 rules+grounded defaults → Task 3; §3.4 tieBreak/roles → Task 2; §3.5 transparency (`tier` param, discover grouping, describeRouting) → Tasks 4+6; §3.6 activation/backcompat → Task 6; §3.7 scope (no cascade/classifier) → honored (deterministic rules only). ✓

**Placeholder scan:** No TBD/TODO. The local-path extraction (Task 5) references existing code by location rather than reproducing ~350 lines — intentional and explicit (it is a move, not new code). Every NEW unit (types, pool change, routing-config, Router) has complete code + tests.

**Type consistency:** `Tier`, `RoutingRule`, `RoutingConfig`, `RoutingSignals`, `ChatOptions.{tier,tool,fileCount}` defined in Task 1 and consumed verbatim in Tasks 3–6. `evalEscalate(config, signals)` / `describeRules(config)` signatures match between Task 3 (def) and Task 4 (use). `Router` constructor `({local,cli?,cliHasProfile?}, config)` matches between Task 4 (def) and Task 6 (bootstrap). `CliBackend.hasProfile(id)` defined Task 2, used Task 6. `CliPool.listAvailable(taskType, role?)` defined Task 2, used by `CliBackend` (Task 2 step 3). `localBackend: InferenceBackend` defined Task 5, used Task 6. `ModelInfo.tier` written by Router.listModels (Task 4) and read by discovery (Task 6) — relies on `ModelInfo`'s `[key:string]: unknown` index signature (present). ✓

**Deviation from spec (flagged):** §4 listed `src/backends/openai-compat.ts` as a new file; this plan keeps the local path in `index.ts` wrapped as `localBackend` (Task 5) to avoid extracting its deep module coupling (apiHeaders/fetch/getProviderProfile/server/constants). Same outcome — local is a first-class `InferenceBackend` — at much lower risk. The `Router` is the separable new unit instead.

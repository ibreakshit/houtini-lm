# houtini-lm CLI Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `cli` inference backend to houtini-lm that delegates tasks to local LLM CLIs (`codex`, `gemini`, `claude`, `llm`) in single-response mode, pooling multiple subscriptions with round-robin/LRU selection and cooldown failover.

**Architecture:** Introduce an `InferenceBackend` interface. The existing OpenAI-compatible path stays inline as the default; a self-contained `CliBackend` (under `src/backends/cli/`) is selected when `HOUTINI_LM_BACKEND=cli`. Integration is three early-return branches in `index.ts` (`chatCompletionStreamingInner`, `listModelsRaw`, the `embed` handler) plus a one-field addition to `routeToModel`. All 8 tools, the footer, stats, and model-cache are untouched.

**Tech Stack:** TypeScript (ES2022, `moduleResolution: bundler`, strict), `@modelcontextprotocol/sdk`, Node `child_process`. Tests: `node:test` run via `tsx` (new devDependency). No other new runtime deps.

## Global Constraints

- **ESM with explicit `.js` import extensions** (e.g. `import { x } from './profiles.js'`) — required at runtime; matches existing code.
- **Node `>=18`** (from `package.json` engines); `child_process`, `fetch`, `node:test` are all available.
- **No new runtime dependencies.** Only `tsx` as a devDependency for tests.
- **Backward compatible:** when `HOUTINI_LM_BACKEND` is unset/`openai-compat`, behaviour is byte-for-byte the existing path. The CLI backend is purely additive.
- **Preserve selection semantics (spec D3/D4/D6):** explicit override → verbatim, no failover; otherwise capability score → round-robin/LRU tie-break → cooldown/auth failover (capability-routed picks only).
- **Agentic lockdown is mandatory:** every adapter must invoke its CLI in non-agentic, read-only, no-tool single-response mode.
- **No silent auth failures:** auth errors log (`[houtini-lm][AUTH]`), surface to the caller, mark the profile `auth-blocked`, and optionally POST to `HOUTINI_LM_ALERT_WEBHOOK`.
- **Strict types:** new shared types live in `src/types.ts`; all new code imports from there.
- **Per task:** after the task's commit, run a **Codex code review** of that task's diff (via the `codex:rescue` skill) and address findings before the next task.

---

## File Structure

```
src/types.ts                          # shared types + InferenceBackend, ChatOptions, TaskType, EmbedResult (moved/added)
src/backends/cli/profiles.ts          # Provider, CliProfile, CliConfig, parseCliConfig, loadCliConfig, profileToModelInfo
src/backends/cli/exec.ts              # runProcess(): injectable spawn wrapper, ProcessResult
src/backends/cli/adapters/types.ts    # CliAdapter, Invocation, ParsedOutput, CliErrorKind
src/backends/cli/adapters/codex.ts    # codex exec adapter
src/backends/cli/adapters/gemini.ts   # gemini -p adapter
src/backends/cli/adapters/claude.ts   # claude -p adapter
src/backends/cli/adapters/llm.ts      # llm adapter
src/backends/cli/adapters/custom.ts   # config-driven generic adapter
src/backends/cli/adapters/index.ts    # getAdapter(provider) registry
src/backends/cli/alert.ts             # sendAlert() webhook
src/backends/cli/pool.ts              # CliPool, scoreProfileForTask, ProfileState
src/backends/cli/index.ts             # CliBackend implements InferenceBackend; CliError
src/index.ts                          # MODIFY: import types; backend bootstrap; 3 seam branches; routeToModel.overridden; handler taskType/overridden; heartbeat wrap
test/types.test.ts
test/cli-profiles.test.ts
test/cli-exec.test.ts
test/cli-adapters.test.ts
test/cli-pool.test.ts
test/cli-backend.test.ts
test/cli-auth.test.ts
docs/examples/cli-config.example.json # sample profile pool
README.md                             # MODIFY: CLI backend section
.env.example or README env table      # MODIFY: new env vars
```

---

### Task 1: Test tooling + shared types

**Files:**
- Modify: `package.json` (add `tsx` devDep + `test:unit` script)
- Create: `src/types.ts`
- Modify: `src/index.ts:264-305` (remove the four moved interfaces) and `src/index.ts:9-33` (add import)
- Test: `test/types.test.ts`

**Interfaces:**
- Produces: `ChatMessage`, `StreamingResult`, `ResponseFormat`, `ModelInfo` (moved verbatim from index.ts), plus new `TaskType = 'code'|'chat'|'analysis'|'embedding'`, `ChatOptions`, `EmbedResult`, `InferenceBackend`.

```ts
// ChatOptions and InferenceBackend signatures (canonical for all later tasks)
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  responseFormat?: ResponseFormat;
  progressToken?: string | number;
  taskType?: TaskType;          // drives CLI pool capability scoring
  overridden?: boolean;         // true when model came from an explicit user override (D6)
  onProgress?: (message: string) => void;
}
export interface EmbedResult {
  model: string;
  data: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens: number; total_tokens: number };
}
export interface InferenceBackend {
  name: string;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<StreamingResult>;
  listModels(): Promise<ModelInfo[]>;
  embed?(input: string | string[], model?: string): Promise<EmbedResult>;
}
```

- [ ] **Step 0: Create the working branch and commit existing docs**

```bash
cd ~/houtini-lm
git checkout -b feat/cli-backend
git add docs/specs/2026-06-22-cli-delegation-design.md docs/plans/2026-06-22-cli-backend-implementation.md
git commit -m "docs: add CLI-delegation spec and implementation plan"
```

- [ ] **Step 1: Add tsx + test script**

In `package.json`, add to `devDependencies`: `"tsx": "^4.19.0"`. Add to `scripts`: `"test:unit": "tsx --test test/*.test.ts"`. Then:

```bash
npm install
```

- [ ] **Step 2: Write the failing test**

`test/types.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InferenceBackend, ChatMessage, StreamingResult, ModelInfo } from '../src/types.js';

test('a minimal object can satisfy InferenceBackend', async () => {
  const fake: InferenceBackend = {
    name: 'fake',
    async chat(_messages: ChatMessage[]): Promise<StreamingResult> {
      return { content: 'hi', rawContent: 'hi', model: 'm', finishReason: 'stop', truncated: false, generationMs: 1 };
    },
    async listModels(): Promise<ModelInfo[]> { return [{ id: 'm' }]; },
  };
  const out = await fake.chat([{ role: 'user', content: 'x' }], {});
  assert.equal(out.content, 'hi');
  const models = await fake.listModels();
  assert.equal(models[0].id, 'm');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test test/types.test.ts`
Expected: FAIL — `Cannot find module '../src/types.js'`.

- [ ] **Step 4: Create `src/types.ts`**

Cut the `ChatMessage` (264-267), `StreamingResult` (269-295), `ResponseFormat` (297-305), and `ModelInfo` (307-323) interfaces from `src/index.ts`, paste into `src/types.ts`, prefix each with `export`, then append the new types:
```ts
// src/types.ts — paste the 4 interfaces here with `export` added, then:
export type TaskType = 'code' | 'chat' | 'analysis' | 'embedding';
// ...ChatOptions, EmbedResult, InferenceBackend exactly as in the Interfaces block above.
```
In `src/index.ts`, after the existing `model-cache.js` import (line 31), add:
```ts
import type {
  ChatMessage, StreamingResult, ResponseFormat, ModelInfo,
  TaskType, ChatOptions, EmbedResult, InferenceBackend,
} from './types.js';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx tsx --test test/types.test.ts` → Expected: PASS.
Run: `npm run build` → Expected: clean compile (no TS errors; confirms index.ts still type-checks against the moved types).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/types.ts src/index.ts test/types.test.ts
git commit -m "feat: add shared backend types and tsx unit-test runner"
```

- [ ] **Step 7: Codex review** — review the diff with `codex:rescue`; address findings.

---

### Task 2: CLI profile config loader

**Files:**
- Create: `src/backends/cli/profiles.ts`
- Test: `test/cli-profiles.test.ts`

**Interfaces:**
- Consumes: `ModelInfo`, `TaskType` from `../../types.js`.
- Produces:
```ts
export type Provider = 'codex' | 'gemini' | 'claude' | 'llm' | 'custom';
export interface CliProfile {
  id: string; provider: Provider; bin: string; model: string;
  configHome?: string; capabilities: TaskType[]; contextWindow?: number;
  concurrency?: number; weight?: number; enabled?: boolean;
  argvTemplate?: string[]; promptVia?: 'stdin' | 'arg'; parse?: 'text' | 'json'; jsonPath?: string;
}
export interface CliConfig { profiles: CliProfile[]; defaults?: { timeoutMs?: number; cooldownMs?: number }; }
export function parseCliConfig(raw: unknown): CliConfig;       // pure, throws Error on invalid
export function loadCliConfig(path: string): Promise<CliConfig>;
export function profileToModelInfo(p: CliProfile, available: boolean): ModelInfo;
```

- [ ] **Step 1: Write the failing test**

`test/cli-profiles.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliConfig, profileToModelInfo } from '../src/backends/cli/profiles.js';

test('parses a valid config', () => {
  const cfg = parseCliConfig({ profiles: [
    { id: 'codex-a', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'] },
  ]});
  assert.equal(cfg.profiles.length, 1);
  assert.equal(cfg.profiles[0].enabled, true); // defaulted
});

test('rejects missing required fields', () => {
  assert.throws(() => parseCliConfig({ profiles: [{ id: 'x', provider: 'codex' }] }), /bin|model/);
});

test('rejects duplicate ids', () => {
  assert.throws(() => parseCliConfig({ profiles: [
    { id: 'a', provider: 'llm', bin: 'llm', model: 'm', capabilities: [] },
    { id: 'a', provider: 'llm', bin: 'llm', model: 'm', capabilities: [] },
  ]}), /duplicate/i);
});

test('rejects unknown provider', () => {
  assert.throws(() => parseCliConfig({ profiles: [
    { id: 'a', provider: 'bogus', bin: 'x', model: 'm', capabilities: [] },
  ]}), /provider/i);
});

test('profileToModelInfo maps capabilities and availability', () => {
  const mi = profileToModelInfo(
    { id: 'codex-a', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'], contextWindow: 256000 },
    false,
  );
  assert.equal(mi.id, 'codex-a');
  assert.equal(mi.state, 'not-loaded');
  assert.equal(mi.context_length, 256000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/cli-profiles.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/backends/cli/profiles.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/cli-profiles.test.ts` → Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backends/cli/profiles.ts test/cli-profiles.test.ts
git commit -m "feat(cli): profile config loader and ModelInfo mapping"
```

- [ ] **Step 6: Codex review** — `codex:rescue` on the diff; address findings.

---

### Task 3: Process exec wrapper

**Files:**
- Create: `src/backends/cli/exec.ts`
- Test: `test/cli-exec.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ProcessResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; }
export interface RunOptions { env?: Record<string, string>; stdin?: string; timeoutMs?: number; cwd?: string;
  spawnFn?: typeof import('node:child_process').spawn; }
export function runProcess(argv: string[], opts?: RunOptions): Promise<ProcessResult>;
```

- [ ] **Step 1: Write the failing test** (uses real `node` subprocess — deterministic, no quota)

`test/cli-exec.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/backends/cli/exec.js';

test('captures stdout and exit code', async () => {
  const r = await runProcess([process.execPath, '-e', "process.stdout.write('hello')"]);
  assert.equal(r.stdout, 'hello');
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
});

test('feeds stdin', async () => {
  const r = await runProcess(
    [process.execPath, '-e', "process.stdin.on('data',d=>process.stdout.write(d))"],
    { stdin: 'piped-input' },
  );
  assert.match(r.stdout, /piped-input/);
});

test('times out and reports timedOut', async () => {
  const r = await runProcess([process.execPath, '-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/cli-exec.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/backends/cli/exec.ts`**

```ts
import { spawn as realSpawn } from 'node:child_process';

export interface ProcessResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; }
export interface RunOptions {
  env?: Record<string, string>; stdin?: string; timeoutMs?: number; cwd?: string;
  spawnFn?: typeof realSpawn;
}

export function runProcess(argv: string[], opts: RunOptions = {}): Promise<ProcessResult> {
  const spawnFn = opts.spawnFn ?? realSpawn;
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawnFn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, done = false;
    const finish = (exitCode: number | null) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs) : undefined;
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { stderr += String(e); finish(null); });
    child.on('close', (code) => finish(code));
    if (opts.stdin !== undefined) { child.stdin?.write(opts.stdin); child.stdin?.end(); }
    else child.stdin?.end();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/cli-exec.test.ts` → Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backends/cli/exec.ts test/cli-exec.test.ts
git commit -m "feat(cli): injectable process exec wrapper with timeout"
```

- [ ] **Step 6: Codex review** — `codex:rescue`; address findings.

---

### Task 4: Adapter interface + all five adapters

**Files:**
- Create: `src/backends/cli/adapters/types.ts`, `codex.ts`, `gemini.ts`, `claude.ts`, `llm.ts`, `custom.ts`, `index.ts`
- Test: `test/cli-adapters.test.ts`

**Interfaces:**
- Consumes: `CliProfile` (`../profiles.js`), `ChatOptions` (`../../../types.js`), `ProcessResult` (`../exec.js`).
- Produces:
```ts
export type CliErrorKind = 'ok' | 'auth' | 'rate' | 'error';
export interface Invocation { argv: string[]; env: Record<string, string>; stdin?: string; outFile?: string; }
export interface ParsedOutput { content: string; usage?: import('../../../types.js').StreamingResult['usage']; }
export interface CliAdapter {
  buildInvocation(p: CliProfile, prompt: string, options: ChatOptions, outFile: string): Invocation;
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput;
  classifyError(raw: ProcessResult): CliErrorKind;
}
export function getAdapter(provider: Provider): CliAdapter;
```

- [ ] **Step 1: Write the failing test**

`test/cli-adapters.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter } from '../src/backends/cli/adapters/index.js';
import type { CliProfile } from '../src/backends/cli/profiles.js';

const codexP: CliProfile = { id: 'cx', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'], configHome: '/tmp/cx' };
const claudeP: CliProfile = { id: 'cl', provider: 'claude', bin: 'claude', model: 'sonnet', capabilities: ['chat'], configHome: '/tmp/cl' };
const gemP: CliProfile = { id: 'gm', provider: 'gemini', bin: 'gemini', model: 'gemini-2.5-pro', capabilities: ['analysis'] };

test('codex builds a read-only non-interactive exec invocation with CODEX_HOME and outFile', () => {
  const inv = getAdapter('codex').buildInvocation(codexP, 'hi', {}, '/tmp/out.txt');
  assert.deepEqual(inv.argv.slice(0, 2), ['codex', 'exec']);
  assert.ok(inv.argv.includes('--skip-git-repo-check'));
  assert.ok(inv.argv.includes('read-only'));   // -s read-only
  assert.ok(inv.argv.includes('never'));       // -a never
  assert.equal(inv.env.CODEX_HOME, '/tmp/cx');
  assert.equal(inv.outFile, '/tmp/out.txt');
  assert.equal(inv.stdin, 'hi');
});

test('codex parseOutput prefers outFileContent', () => {
  const out = getAdapter('codex').parseOutput({ stdout: 'noise', stderr: '', exitCode: 0, timedOut: false, outFileContent: 'final answer' });
  assert.equal(out.content, 'final answer');
});

test('claude builds -p json invocation with CLAUDE_CONFIG_DIR and parses result', () => {
  const a = getAdapter('claude');
  const inv = a.buildInvocation(claudeP, 'hi', {}, '/tmp/o');
  assert.ok(inv.argv.includes('-p'));
  assert.ok(inv.argv.includes('--output-format') && inv.argv.includes('json'));
  assert.equal(inv.env.CLAUDE_CONFIG_DIR, '/tmp/cl');
  const out = a.parseOutput({ stdout: JSON.stringify({ result: 'A', usage: { input_tokens: 3, output_tokens: 5 } }), stderr: '', exitCode: 0, timedOut: false });
  assert.equal(out.content, 'A');
  assert.equal(out.usage?.prompt_tokens, 3);
});

test('gemini parses JSON response text', () => {
  const out = getAdapter('gemini').parseOutput({ stdout: JSON.stringify({ response: 'G' }), stderr: '', exitCode: 0, timedOut: false });
  assert.equal(out.content, 'G');
});

test('classifyError detects auth and rate-limit from stderr', () => {
  const a = getAdapter('codex');
  assert.equal(a.classifyError({ stdout: '', stderr: '401 Unauthorized: please login', exitCode: 1, timedOut: false }), 'auth');
  assert.equal(a.classifyError({ stdout: '', stderr: 'Error: 429 rate limit exceeded', exitCode: 1, timedOut: false }), 'rate');
  assert.equal(a.classifyError({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }), 'ok');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/cli-adapters.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter files**

`src/backends/cli/adapters/types.ts`:
```ts
import type { CliProfile, Provider } from '../profiles.js';
import type { ChatOptions, StreamingResult } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export type CliErrorKind = 'ok' | 'auth' | 'rate' | 'error';
export interface Invocation { argv: string[]; env: Record<string, string>; stdin?: string; outFile?: string; }
export interface ParsedOutput { content: string; usage?: StreamingResult['usage']; }
export interface CliAdapter {
  buildInvocation(p: CliProfile, prompt: string, options: ChatOptions, outFile: string): Invocation;
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput;
  classifyError(raw: ProcessResult): CliErrorKind;
}

const AUTH_RE = /\b(401|403|unauthor|not (logged|authenticated)|please (log ?in|authenticate)|invalid api key|missing api key|credential)\b/i;
const RATE_RE = /\b(429|rate.?limit|quota|too many requests|exceeded your)\b/i;

/** Shared default error classifier — adapters can reuse or wrap. */
export function classifyByText(raw: ProcessResult): CliErrorKind {
  if (raw.exitCode === 0 && !raw.timedOut) return 'ok';
  const hay = `${raw.stderr}\n${raw.stdout}`;
  if (AUTH_RE.test(hay)) return 'auth';
  if (RATE_RE.test(hay)) return 'rate';
  return 'error';
}

/** Merge configHome into a provider-specific env var. */
export function homeEnv(p: CliProfile): Record<string, string> {
  if (!p.configHome) return {};
  switch (p.provider) {
    case 'codex': return { CODEX_HOME: p.configHome };
    case 'claude': return { CLAUDE_CONFIG_DIR: p.configHome };
    case 'gemini': return { HOME: p.configHome }; // gemini is global by spec §4.1; honoured if a home is set
    default: return {};
  }
}
```

`src/backends/cli/adapters/codex.ts`:
```ts
import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText, homeEnv } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const codexAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, outFile: string): Invocation {
    return {
      argv: [p.bin, 'exec', '--skip-git-repo-check', '-s', 'read-only', '-a', 'never', '-m', p.model, '-o', outFile],
      env: homeEnv(p),
      stdin: prompt,
      outFile,
    };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput {
    return { content: (raw.outFileContent ?? raw.stdout).trim() };
  },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};
```

`src/backends/cli/adapters/claude.ts`:
```ts
import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText, homeEnv } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const claudeAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, _f: string): Invocation {
    return {
      argv: [p.bin, '-p', '--model', p.model, '--output-format', 'json', '--no-session-persistence', '--allowed-tools', ''],
      env: homeEnv(p),
      stdin: prompt,
    };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput {
    try {
      const j = JSON.parse(raw.stdout);
      const u = j.usage ?? {};
      const usage = (u.input_tokens != null || u.output_tokens != null) ? {
        prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0,
        total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      } : undefined;
      return { content: String(j.result ?? '').trim(), usage };
    } catch { return { content: raw.stdout.trim() }; }
  },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};
```

`src/backends/cli/adapters/gemini.ts`:
```ts
import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText, homeEnv } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const geminiAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, _f: string): Invocation {
    return { argv: [p.bin, '-p', prompt, '-m', p.model, '-o', 'json'], env: homeEnv(p) };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput {
    try {
      const j = JSON.parse(raw.stdout);
      const text = j.response ?? j.text ?? '';
      const um = j.usageMetadata ?? j.stats?.usage;
      const usage = um ? {
        prompt_tokens: um.promptTokenCount ?? 0, completion_tokens: um.candidatesTokenCount ?? 0,
        total_tokens: um.totalTokenCount ?? 0,
      } : undefined;
      return { content: String(text).trim(), usage };
    } catch { return { content: raw.stdout.trim() }; }
  },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};
```

`src/backends/cli/adapters/llm.ts`:
```ts
import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText, homeEnv } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const llmAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, _f: string): Invocation {
    return { argv: [p.bin, '-m', p.model, '--no-stream', prompt], env: homeEnv(p) };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput { return { content: raw.stdout.trim() }; },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};
```

`src/backends/cli/adapters/custom.ts`:
```ts
import type { CliAdapter, Invocation, ParsedOutput, CliErrorKind } from './types.js';
import { classifyByText } from './types.js';
import type { CliProfile } from '../profiles.js';
import type { ChatOptions } from '../../../types.js';
import type { ProcessResult } from '../exec.js';

export const customAdapter: CliAdapter = {
  buildInvocation(p: CliProfile, prompt: string, _o: ChatOptions, _f: string): Invocation {
    const tmpl = p.argvTemplate ?? [p.bin, '{prompt}'];
    const viaArg = p.promptVia !== 'stdin';
    const argv = tmpl.map((t) => t.replace('{model}', p.model).replace('{prompt}', viaArg ? prompt : ''));
    return { argv, env: p.configHome ? { HOME: p.configHome } : {}, stdin: viaArg ? undefined : prompt };
  },
  parseOutput(raw: ProcessResult & { outFileContent?: string }): ParsedOutput {
    if (raw.exitCodeParseAsJson) { /* placeholder removed */ }
    return { content: raw.stdout.trim() };
  },
  classifyError(raw: ProcessResult): CliErrorKind { return classifyByText(raw); },
};
```
> Note: remove the stray `if (raw.exitCodeParseAsJson)` line — it is not part of `ProcessResult`. The custom adapter's `parse: 'json'`/`jsonPath` handling is deferred (YAGNI); ship text parsing only and add JSON extraction if a real custom CLI needs it.

`src/backends/cli/adapters/index.ts`:
```ts
import type { CliAdapter } from './types.js';
import type { Provider } from '../profiles.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import { claudeAdapter } from './claude.js';
import { llmAdapter } from './llm.js';
import { customAdapter } from './custom.js';

const REGISTRY: Record<Provider, CliAdapter> = {
  codex: codexAdapter, gemini: geminiAdapter, claude: claudeAdapter, llm: llmAdapter, custom: customAdapter,
};
export function getAdapter(provider: Provider): CliAdapter {
  const a = REGISTRY[provider];
  if (!a) throw new Error(`No adapter for provider: ${provider}`);
  return a;
}
export type { CliAdapter } from './types.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/cli-adapters.test.ts` → Expected: PASS (5 tests). Fix the noted stray line in `custom.ts` if compile fails.

- [ ] **Step 5: Commit**

```bash
git add src/backends/cli/adapters test/cli-adapters.test.ts
git commit -m "feat(cli): provider adapters (codex/gemini/claude/llm/custom) with auth+rate classification"
```

- [ ] **Step 6: Codex review** — `codex:rescue`; pay attention to the agentic-lockdown flags being correct for the installed CLI versions.

---

### Task 5: Selection pool (scoring, RR/LRU, cooldown, auth-blocked)

**Files:**
- Create: `src/backends/cli/pool.ts`
- Test: `test/cli-pool.test.ts`

**Interfaces:**
- Consumes: `CliConfig`, `CliProfile` (`./profiles.js`), `ModelInfo`, `TaskType` (`../../types.js`).
- Produces:
```ts
export function scoreProfileForTask(p: CliProfile, taskType: TaskType): number;
export class CliPool {
  constructor(config: CliConfig, now?: () => number);
  get(id: string): CliProfile | undefined;
  listAvailable(taskType: TaskType): CliProfile[];   // score desc, lastUsedAt asc
  acquire(id: string): void;  release(id: string): void;
  markUsed(id: string): void; markCooldown(id: string, ms?: number): void; markAuthBlocked(id: string): void;
  toModelInfos(): ModelInfo[];
}
```

- [ ] **Step 1: Write the failing test**

`test/cli-pool.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliPool, scoreProfileForTask } from '../src/backends/cli/pool.js';
import type { CliConfig } from '../src/backends/cli/profiles.js';

const cfg: CliConfig = { profiles: [
  { id: 'codex-a', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'], concurrency: 1 },
  { id: 'codex-b', provider: 'codex', bin: 'codex', model: 'gpt-5.4-codex', capabilities: ['code'], concurrency: 1 },
  { id: 'gem',     provider: 'gemini', bin: 'gemini', model: 'gemini-2.5-pro', capabilities: ['analysis'], contextWindow: 1_000_000 },
], defaults: { cooldownMs: 1000 } };

test('scoring rewards capability match, coder bonus, big-context analysis', () => {
  assert.equal(scoreProfileForTask(cfg.profiles[0], 'code'), 15);     // 10 cap + 5 codex
  assert.equal(scoreProfileForTask(cfg.profiles[2], 'analysis'), 12); // 10 cap + 2 ctx
  assert.equal(scoreProfileForTask(cfg.profiles[2], 'code'), 0);
});

test('LRU tie-break rotates equally-scored profiles', () => {
  let t = 1000; const pool = new CliPool(cfg, () => t);
  const first = pool.listAvailable('code')[0].id;   // both codex tie → lastUsedAt 0 → array order
  pool.markUsed(first); t = 1001;
  const second = pool.listAvailable('code')[0].id;
  assert.notEqual(first, second);                   // the other codex now leads (older lastUsedAt)
});

test('cooldown removes a profile until it expires', () => {
  let t = 1000; const pool = new CliPool(cfg, () => t);
  pool.markCooldown('codex-a', 500);
  assert.deepEqual(pool.listAvailable('code').map(p => p.id), ['codex-b']);
  t = 1600;
  assert.equal(pool.listAvailable('code').length, 2);
});

test('auth-blocked is sticky (does not expire on a timer)', () => {
  let t = 1000; const pool = new CliPool(cfg, () => t);
  pool.markAuthBlocked('codex-a'); t = 999999;
  assert.deepEqual(pool.listAvailable('code').map(p => p.id), ['codex-b']);
});

test('concurrency cap excludes in-flight profiles', () => {
  const pool = new CliPool(cfg, () => 1000);
  pool.acquire('codex-a'); pool.acquire('codex-b');
  assert.deepEqual(pool.listAvailable('code'), []);
  pool.release('codex-a');
  assert.deepEqual(pool.listAvailable('code').map(p => p.id), ['codex-a']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/cli-pool.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/backends/cli/pool.ts`**

```ts
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
      .filter((p) => this.isAvailable(p, now))
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/cli-pool.test.ts` → Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backends/cli/pool.ts test/cli-pool.test.ts
git commit -m "feat(cli): selection pool with RR/LRU tie-break, cooldown, auth-blocked, concurrency cap"
```

- [ ] **Step 6: Codex review** — `codex:rescue`; verify LRU/cooldown edge cases.

---

### Task 6: Alert webhook

**Files:**
- Create: `src/backends/cli/alert.ts`
- Test: covered in Task 8 (`test/cli-auth.test.ts`)

**Interfaces:**
- Produces: `export function sendAlert(url: string | undefined, payload: Record<string, unknown>, fetchFn?: typeof fetch): Promise<void>;`

- [ ] **Step 1: Implement `src/backends/cli/alert.ts`** (no-op when url is unset; never throws)

```ts
export async function sendAlert(url: string | undefined, payload: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!url) return;
  try {
    await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) {
    process.stderr.write(`[houtini-lm][AUTH] alert webhook failed: ${String(e)}\n`);
  }
}
```

- [ ] **Step 2: Commit** (tested in Task 8)

```bash
git add src/backends/cli/alert.ts
git commit -m "feat(cli): best-effort alert webhook"
```

---

### Task 7: CliBackend — chat, listModels, failover

**Files:**
- Create: `src/backends/cli/index.ts`
- Test: `test/cli-backend.test.ts`

**Interfaces:**
- Consumes: `InferenceBackend`, `ChatMessage`, `ChatOptions`, `StreamingResult`, `ModelInfo` (`../../types.js`); `CliPool` (`./pool.js`); `getAdapter` (`./adapters/index.js`); `runProcess`, `ProcessResult`, `RunOptions` (`./exec.js`); `sendAlert` (`./alert.js`); `CliConfig` (`./profiles.js`).
- Produces:
```ts
export class CliError extends Error { kind: 'auth' | 'rate' | 'timeout' | 'error'; }
export class CliBackend implements InferenceBackend {
  name: string;
  constructor(config: CliConfig, deps?: { runProcessFn?: typeof runProcess; fetchFn?: typeof fetch; now?: () => number; alertWebhook?: string; timeoutMs?: number });
  chat(messages: ChatMessage[], options: ChatOptions): Promise<StreamingResult>;
  listModels(): Promise<ModelInfo[]>;
}
```

- [ ] **Step 1: Write the failing test** (fake `runProcessFn` — never touches a real CLI)

`test/cli-backend.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliBackend } from '../src/backends/cli/index.js';
import type { CliConfig } from '../src/backends/cli/profiles.js';
import type { ProcessResult } from '../src/backends/cli/exec.js';

const cfg: CliConfig = { profiles: [
  { id: 'cl-a', provider: 'claude', bin: 'claude', model: 'sonnet', capabilities: ['chat'], concurrency: 1 },
  { id: 'cl-b', provider: 'claude', bin: 'claude', model: 'sonnet', capabilities: ['chat'], concurrency: 1 },
], defaults: { cooldownMs: 1000 } };

const ok = (text: string): ProcessResult => ({ stdout: JSON.stringify({ result: text }), stderr: '', exitCode: 0, timedOut: false });
const rate = (): ProcessResult => ({ stdout: '', stderr: '429 rate limit', exitCode: 1, timedOut: false });
const authErr = (): ProcessResult => ({ stdout: '', stderr: '401 please login', exitCode: 1, timedOut: false });

test('chat runs the selected profile and returns content', async () => {
  const be = new CliBackend(cfg, { runProcessFn: async () => ok('answer'), now: () => 1000 });
  const r = await be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat' });
  assert.equal(r.content, 'answer');
});

test('failover: first profile rate-limited, second succeeds', async () => {
  let call = 0;
  const be = new CliBackend(cfg, { now: () => 1000, runProcessFn: async () => (++call === 1 ? rate() : ok('second')) });
  const r = await be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat' });
  assert.equal(r.content, 'second');
  assert.equal(call, 2);
});

test('explicit override does NOT fail over (D6) and surfaces the error', async () => {
  const be = new CliBackend(cfg, { now: () => 1000, runProcessFn: async () => rate() });
  await assert.rejects(
    be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat', model: 'cl-a', overridden: true }),
    /rate|429/i,
  );
});

test('auth error marks profile auth-blocked and fires webhook', async () => {
  const alerts: unknown[] = [];
  const fetchFn = (async (_u: string, init: { body: string }) => { alerts.push(JSON.parse(init.body)); return { ok: true } as Response; }) as unknown as typeof fetch;
  let call = 0;
  const be = new CliBackend(cfg, {
    now: () => 1000, alertWebhook: 'http://hook', fetchFn,
    runProcessFn: async () => (++call === 1 ? authErr() : ok('recovered')),
  });
  const r = await be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat' });
  assert.equal(r.content, 'recovered');
  assert.equal((alerts[0] as { kind: string }).kind, 'auth');
  // auth-blocked is sticky: listModels shows cl-a not-loaded
  const m = await be.listModels();
  assert.equal(m.find((x) => x.id === 'cl-a')?.state, 'not-loaded');
});

test('listModels returns all profiles as ModelInfo', async () => {
  const be = new CliBackend(cfg, { now: () => 1000 });
  const m = await be.listModels();
  assert.equal(m.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/cli-backend.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/backends/cli/index.ts`**

```ts
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InferenceBackend, ChatMessage, ChatOptions, StreamingResult, ModelInfo } from '../../types.js';
import type { CliConfig, CliProfile } from './profiles.js';
import { CliPool } from './pool.js';
import { getAdapter } from './adapters/index.js';
import { runProcess } from './exec.js';
import { sendAlert } from './alert.js';

export class CliError extends Error {
  constructor(public kind: 'auth' | 'rate' | 'timeout' | 'error', message: string) { super(message); }
}

function renderPrompt(messages: ChatMessage[]): string {
  return messages.map((m) => (m.role === 'system' ? `# System\n${m.content}` : m.content)).join('\n\n');
}

let tmpSeq = 0;
function tmpFilePath(): string { return join(tmpdir(), `houtini-cli-${process.pid}-${tmpSeq++}.txt`); }

export class CliBackend implements InferenceBackend {
  name = 'cli';
  private pool: CliPool;
  private runProcessFn: typeof runProcess;
  private fetchFn: typeof fetch;
  private now: () => number;
  private alertWebhook?: string;
  private timeoutMs: number;

  constructor(config: CliConfig, deps: {
    runProcessFn?: typeof runProcess; fetchFn?: typeof fetch; now?: () => number; alertWebhook?: string; timeoutMs?: number;
  } = {}) {
    this.now = deps.now ?? Date.now;
    this.pool = new CliPool(config, this.now);
    this.runProcessFn = deps.runProcessFn ?? runProcess;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.alertWebhook = deps.alertWebhook;
    this.timeoutMs = deps.timeoutMs ?? config.defaults?.timeoutMs ?? 180_000;
  }

  async listModels(): Promise<ModelInfo[]> { return this.pool.toModelInfos(); }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<StreamingResult> {
    const prompt = renderPrompt(messages);
    const taskType = options.taskType ?? 'chat';

    if (options.overridden && options.model) {
      const p = this.pool.get(options.model);
      if (!p) throw new CliError('error', `Unknown profile override: ${options.model}`);
      return this.runOnce(p, prompt, options); // verbatim, no failover (D6)
    }

    const candidates = this.pool.listAvailable(taskType);
    if (candidates.length === 0) throw new CliError('error', `No available CLI profiles for task "${taskType}"`);
    let lastErr: unknown;
    for (const p of candidates) {
      try { return await this.runOnce(p, prompt, options); }
      catch (e) {
        lastErr = e;
        const kind = e instanceof CliError ? e.kind : 'error';
        if (kind === 'auth') { this.handleAuth(p); continue; }
        if (kind === 'rate' || kind === 'timeout') { this.pool.markCooldown(p.id); continue; }
        throw e; // unknown error: surface, don't burn other accounts
      }
    }
    throw lastErr;
  }

  private handleAuth(p: CliProfile): void {
    this.pool.markAuthBlocked(p.id);
    process.stderr.write(`[houtini-lm][AUTH] profile "${p.id}" (${p.provider}) auth-blocked\n`);
    void sendAlert(this.alertWebhook, { profile: p.id, provider: p.provider, kind: 'auth', ts: this.now() }, this.fetchFn);
  }

  private async runOnce(p: CliProfile, prompt: string, options: ChatOptions): Promise<StreamingResult> {
    const start = this.now();
    this.pool.acquire(p.id);
    const adapter = getAdapter(p.provider);
    const outFile = tmpFilePath();
    const inv = adapter.buildInvocation(p, prompt, options, outFile);
    try {
      const result = await this.runProcessFn(inv.argv, {
        env: { ...process.env, ...inv.env } as Record<string, string>,
        stdin: inv.stdin, timeoutMs: this.timeoutMs,
      });
      if (result.timedOut) throw new CliError('timeout', `profile "${p.id}" timed out`);
      const kind = adapter.classifyError(result);
      if (kind === 'auth') throw new CliError('auth', `profile "${p.id}" auth error: ${result.stderr.slice(0, 200)}`);
      if (kind === 'rate') throw new CliError('rate', `profile "${p.id}" rate-limited`);
      if (kind === 'error') throw new CliError('error', `profile "${p.id}" failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
      let outFileContent: string | undefined;
      if (inv.outFile) { try { outFileContent = await readFile(inv.outFile, 'utf8'); } catch { /* none */ } }
      const parsed = adapter.parseOutput({ ...result, outFileContent });
      this.pool.markUsed(p.id);
      return {
        content: parsed.content, rawContent: parsed.content, model: p.model,
        usage: parsed.usage, finishReason: 'stop', truncated: false, generationMs: this.now() - start,
      };
    } finally {
      this.pool.release(p.id);
      if (inv.outFile) void rm(inv.outFile, { force: true }).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/cli-backend.test.ts` → Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backends/cli/index.ts test/cli-backend.test.ts
git commit -m "feat(cli): CliBackend with override-verbatim and cooldown/auth failover"
```

- [ ] **Step 6: Codex review** — `codex:rescue`; focus on the failover loop + override semantics matching D4/D6.

---

### Task 8: Auth-handling integration test

**Files:**
- Test: `test/cli-auth.test.ts`

**Interfaces:** Consumes `CliBackend`, `sendAlert`.

- [ ] **Step 1: Write the test** (exercises sticky auth-block across two calls + webhook payload shape)

`test/cli-auth.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliBackend } from '../src/backends/cli/index.js';
import type { CliConfig } from '../src/backends/cli/profiles.js';
import type { ProcessResult } from '../src/backends/cli/exec.js';

const cfg: CliConfig = { profiles: [
  { id: 'only', provider: 'gemini', bin: 'gemini', model: 'gemini-2.5-pro', capabilities: ['chat'] },
]};
const authErr = (): ProcessResult => ({ stdout: '', stderr: '403 invalid api key', exitCode: 1, timedOut: false });

test('single-profile auth failure: blocked, alerted, then unavailable', async () => {
  const alerts: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_u: string, init: { body: string }) => { alerts.push(JSON.parse(init.body)); return { ok: true } as Response; }) as unknown as typeof fetch;
  const be = new CliBackend(cfg, { now: () => 5, alertWebhook: 'http://hook', fetchFn, runProcessFn: async () => authErr() });
  await assert.rejects(be.chat([{ role: 'user', content: 'q' }], { taskType: 'chat' }), /No available|auth/i);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'auth');
  assert.equal(alerts[0].provider, 'gemini');
  const m = await be.listModels();
  assert.equal(m[0].state, 'not-loaded');
});
```

- [ ] **Step 2: Run** → `npx tsx --test test/cli-auth.test.ts` → Expected: PASS (after Tasks 6–7 land; the behaviour already exists, this test pins it).

- [ ] **Step 3: Commit**

```bash
git add test/cli-auth.test.ts
git commit -m "test(cli): auth-blocked stickiness and alert payload"
```

- [ ] **Step 4: Codex review** — `codex:rescue`.

---

### Task 9: Wire the CLI backend into index.ts

**Files:**
- Modify: `src/index.ts` (bootstrap + three seam branches + `routeToModel.overridden` + handler options + heartbeat)
- Test: `test/cli-wiring.test.ts` (env-gated smoke) + manual MCP check

**Interfaces:** Consumes `CliBackend`, `loadCliConfig`.

- [ ] **Step 1: Add backend bootstrap** near the config constants (after line 64):

```ts
import { CliBackend } from './backends/cli/index.js';
import { loadCliConfig } from './backends/cli/profiles.js';

const HOUTINI_LM_BACKEND = (process.env.HOUTINI_LM_BACKEND || '').toLowerCase();
const HOUTINI_LM_CLI_CONFIG = process.env.HOUTINI_LM_CLI_CONFIG || '';
const HOUTINI_LM_ALERT_WEBHOOK = process.env.HOUTINI_LM_ALERT_WEBHOOK || '';
let cliBackend: CliBackend | null = null;

async function initBackend(): Promise<void> {
  const useCli = HOUTINI_LM_BACKEND === 'cli' || (HOUTINI_LM_BACKEND === '' && HOUTINI_LM_CLI_CONFIG !== '' && process.env.HOUTINI_LM_BACKEND !== 'openai-compat');
  if (useCli && HOUTINI_LM_CLI_CONFIG) {
    const cfg = await loadCliConfig(HOUTINI_LM_CLI_CONFIG);
    cliBackend = new CliBackend(cfg, { alertWebhook: HOUTINI_LM_ALERT_WEBHOOK || undefined });
    process.stderr.write(`[houtini-lm] CLI backend active: ${cfg.profiles.length} profile(s)\n`);
  }
}
```
Call `await initBackend();` in the server startup path (where the server connects to the transport, near the existing `main()`/startup).

- [ ] **Step 2: Branch `chatCompletionStreamingInner`** — add as the FIRST lines of the function body (index.ts:668):

```ts
  if (cliBackend) {
    const onProgress = (msg: string) => { if (options.progressToken !== undefined) { /* heartbeat */ } };
    return cliBackend.chat(messages, { ...options, onProgress });
  }
```
> The existing `sendProgress` heartbeat lives further down inside this function and is unreachable once we early-return. Instead, wrap the CLI call with a heartbeat timer: before the call, `const hb = setInterval(() => sendCliProgress(options.progressToken), PREFILL_KEEPALIVE_MS);` and `clearInterval(hb)` in a `finally`. Add a small module-level `sendCliProgress(token)` that mirrors the existing `server.notification({method:'notifications/progress', ...})` call. Keep it minimal.

- [ ] **Step 3: Branch `listModelsRaw`** — first lines of the function (index.ts:1095):

```ts
  if (cliBackend) return cliBackend.listModels();
```

- [ ] **Step 4: Branch the `embed` handler** (index.ts:2251) — at the top of the case:

```ts
      case 'embed': {
        if (cliBackend && !cliBackend.embed) {
          return { content: [{ type: 'text', text: 'Embeddings are not available with the CLI backend. Set HOUTINI_LM_EMBED_ENDPOINT or use the OpenAI-compatible backend.' }], isError: true };
        }
        // ...existing embed body unchanged...
```
> Embeddings fall-through to a dedicated endpoint is deferred (YAGNI) — see "Deferred". For now CLI mode returns a clear unsupported message.

- [ ] **Step 5: Add `overridden` to `routeToModel`** (index.ts:1318 + 1328):

```ts
interface RoutingDecision { modelId: string; hints: PromptHints; suggestion?: string; overridden: boolean; }
// in the pinned branch:
  if (pinned) { const hints = getPromptHints(pinned); return { modelId: pinned, hints, overridden: !!override }; }
// every other return in routeToModel: add `overridden: false`.
```

- [ ] **Step 6: Pass `taskType` + `overridden` from handlers.** For each handler that calls `chatCompletionStreaming` (the `model: route.modelId` call sites at index.ts:1869, 1912, 1954, 2081), add the two fields, using that handler's task type:

```ts
        const resp = await chatCompletionStreaming(messages, {
          temperature: temperature ?? route.hints.chatTemp,
          maxTokens: max_tokens,
          model: route.modelId,
          responseFormat,
          progressToken,
          taskType: 'chat',            // 'analysis' / 'code' per the handler's routeToModel() call
          overridden: route.overridden,
        });
```

- [ ] **Step 7: Write the env-gated smoke test**

`test/cli-wiring.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliBackend } from '../src/backends/cli/index.js';
import { parseCliConfig } from '../src/backends/cli/profiles.js';

// Pure wiring check: a config drives a backend whose listModels reflects profiles.
test('parseCliConfig → CliBackend.listModels round-trip', async () => {
  const cfg = parseCliConfig({ profiles: [{ id: 'p1', provider: 'llm', bin: 'llm', model: 'm', capabilities: ['chat'] }] });
  const be = new CliBackend(cfg, { now: () => 1 });
  const m = await be.listModels();
  assert.equal(m[0].id, 'p1');
});
```

- [ ] **Step 8: Run all unit tests + build**

Run: `npm run test:unit` → Expected: PASS (all suites).
Run: `npm run build` → Expected: clean compile.

- [ ] **Step 9: Manual MCP smoke (real, one cheap call)**

```bash
cat > /tmp/cli-pool.json <<'JSON'
{ "profiles": [ { "id": "claude-sub", "provider": "claude", "bin": "claude", "model": "sonnet", "capabilities": ["chat","code","analysis"] } ] }
JSON
HOUTINI_LM_BACKEND=cli HOUTINI_LM_CLI_CONFIG=/tmp/cli-pool.json node dist/index.js  # then issue a `chat` tool call via your MCP client / test-mcp-e2e.mjs
```
Expected: a short completion returns; stderr shows `CLI backend active: 1 profile(s)`.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts test/cli-wiring.test.ts
git commit -m "feat(cli): wire CLI backend into index.ts seams (chat/listModels/embed, routeToModel.overridden)"
```

- [ ] **Step 11: Codex review** — `codex:rescue`; this is the riskiest task (touches existing code) — ask for a careful read of the three branches + heartbeat.

---

### Task 10: Docs, example config, env reference

**Files:**
- Create: `docs/examples/cli-config.example.json`
- Modify: `README.md` (new "CLI backend" section), `.env.example` if present

- [ ] **Step 1: Write `docs/examples/cli-config.example.json`**

```json
{
  "profiles": [
    { "id": "codex-main", "provider": "codex", "bin": "codex", "model": "gpt-5.4-codex",
      "configHome": "~/.houtini/profiles/codex-main", "capabilities": ["code", "analysis"], "contextWindow": 256000 },
    { "id": "gemini", "provider": "gemini", "bin": "gemini", "model": "gemini-2.5-pro",
      "capabilities": ["analysis", "chat"], "contextWindow": 1000000 },
    { "id": "claude-sub", "provider": "claude", "bin": "claude", "model": "sonnet",
      "configHome": "~/.houtini/profiles/claude-sub", "capabilities": ["chat", "code", "analysis"] }
  ],
  "defaults": { "timeoutMs": 180000, "cooldownMs": 60000 }
}
```

- [ ] **Step 2: Add a README section** documenting: `HOUTINI_LM_BACKEND=cli`, `HOUTINI_LM_CLI_CONFIG=<path>`, `HOUTINI_LM_ALERT_WEBHOOK`, the profile schema, the gemini-global-auth requirement (§4.1), agentic-lockdown note, and that selection = override→capability→RR/LRU+failover.

- [ ] **Step 3: Commit**

```bash
git add docs/examples/cli-config.example.json README.md
git commit -m "docs: CLI backend usage, example pool config, env reference"
```

- [ ] **Step 4: Codex review** — `codex:rescue` on docs accuracy vs. behaviour.

---

### Task 11: Finalize the branch

- [ ] **Step 1:** Run the full unit suite: `npm run test:unit` → all PASS.
- [ ] **Step 2:** `npm run build` → clean.
- [ ] **Step 3:** Decide package identity (`package.json` `name`) — keep `@houtini/lm` private, or rename. (Open item from spec §11.)
- [ ] **Step 4:** Push the branch and open a PR against your fork's `main` (only on your go-ahead): `git push -u origin feat/cli-backend`.
- [ ] **Step 5:** Final Codex review of the whole diff before merge.

---

## Deferred (YAGNI for v1 — tracked, not built)

- Embeddings fall-through to `HOUTINI_LM_EMBED_ENDPOINT` (Task 9 returns a clear unsupported message instead).
- `response_format`/`json_schema` → per-adapter schema flags (codex `--output-schema`, claude `--json-schema`, gemini JSON mode). v1 passes the prompt through; structured output is best-effort.
- Streaming token-level progress from `--json`/`stream-json` (v1 uses a generic heartbeat).
- Custom adapter `parse: 'json'` + `jsonPath` extraction.
- Persistent cooldown across restarts; weighted rotation beyond simple ordering.

## Self-Review

**Spec coverage:**
- D1 subprocess engine → Tasks 3,4,7 ✓ · D2 keep OpenAI path → Task 9 (branches, default unchanged) ✓ · D3/D6 override verbatim → Task 7 + Task 9 step 5 ✓ · D4 RR/LRU + failover → Tasks 5,7 ✓ · D5 profile=subscription → Task 2 ✓
- §4.1 gemini global auth → Task 4 (`homeEnv`) + Task 10 docs ✓ · §4.1 auth handling (log/surface/auth-blocked/webhook) → Tasks 5,6,7,8 ✓
- §5 InferenceBackend seam → Tasks 1,9 ✓ · §6 config → Task 2 ✓ · §7 selection → Tasks 5,7 ✓ · §8 adapters + lockdown → Task 4 ✓ · §9 spawn/timeout/concurrency/heartbeat → Tasks 3,5,7,9 ✓ · §10 usage/footer (usage populated; footer untouched) → Tasks 4,7 ✓; embeddings → Deferred (documented) ✓
- §12 testing (injected spawn, no quota) → Tasks 3–8 ✓ · §13 risks: isolation via `homeEnv` (Task 4); latency/lockdown flagged for Codex review (Tasks 4,11) ✓

**Placeholder scan:** One intentional stray line called out in `custom.ts` (Task 4) with a fix note. No `TBD`/`TODO` remain; deferred items are explicitly listed, not hidden.

**Type consistency:** `CliProfile`, `CliConfig`, `ProcessResult`, `Invocation`, `ParsedOutput`, `CliErrorKind`, `CliAdapter`, `getAdapter`, `runProcess`, `CliPool`, `scoreProfileForTask`, `CliBackend`, `CliError`, `ChatOptions` (with `taskType`/`overridden`), `InferenceBackend`, `EmbedResult` are defined once (Tasks 1–7) and referenced with matching signatures throughout. `profileToModelInfo` defined in Task 2, used in Task 5 (`toModelInfos`). `routeToModel` return type extended with `overridden` in Task 9 and consumed in the same task's handler edits.

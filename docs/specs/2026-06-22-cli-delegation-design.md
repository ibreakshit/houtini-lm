# houtini-lm CLI-delegation fork — design spec

**Date:** 2026-06-22
**Status:** Draft for review
**Base:** fork of `@houtini/lm` v2.13.2 (`houtini-ai/houtini-lm`)
**Fork:** `ibreakshit/houtini-lm` (`origin`); `upstream` → `houtini-ai/houtini-lm`

## 1. Goal

Fork houtini-lm so it can delegate bounded tasks to locally installed LLM **CLI clients** (`codex`, `claude`, `llm`) running in **single-response mode**, instead of (only) an OpenAI-compatible HTTP endpoint. Each CLI invocation is pinned to an isolated config-home so that multiple **subscriptions** of the same provider can be pooled, spreading token spend across accounts.

Non-goal: replace the existing local/OpenAI-compatible path. It stays intact; the CLI path is an additional, opt-in backend.

## 2. How houtini-lm works today (the seam)

- The entire server is `src/index.ts` (+ `src/model-cache.ts`). It is a thin MCP wrapper over **one** OpenAI-compatible endpoint (`HOUTINI_LM_ENDPOINT_URL`, default `http://localhost:1234`).
- All 8 tools (`chat`, `code_task`, `code_task_files`, `custom_prompt`, `discover`, `embed`, `list_models`, `stats`) funnel inference through a single function: `chatCompletionStreaming` → `chatCompletionStreamingInner` (`index.ts:665`), which POSTs to `${LM_BASE_URL}/v1/chat/completions` (SSE streaming) and accumulates the result.
- Model discovery is `listModelsRaw()` (`index.ts:1095`); embeddings hit `/v1/embeddings` (`index.ts:~2261`).
- Model selection is `routeToModel(taskType, override?)` (`index.ts:1324`):
  1. **Explicit override wins, verbatim** — tool `model` param or `HOUTINI_LM_MODEL` (`pinned = override || LM_MODEL`).
  2. Else **capability scoring** over *loaded* models: `+10` if task type ∈ model's `bestTaskTypes`; `+5` for "coder" families on `code`; `+2` for >100k-context models on `analysis`. Highest wins; ties → first loaded.
  3. Fallbacks to `HOUTINI_LM_MODEL`/empty if the server is unreachable or nothing is loaded.
  4. Suggests (text only) loading a better model; never auto-loads (MCP ~60s timeout vs minutes-long loads).
- There is **no rotation, quota tracking, failover, or multi-endpoint balancing today.** Routing is purely capability-based within a single backend.

## 3. Why CLIProxyAPI is a reference, not a dependency

`router-for-me/CLIProxyAPI` does **not** wrap the CLIs. It is **token-replay**: it runs each provider's OAuth flow itself, stores the tokens, and calls the providers' *private* HTTP backends directly (`chatgpt.com/backend-api/codex`, `generativelanguage.googleapis.com`, `api.anthropic.com`). The only subprocess it spawns is a browser for login.

What we borrow from it is the **account-selection engine** in `sdk/cliproxy/auth/`:
- `RoundRobinSelector` (per `provider:model` cursor), `FillFirstSelector`, `SessionAffinitySelector`.
- Quota/rate-limit-aware skipping: `isAuthBlockedForModel` skips disabled / cooling-down / quota-exceeded creds until a recover-at time; `Manager.Execute` retries across creds on 401/402/429.

We implement an equivalent (smaller) selection layer in TypeScript. We do **not** adopt token-replay — we use the official CLIs and their own auth, which is lower ban-risk for the user's subscriptions.

## 4. Decision record

| # | Decision | Choice |
|---|---|---|
| D1 | Execution engine | **Subprocess CLI wrappers** (`codex exec`, `claude -p`, `llm`) in single-response mode. Not token-replay. |
| D2 | Keep existing OpenAI/local path? | **Yes** — CLI path is an added, opt-in backend; current gpt-oss usage unaffected. |
| D3 | Selection precedence | **Preserve `routeToModel`**: explicit override → capability scoring. |
| D4 | Spreading across subscriptions | **Round-robin / least-recently-used tie-break** among equally-scored same-class profiles, **plus automatic failover to the next candidate when a profile is on cooldown or otherwise unavailable** (e.g. after 429/quota/timeout). Applies to **capability-routed** picks only — explicit overrides are honoured verbatim (D6). This is the only behavioural extension to the existing selection logic. |
| D5 | Subscription unit | A **profile** = CLI binary + model + isolated config-home. Same provider × N homes = N accounts. |
| D6 | Explicit override semantics | **Preserve original `routeToModel`**: an overridden model/profile is used **verbatim** — no availability check, no capability scoring, no failover; errors surface to the caller (`index.ts:1325` comment: "Honoured regardless of whether we can even list models … doesn't want routing to second-guess"). |

## 4.1 Requirements & per-provider auth

**Gemini is intentionally NOT supported via the CLI backend.** Google deprecated consumer-subscription auth for the Gemini CLI on 2026-06-18, so it now requires a developer/enterprise API key and yields no subscription token savings — reach Gemini via the OpenAI-compatible/LiteLLM path instead. Multi-subscription spreading therefore applies to **codex** (`CODEX_HOME`) and **claude** (`CLAUDE_CONFIG_DIR`), which isolate auth per config-home.

**Auth-error handling (no silent failures).** When a profile's CLI fails due to auth (missing/expired credentials, 401/403, provider auth message), the backend will:
1. **Log** to stderr with a `[houtini-lm][AUTH]` prefix including the profile id + provider.
2. **Surface** a clear, actionable error in the MCP tool response (so the caller sees it immediately).
3. **Mark the profile `auth-blocked`** — a state distinct from transient cooldown; it does *not* auto-recover on a timer (the pool skips it until auth is fixed and config reloaded).
4. **Alert (optional)** via `HOUTINI_LM_ALERT_WEBHOOK` — POST `{profile, provider, kind:"auth", message, ts}` for external monitoring.

This applies to every provider.

## 5. Architecture

Introduce a backend strategy behind the two existing call-sites. The 8 tools and `routeToModel` do not change.

```ts
interface InferenceBackend {
  name: string;
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<StreamingResult>;
  listModels(): Promise<ModelInfo[]>;
  embed?(input: string, model?: string): Promise<EmbedResult>;
}
```

- **`OpenAICompatBackend`** — today's fetch path extracted verbatim (LM Studio / Ollama / OpenRouter / local). No behaviour change.
- **`CliBackend`** — new:
  - `chat()` → select a profile (§7) → spawn the CLI in single-response mode (§8) → parse → `StreamingResult`.
  - `listModels()` → returns configured profiles **as `ModelInfo`** (id = profile id, `bestTaskTypes` from `capabilities`, `contextWindow`, `state: 'loaded'` when enabled & not on cooldown). This makes `routeToModel`, `list_models`, and `discover` work with **zero changes**.
  - `embed()` → optional fall-through to an OpenAI-compatible embeddings endpoint (`HOUTINI_LM_EMBED_ENDPOINT`); otherwise a clear "unsupported by CLI profiles" error.

`index.ts` edits are minimal (~30 lines): the body inside `chatCompletionStreamingInner` calls `activeBackend.chat(...)`; `listModelsRaw()` calls `activeBackend.listModels()`.

Active backend chosen by `HOUTINI_LM_BACKEND = openai-compat | cli | auto` (`auto` = `cli` when `HOUTINI_LM_CLI_CONFIG` is set). Unset → `openai-compat` (today's behaviour).

## 6. Profile / config model

`HOUTINI_LM_CLI_CONFIG` points to a JSON file:

```jsonc
{
  "profiles": [
    { "id": "codex-main", "provider": "codex", "bin": "codex", "model": "gpt-5.4-codex",
      "configHome": "~/.houtini/profiles/codex-main",      // → CODEX_HOME
      "capabilities": ["code","analysis"], "contextWindow": 256000,
      "concurrency": 1, "weight": 1, "enabled": true },

    { "id": "claude-sub", "provider": "claude", "bin": "claude", "model": "sonnet",
      "configHome": "~/.houtini/profiles/claude-sub",      // → CLAUDE_CONFIG_DIR
      "capabilities": ["chat","code","analysis"] }
  ],
  "defaults": { "timeoutMs": 180000, "cooldownMs": 60000 }
}
```

`capabilities` → the scorer's `bestTaskTypes`. `contextWindow` → context-aware `max_tokens` math. `concurrency` → per-profile parallelism cap. Profiles thus slot into existing model machinery without special-casing.

## 7. Selection algorithm (final)

Implemented inside `CliBackend.listModels()` + a `pool.ts` selector. `routeToModel` precedence is untouched; the pool only changes how a winner is chosen among ties and how unavailability is handled.

1. **Explicit override** (`model` per-call param, or `HOUTINI_LM_PROFILE` env verbatim pin — CLI backend only) → that profile, **used verbatim** — matching the original `routeToModel` (`index.ts:1325`), which short-circuits before any model listing. No availability check, no capability scoring, **no failover**: the call is attempted on exactly that profile and any error (quota/429/auth) surfaces to the caller. Auth/cooldown side effects are still recorded even for overridden calls (so later *capability-routed* calls skip it). `HOUTINI_LM_MODEL` is a soft default — pool-based selection (capability → LRU) still applies; use `HOUTINI_LM_PROFILE` or the per-call `model` param for a verbatim pin.
2. **Capability scoring** (existing `routeToModel` code) over **available** profiles. A profile is *unavailable* if `enabled === false`, on cooldown, or at its concurrency cap — such profiles are excluded from the candidate set (modelled as not `'loaded'`).
3. **Tie-break = round-robin / LRU** among the top-scored available profiles: pick the candidate with the oldest `lastUsedAt` (advances a per-`taskType` cursor). This spreads spend across equally-capable accounts.
4. **Failover**: if the chosen profile errors with a rate/quota signal (429, provider quota message) or times out, mark it on cooldown (`cooldownMs`, with backoff on repeats) and retry selection from step 2 with it excluded. Repeat across the remaining available candidates (bounded by the candidate count — each profile is tried at most once per request). If all are exhausted, return the last error.

   *Explicit override never fails over (step 1):* this is not a new rule but the original `routeToModel` behaviour preserved (D6) — a named model/profile is honoured verbatim and errors surface, because the caller asked for that specific subscription.

Cooldown state is in-memory per process (optional persistence to a `.json` later, mirroring CLIProxyAPI's `save-cooldown-status`). LRU/cursor state is in-memory.

## 8. Provider adapters

One small adapter per CLI. Interface:

```ts
interface CliAdapter {
  buildInvocation(profile: Profile, prompt: string, opts: ChatOptions):
    { argv: string[]; env: Record<string,string>; stdin?: string };
  parseOutput(raw: { stdout: string; files?: Record<string,string> }):
    { content: string; usage?: Usage; reasoning?: string };
}
```

Verified single-response invocations (from each CLI's `--help`):

| Provider | Invocation | Config-home env | Output parse |
|---|---|---|---|
| **codex** 0.141 | `codex exec --skip-git-repo-check -s read-only -m <model> -o <tmpfile>` (prompt via stdin) | `CODEX_HOME` | `-o` file = final text; `--json` JSONL → usage |
| **claude** 2.1 | `claude -p --model <model> --output-format json --no-session-persistence --permission-mode plan --disallowed-tools <built-ins>` (prompt via stdin) | `CLAUDE_CONFIG_DIR` | JSON → `result` + `usage` |
| **llm** 0.31 | `llm -m <model> --no-stream <prompt>` | (n/a) | stdout text |
| **custom** | config-driven `argvTemplate` + `promptVia` (stdin/arg) + `parse` (text/json/jsonpath) | per-config | generic |

**Safety (mandatory):** `codex exec` and `claude -p` are agentic. The flags above lock them to pure text generation — codex `-s read-only`; claude `--permission-mode plan --disallowed-tools <built-ins>`. houtini passes file *contents* inline in prompts, so the CLI never needs filesystem access. A delegation must not be able to edit files or run commands.

## 9. Execution mechanics

- `child_process.spawn` with an args array (**no shell** → no injection). Prompt via **stdin** (avoids argv length/quoting limits).
- **Non-streaming single-response**: collect stdout to completion. Reuse houtini's existing heartbeat plumbing (`sendProgress` / `preFetchTimer`, `index.ts:772`) to keep the MCP client alive during the multi-second run (no SSE to drive it).
- Per-profile **timeout + kill** (`timeoutMs`); timeout → mark failure + cooldown.
- Per-profile **concurrency semaphore** (default 1). Different profiles run in **parallel** — a win over today's `serialiseInference: true`.
- v2 (not v1): parse `--json` / `stream-json` for token-level progress.

## 10. Cross-cutting behaviour (kept working)

- **Token footer / stats**: adapters populate `StreamingResult.usage` from each CLI's JSON; where absent, estimate from char count. The sql.js lifetime-totals DB and `stats` tool are untouched.
- **Structured output** (`json_schema` → `response_format`): codex **enforces** it via `--output-schema <tmpfile>` (coexists with `--json`; implemented). Other CLI providers (claude, llm, custom) remain best-effort/prompt-only — schema is injected into the prompt but output is not mechanically validated.
- **Reasoning/thinking**: bypass houtini's per-family OpenAI reasoning juggling; let the CLI/model handle it (set effort via CLI flag/config where wanted).
- **Embeddings**: CLI backend `embed` → optional OpenAI-compat fall-through (`HOUTINI_LM_EMBED_ENDPOINT`) or clear unsupported error.
- **Env overrides (CLI backend)**: `HOUTINI_LM_PROFILE` pins a single profile by id, used verbatim with no failover (CLI backend only); equivalent to passing `model` in each tool call. `HOUTINI_LM_MODEL` is a soft default that sets the model name passed to the pool but does not bypass capability routing or failover.

## 11. File plan

```
src/backends/types.ts                 InferenceBackend interface + shared types
src/backends/openai-compat.ts         extracted existing path (no behaviour change)
src/backends/cli/index.ts             CliBackend: select → spawn → parse
src/backends/cli/pool.ts              rotation (RR/LRU) + cooldown/failover state
src/backends/cli/profiles.ts          config load + validation
src/backends/cli/adapters/codex.ts
src/backends/cli/adapters/claude.ts
src/backends/cli/adapters/llm.ts
src/backends/cli/adapters/custom.ts
```
Existing-code edits: `index.ts` backend dispatch at the two call-sites + backend bootstrap from env. Package rename (e.g. `@jihostyle/houtini-cli`) in `package.json`.

## 12. Testing

- Inject a fake `spawn` (dependency-inject the spawner into `CliBackend`) to unit-test each adapter's `buildInvocation`/`parseOutput` and the pool's RR/LRU + cooldown/failover **without burning quota**.
- One live smoke test per installed CLI behind an env flag (`HOUTINI_LM_LIVE_TEST=1`).
- Reuse the repo's `test.mjs` / `shakedown.mjs` / `test-mcp-e2e.mjs` harness for MCP-level checks.

## 13. Open risks (verify during planning)

1. **Same-provider isolation** — `CODEX_HOME` (codex) and `CLAUDE_CONFIG_DIR` (claude) confirmed; these carry multi-account spreading.
2. **Latency** — cold subprocess start adds seconds/call; acceptable for houtini's "trade wall-clock for tokens" positioning, but measure.
3. **Agentic lockdown** — verify exact no-tools/read-only flags for the installed CLI versions.

## 14. Out of scope (YAGNI for v1)

- Token-replay / direct provider HTTP (that's CLIProxyAPI's job; run it separately if ever wanted).
- Streaming token-level progress from CLIs.
- Session-affinity routing, weighted rotation beyond simple `weight`, persistent cooldown across restarts.
- Per-call backend mixing UI (one active backend per process for v1).

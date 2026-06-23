# Tiered multi-backend routing — design spec

**Date:** 2026-06-23
**Status:** Draft for review
**Fork:** `ibreakshit/houtini-lm`, builds on branch `feat/cli-backend`

## 1. Goal

Let a **single** houtini instance hold **both** a local backend and a CLI backend and route each call to the cheapest backend that can handle it: easy tasks stay local; tasks deemed too hard for local escalate to the CLI (treated as the single, most-powerful tier). Selection is **deterministic and upfront** — no run-then-judge, no escalation-after-failure, no classifier model.

User goals (verbatim intent):
1. One instance with multiple model backends — local **and** CLI.
2. Prefer the cheaper (local) backend when it's good enough — don't waste powerful models on simple tasks.
3. Tasks the local backend can't handle go to the CLI.
4. Net effect: simple tasks → local; complex tasks → CLI.
5. When multiple CLI models are tied: explicit **role** match wins; otherwise **first-loaded** by default (round-robin/LRU is opt-in).

## 2. Current state (the seam this changes)

- Today a server runs **one** backend, chosen by `HOUTINI_LM_BACKEND` (`openai-compat` | `cli` | `auto`). The three seams — `chatCompletionStreamingInner`, `listModelsRaw`, and the `embed` handler — branch `if (cliBackend) … else <local HTTP path>`.
- **Local selection** = `routeToModel` (override-first → capability scoring over loaded models → first-loaded ties). Unchanged by this work.
- **CLI selection** = `CliPool` (capability score → round-robin/LRU tie-break → cooldown/auth failover).
- The local HTTP/SSE inference path is **inline** in `index.ts` (never extracted behind the `InferenceBackend` interface).

## 3. Design

### 3.1 Backend registry
Promote both paths to first-class `InferenceBackend`s in one process:
- **`OpenAICompatBackend`** (NEW) — extract today's inline local path (the streaming `/v1/chat/completions` body, `listModelsRaw`, and the `/v1/embeddings` call) behind the existing `InferenceBackend` interface. Must be **behavior-identical** to today.
- **`CliBackend`** (exists) — the CLI subscription pool.
- **`BackendRegistry`** — holds `{ local: OpenAICompatBackend, cli?: CliBackend }`; `cli` is present only when a CLI pool is configured.

### 3.2 Binary router
A `Router` sits at the three seams. Per call:
1. **Override short-circuit (preserves D6).** If an explicit id is given — tool `model` param, `HOUTINI_LM_MODEL`, or `HOUTINI_LM_PROFILE` — resolve its backend by where the id lives (matches a CLI profile id → CLI; otherwise → local) and run it **verbatim**, bypassing the rules.
2. **Otherwise decide local vs CLI.** Evaluate the deterministic escalation rules (§3.3) over the call's signals. If a rule says "escalate" **and** a CLI backend is configured → route to `cli`; else → `local`.
3. **Dispatch.**
   - `local` → `OpenAICompatBackend`; `routeToModel` picks the local model exactly as today.
   - `cli` → `CliBackend`; selection per §3.4.

CLI is treated as strictly more powerful than local, so escalation only ever moves **up** (local → CLI), never down.

### 3.3 Escalation rules (deterministic)
New config `HOUTINI_LM_ROUTING_CONFIG` (path to JSON), or a `routing` block in the CLI config:
```jsonc
{
  "escalateToCliWhen": [
    { "taskType": "analysis" },                       // analysis always escalates
    { "tool": "code_task_files", "minFiles": 3 },     // big multi-file reviews
    { "minInputChars": 32000 },                       // ~8k tokens of input
    { "taskType": "code", "minInputChars": 16000 }    // large code tasks
  ],
  "default": "local"                                  // no rule matches → local
}
```
- A call escalates if **any** rule matches (logical OR). Conditions within one rule are ANDed.
- **Signals** (all available before dispatch, no inference needed):
  - `taskType`: `chat | code | analysis | embedding` (from the tool's `routeToModel` task type).
  - `tool`: `chat | code_task | code_task_files | custom_prompt | embed`.
  - `minInputChars` / `minInputTokens`: size of the assembled prompt+context. Char-based; token = `chars/4` estimate (no tokenizer dependency).
  - `minFiles`: count of `paths` for `code_task_files`.
- **`embed` never escalates** — the CLI backend has no embeddings; embed always uses the local/embed path.
- No config, or no rule matches → `default` (`local`).
- Ships with a sane default rule set; fully user-tunable.

### 3.4 CLI tier selection (goal #5)
`CliPool` selection order:
1. **Explicit role match** — a profile may declare `roles: string[]`; if the call's role (MVP: the `taskType`) matches a profile's role, prefer it.
2. Otherwise **tie-break** by the pool's `tieBreak` setting: **`first-loaded`** (default) or **`round-robin`** (the existing RR/LRU spreading, opt-in).
3. **Cooldown / auth-blocked failover** unchanged (skip unavailable profiles, fall to the next candidate).

New config fields:
- `tieBreak: "first-loaded" | "round-robin"` at the pool level (default `first-loaded`).
- `roles?: string[]` per profile.

### 3.5 Activation & backward compatibility
- A new `HOUTINI_LM_BACKEND=router` enables the registry+router. It requires a local endpoint (`HOUTINI_LM_ENDPOINT_URL`) **and** a CLI pool (`HOUTINI_LM_CLI_CONFIG`); `HOUTINI_LM_ROUTING_CONFIG` is optional (defaults to "escalate nothing" → all local until rules are added).
- `openai-compat` | `cli` | `auto` (unset) modes are **unchanged** — single-backend, exactly today's behavior. The router is purely additive and opt-in.
- The `OpenAICompatBackend` extraction must not change the local path's observable behavior (same SSE handling, footer, reasoning handling, stats).

### 3.6 Scope (YAGNI — explicitly NOT building)
- No escalate-after-trying / cascade, no confidence signals, no judge, no classifier model.
- No N-tier ladder — exactly two tiers (`local`, `cli`).
- Rules are a small deterministic table; "good enough" is whatever the rules assert (the router cannot discover that a small task was secretly hard — accepted tradeoff).

## 4. Components / files
- `src/backends/openai-compat.ts` (NEW) — `OpenAICompatBackend` (extracted local path: chat/listModels/embed).
- `src/backends/registry.ts` (NEW) — `BackendRegistry`.
- `src/backends/router.ts` (NEW) — `Router`: rule evaluation + override resolution + dispatch.
- `src/backends/routing-config.ts` (NEW) — parse/validate `HOUTINI_LM_ROUTING_CONFIG` (the `escalateToCliWhen` rules + default).
- `src/backends/cli/pool.ts` (MODIFY) — add `tieBreak` (`first-loaded` | `round-robin`) and role-match selection.
- `src/backends/cli/profiles.ts` (MODIFY) — parse `tieBreak` (pool-level) and `roles?` (per profile).
- `src/index.ts` (MODIFY) — bootstrap the registry+router under `HOUTINI_LM_BACKEND=router`; the 3 seams delegate to the router. Thread the router's signals — `tool` and the input-size measure — into `ChatOptions` alongside the existing `taskType`/`overridden` (already added by the CLI-backend work); the router reads them from there, so no new plumbing through the inference call.
- `src/types.ts` (MODIFY if needed) — shared routing types (`Tier`, `RoutingDecision`, signal shape).

## 5. Routing algorithm (precise)
```
route(call):                       # call = { messages/prompt, taskType, tool, overrideId?, inputChars, fileCount }
  if call.overrideId:
    backend = registry.cli?.has(call.overrideId) ? cli : local
    return backend.run(verbatim id)            # D6: no rules, no failover beyond backend's own
  if registry.cli is absent:
    return local.run(call)                     # routeToModel picks local model
  if call.tool == 'embed':
    return local.embed(call)                   # CLI can't embed
  escalate = any(rule matches signals for rule in config.escalateToCliWhen)
  return (escalate ? cli : local).run(call)
```
- `local.run` → existing `routeToModel` + OpenAI path.
- `cli.run` → `CliPool` select (role → tieBreak → failover) + adapter spawn.

## 6. Testing
- **Router** (fake backends, no real inference): each rule → correct local/CLI decision; `minInputChars`/`minFiles` thresholds at/over/under boundary; default when no rule matches; override id → correct backend (local model id vs CLI profile id); `embed` never escalates; CLI-absent → always local.
- **CliPool**: `tieBreak: 'first-loaded'` vs `'round-robin'`; role match beats tie-break; cooldown/auth still skips.
- **OpenAICompatBackend**: extraction is behavior-identical (reuse existing local-path tests / mock fetch).
- **Backward compat**: with no router config (`openai-compat`/`cli`/`auto`), behavior unchanged.

## 7. Deferred / open
- Roles are MVP-simple (role == `taskType`). Richer explicit role tagging per call is deferred.
- Input size is a char/4 token estimate (no tokenizer). Adequate for threshold rules.
- Per-rule combinators beyond AND-within-rule / OR-across-rules are deferred.

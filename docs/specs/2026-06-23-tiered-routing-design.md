# Tiered multi-backend routing — design spec

**Date:** 2026-06-23
**Status:** Draft for review (rev 2 — caller-primary routing)
**Fork:** `ibreakshit/houtini-lm`, builds on branch `feat/cli-backend`

## 1. Goal

A **single** houtini instance holds **both** a local backend and a CLI backend. **The caller is the primary router** — it understands the task and (via discovery) the available models, so it chooses the tier. Houtini's job is to:
- **(a) advertise** the available backends/tiers and a default rule set as *hints*, so the caller can choose well;
- **(b) honor** the caller's explicit routing choice;
- **(c) fall back** to predefined deterministic rules when the caller gives no directive.

Selection is deterministic and upfront — no run-then-judge, no escalation-after-failure, no classifier model. The router cannot *infer* difficulty (nothing pre-inference can); it routes on the caller's directive, else on the *shape* of the request.

User goals:
1. One instance with multiple backends — local **and** CLI.
2. Prefer the cheaper (local) backend when good enough; don't waste powerful models on simple tasks.
3. Tasks the local backend can't handle go to the CLI.
4. Net effect: simple tasks → local; complex tasks → CLI.
5. CLI ties: explicit **role** match wins; else **first-loaded** by default (round-robin/LRU opt-in).
6. The **caller** routes; houtini supplies hints + a default-rules fallback.

## 2. Current state (the seam this changes)

- A server runs **one** backend (`HOUTINI_LM_BACKEND` = `openai-compat` | `cli` | `auto`). The three seams — `chatCompletionStreamingInner`, `listModelsRaw`, `embed` — branch `if (cliBackend) … else <local HTTP path>`.
- **Local selection** = `routeToModel` (override-first → capability scoring → first-loaded ties). Unchanged by this work.
- **CLI selection** = `CliPool` (capability score → round-robin/LRU → cooldown/auth failover).
- The local HTTP/SSE path is **inline** in `index.ts`, never extracted behind `InferenceBackend`.

## 3. Design

> **Implementation note (as-built, 2026-06-23):** the shipped code diverges from §3.1 and §4 below to minimise the diff against upstream. There is **no** `OpenAICompatBackend` / `openai-compat.ts` extraction and **no** `BackendRegistry` class. Instead the inline local `/v1` path stays in `index.ts` and is wrapped by a thin `localBackend` `InferenceBackend` adapter; `Router` (`src/backends/router.ts`) holds `{ local, cli }` directly; and the three seams dispatch through a module-level `activeBackend` (`null` ⇒ the unchanged inline path). `listModelsRaw()` was split into a merged dispatcher plus a local-only `listLocalModelsRaw()` to prevent a `Router.listModels → localBackend.listModels → listModelsRaw` recursion. The routing **behaviour** (precedence, rules, tiers, discovery output) matches §3.2–§3.6; only the file/class structure differs. See [the plan](../plans/2026-06-23-tiered-routing.md) and `DEVELOPER.md` § *Inference backends & tiered routing*.

### 3.1 Backend registry
Promote both paths to first-class `InferenceBackend`s in one process:
- **`OpenAICompatBackend`** (NEW) — extract today's inline local path (streaming `/v1/chat/completions`, `listModelsRaw`, `/v1/embeddings`) behind the `InferenceBackend` interface. **Behavior-identical** to today.
- **`CliBackend`** (exists) — the CLI subscription pool.
- **`BackendRegistry`** — `{ local: OpenAICompatBackend, cli?: CliBackend }`; `cli` present only when a CLI pool is configured.

### 3.2 Routing precedence (per call, deterministic)
A `Router` at the three seams resolves `(backend, model)`:
1. **Exact override** — `model` param / `HOUTINI_LM_MODEL` / `HOUTINI_LM_PROFILE`. Resolve the backend by where the id lives (matches a CLI profile id → `cli`; else `local`). Run **verbatim** (preserves D6). Most specific; wins over everything.
2. **Caller tier directive** — a new `tier: "local" | "cli"` param. → that tier (`cli`: the pool picks the profile per §3.4; `local`: `routeToModel` picks the model). **This is the caller's primary lever.**
3. **Fallback rules** (§3.3) — only when the caller supplied neither `model` nor `tier`. Deterministic shape/size rules decide local vs CLI.
4. **Dispatch** — `local` → `OpenAICompatBackend` (+ existing `routeToModel`); `cli` → `CliBackend` (+ pool selection).

CLI is treated as strictly more powerful, so escalation only ever moves **up** (local → CLI), never down. If `tier:"cli"` is requested but no CLI backend is configured, fall back to local (with a one-line stderr note).

### 3.3 Fallback rules — *and* the advertised hints
A default rule set does double duty: the **fallback** when the caller doesn't route, **and** the **hints** houtini surfaces to the caller (§3.5). Config `HOUTINI_LM_ROUTING_CONFIG` (or a `routing` block in the CLI config):
```jsonc
{
  "escalateToCliWhen": [
    { "tool": "code_task_files", "minFiles": 2 },        // cross-file reasoning is a PROVEN local hole — hallucinated on a 2-file review (2026-06-21 shakedown)
    { "minInputChars": 28000 },                          // ~7k tok: stay under the ~8k-tok / 60s code_task_files timeout cliff
    { "taskType": "analysis", "minInputChars": 12000 },  // deep/long analysis; small explainers stay local
    { "taskType": "code", "minInputChars": 16000 }       // large code tasks
  ],
  "default": "local"
}
```
- Escalates if **any** rule matches (OR across rules; AND within a rule).
- **Signals** (deterministic, pre-inference; sourced from `ChatOptions` — see §4): `taskType` (`chat|code|analysis|embedding`), `tool` (the 5 tools), `minInputChars`/`minInputTokens` (assembled prompt+context size; token = chars/4 estimate), `minFiles` (`code_task_files` path count).
- **`embed` never escalates** — the CLI backend has no embeddings; embed is always local. A `tier:"cli"` on embed is ignored.
- Defaults are **grounded in the 2026-06-21 gpt-oss-120b shakedown** (`houtini-lm-usage.md`): cross-file review and inputs over ~8k tok are *proven* local failures (the multi-file review hallucinated two findings; large inputs hit the 60s timeout), while single-function review, test stubs, explainers, and reformatting are *proven* local wins — those stay local. Tune from observed misroutes. **No `max_tokens` rule:** gpt-oss's default output cap is ~25% of its 65k context (~16k tok), so `max_tokens` is almost always the default, not a real "big output" signal. Honest limitation: a *small-but-hard* task goes local unless the caller routes it explicitly — the rules can't catch that (→ caller-declared, §3.5).

### 3.4 CLI tier selection (goal #5)
`CliPool` selection order:
1. **Explicit role match** — a profile may declare `roles: string[]`; if the call's role (MVP: the `taskType`) matches, prefer it.
2. **Tie-break** by pool `tieBreak`: **`first-loaded`** (default) or **`round-robin`** (existing RR/LRU spreading, opt-in).
3. **Cooldown / auth-blocked failover** unchanged.

New config: `tieBreak: "first-loaded" | "round-robin"` (pool-level, default `first-loaded`); `roles?: string[]` per profile.

### 3.5 Routing transparency & caller control (the heart of the caller-primary model)
For the caller to route well, it must see the menu and the defaults:
- **`discover` / `list_models` report the full topology** — every model/profile tagged with its **backend + tier** (`local` vs `cli`), grouped (`local: […]`, `cli: […]`), **plus a plain-language summary of the active fallback rules** (e.g. *"defaults → CLI for: code_task_files ≥2 files · any input ≥28KB · analysis ≥12KB · code ≥16KB; else local"*). So the caller can read one `discover` call and know exactly what's available and how an un-annotated call would route.
- **Tools gain a `tier` param** (`"local"|"cli"`) — the coarse caller lever (use the powerful tier without naming a profile). The existing `model` param stays the exact lever.
- **Tool descriptions** note: consult `discover` for tiers; pass `tier`/`model` to route explicitly; otherwise the default rules apply.
- **Caller guidance, surfaced in `discover`** (grounded in `houtini-lm-usage.md`): *"Escalate with `tier:\"cli\"` for correctness-critical reasoning, subtle-bug hunts, whole-module generation, or current/niche-knowledge tasks — these have no size signal, so the default rules won't catch them. Local is fast and reliable for single-function review, test stubs, explainers, and reformatting."*

### 3.6 Activation & backward compatibility
- New `HOUTINI_LM_BACKEND=router` enables the registry+router; requires a local endpoint (`HOUTINI_LM_ENDPOINT_URL`) **and** a CLI pool (`HOUTINI_LM_CLI_CONFIG`); `HOUTINI_LM_ROUTING_CONFIG` optional (no rules → fallback is "all local", caller can still route via `tier`/`model`).
- `openai-compat` | `cli` | `auto` modes are **unchanged** (single-backend, exactly today). Router is purely additive and opt-in. The `tier` param is ignored in single-backend modes.
- `OpenAICompatBackend` extraction must not change the local path's observable behavior.

### 3.7 Scope (YAGNI — NOT building)
- No escalate-after-trying/cascade, no confidence signals, no judge, no classifier.
- No N-tier ladder — exactly two tiers (`local`, `cli`).
- Difficulty is never inferred; routing is caller directive → shape/size fallback.

## 4. Components / files
- `src/backends/openai-compat.ts` (NEW) — `OpenAICompatBackend` (extracted local chat/listModels/embed).
- `src/backends/registry.ts` (NEW) — `BackendRegistry`.
- `src/backends/router.ts` (NEW) — `Router`: precedence (override → tier → rules) + dispatch.
- `src/backends/routing-config.ts` (NEW) — parse/validate `escalateToCliWhen` rules + `default`; expose a `describeRules()` for the discovery hint text.
- `src/backends/cli/pool.ts` (MODIFY) — `tieBreak` + role-match selection.
- `src/backends/cli/profiles.ts` (MODIFY) — parse `tieBreak` (pool) + `roles?` (profile).
- `src/index.ts` (MODIFY) — bootstrap registry+router under `HOUTINI_LM_BACKEND=router`; seams delegate to the router; add the `tier` param to the chat/code_task/code_task_files/custom_prompt tool schemas; thread `tool` + input-size into `ChatOptions` (alongside existing `taskType`/`overridden`); extend `discover`/`list_models` output with tier grouping + the rules summary.
- `src/types.ts` (MODIFY) — routing types (`Tier = 'local'|'cli'`, `RoutingDecision`, signal shape).

## 5. Routing algorithm (precise)
```
route(call):   # call = { messages, taskType, tool, overrideId?, tierHint?, inputChars, fileCount }
  if call.overrideId:                              # precedence 1: exact
    backend = registry.cli?.has(overrideId) ? cli : local
    return backend.run(verbatim overrideId)
  if call.tool == 'embed':                         # CLI can't embed
    return local.embed(call)
  if call.tierHint == 'cli'  and registry.cli:     # precedence 2: caller tier
    return cli.run(call)
  if call.tierHint == 'local' or registry.cli absent:
    return local.run(call)
  escalate = any(rule matches signals)             # precedence 3: fallback rules
  return (escalate ? cli : local).run(call)
```
- `local.run` → existing `routeToModel` + OpenAI path.
- `cli.run` → `CliPool` (role → tieBreak → failover) + adapter spawn.

## 6. Testing
- **Router** (fake backends): precedence — exact override → tier hint → fallback rules; `tier:"cli"` with no CLI → local + note; `embed` always local; each fallback rule + size/file thresholds at boundaries; default when nothing matches.
- **Discovery**: `discover`/`list_models` output groups models by tier and includes the rules summary; matches the configured rules.
- **CliPool**: `tieBreak` `first-loaded` vs `round-robin`; role match beats tie-break; cooldown/auth still skips.
- **OpenAICompatBackend**: extraction behavior-identical (mock fetch / reuse local-path tests).
- **Backward compat**: `openai-compat`/`cli`/`auto` unchanged; `tier` param ignored there.

## 7. Deferred / open
- Roles are MVP-simple (role == `taskType`). Richer explicit role tagging deferred.
- Input size is a chars/4 token estimate (no tokenizer). Adequate for thresholds.
- Per-rule combinators beyond AND-within / OR-across deferred.
- Surfacing *per-task* routing recommendations in tool responses (beyond `discover`) deferred.

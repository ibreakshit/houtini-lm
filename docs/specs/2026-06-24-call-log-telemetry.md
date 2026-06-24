# Per-call usage telemetry (`call_log`) for houtini-lm

| Field | Value |
|---|---|
| Date | 2026-06-24 |
| Status | Draft — implementation pending; PR deferred until verified locally |
| Target | a branch off `upstream/main` (github.com/houtini-ai/lm), independently mergeable — NOT stacked on `feat/cli-backend` |

## 1. Motivation

houtini-lm currently persists only aggregate per-model counters in `model_performance` plus prefill samples in `model_prefill_samples`, stored in the sql.js DB at `~/.houtini-lm/model-cache.db`.

Because there is no per-call record, users cannot currently:

| Need | Current limitation |
|---|---|
| Audit individual calls | No persisted call-level rows |
| See usage over time | Only aggregate counters are stored |
| Break savings down by tool/tier/model | No per-call `tool` or `tier` dimension exists |
| Debug routing decisions | No durable record of which model/tier handled a call |

Goal: add an opt-out per-call log so ANY houtini-lm user, on ANY MCP client, gets queryable usage telemetry with zero setup.

EXPLICITLY OUT OF SCOPE: "when houtini was NOT used" — structurally invisible to the server because a call never made never reaches it. That belongs to the calling agent, not this PR.

## 2. Design principles (upstream-compatibility)

| Principle | Requirement |
|---|---|
| Additive only | Add a new table and new functions only. Make zero changes to existing tables, behavior, or tool outputs. Existing users must be unaffected. |
| Bounded retention is MANDATORY | `model-cache.ts` uses sql.js (pure WASM), and `saveDb()` re-serializes the ENTIRE DB to disk on every write. An unbounded log would bloat every save. Mirror the existing `model_prefill_samples` convention, which is capped at `PREFILL_SAMPLES_PER_MODEL = 100` and prunes oldest rows on insert. |
| Opt-out via env | `HOUTINI_LM_TELEMETRY` defaults ON. `0`/`false` disables recording AND the query output. |
| Tier-agnostic | `tier` is nullable. Use `NULL` when not in router mode so the feature merges independently of the CLI-backend/router feature. |
| Fire-and-forget | Recording must never block or break a tool response. Match the existing `recordPerformance` `.catch()` pattern. |

## 3. Schema — in `src/model-cache.ts` initDb(), next to `model_performance` (~line 247)

```sql
CREATE TABLE IF NOT EXISTS call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                 -- Date.now() ms
  model_id TEXT NOT NULL,
  tier TEXT,                           -- 'local' | 'cli' | NULL
  tool TEXT,                           -- 'chat' | 'custom_prompt' | 'code_task' | 'code_task_files' | NULL
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL,       -- prompt + completion (mirrors getLifetimeTotals())
  ttft_ms INTEGER,
  tok_per_sec REAL,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_call_log_ts ON call_log(ts DESC);
```

New-table-only ⇒ `CREATE TABLE IF NOT EXISTS` handles upgrades; no ALTER migration needed.

## 4. Recording — `src/model-cache.ts`

Add:

```ts
export const CALL_LOG_MAX_ROWS = 5000;   // env override: HOUTINI_LM_TELEMETRY_MAX
export async function recordCall(entry): Promise<void>
```

`recordCall` behavior:

| Step | Requirement |
|---|---|
| Guard | Return without writing when telemetry is disabled. |
| Insert | Insert exactly one `call_log` row for the entry. |
| Prune | Prune oldest rows beyond the cap using the same prune-on-insert approach as `recordPrefillSample`. |
| Persist | Call `saveDb()`. |
| Caller contract | Caller fire-and-forgets; recording must not affect tool response delivery. |

## 5. Wiring — `src/index.ts`

`recordUsage(resp)` is defined at line 189 and called at line 1506. It already has `resp.model`, the token counts, `tokPerSec`, and `ttftMs` in scope, but NOT `tool` or `tier`:

| Value to thread in | Source |
|---|---|
| `tool` | `request.params.name`, available at the handler ~line 1888 |
| `tier` | resolved tier, in scope in each tool `case` ~lines 1894–2112 |

Thread `tool` and `tier` into `recordUsage`. Note: line 2020 already passes a `tool:` field into the completion path, so the seam partly exists.

In `recordUsage` (~line 254), alongside the existing `recordPerformance(...)` call, fire-and-forget:

```ts
recordCall({
  ts,
  modelId: resp.model,
  tier,
  tool,
  promptTokens,
  completionTokens,
  reasoningTokens,
  tokensSaved: promptTokens + completionTokens,
  ttftMs: resp.ttftMs,
  tokPerSec,
  ok: true,
}).catch((err) => {
  process.stderr.write(`[houtini-lm] Call-log write failed (continuing): ${err}\n`);
});
```

Error path: optionally record failed calls with `ok = 0` and zero tokens — useful for diagnostics.

## 6. Query surface — `src/model-cache.ts` + `stats` handler (`src/index.ts` ~line 2366)

Add to `src/model-cache.ts`:

| Function | Purpose |
|---|---|
| `getRecentCalls(limit, sinceMs?)` | Return recent per-call rows, newest first. |
| `getUsageSummary(sinceMs?)` | Aggregate counts + summed `tokens_saved`, grouped by `tier`, `tool`, and `model`. |

Extend the existing `stats` tool with an optional, back-compatible arg (default output unchanged). When the detail arg is provided and telemetry is enabled, append a recent-calls table plus a tier/tool breakdown. This avoids registering or documenting a whole new tool.

## 7. Config / env

| Env | Default | Effect |
|---|---:|---|
| `HOUTINI_LM_TELEMETRY` | `1` | `0`/`false` disables recording + detail output |
| `HOUTINI_LM_TELEMETRY_MAX` | `5000` | per-row retention cap |

Document both in the README env table + DEVELOPER.md.

## 8. Tests — `test/telemetry.test.ts` (`tsx --test`)

Testing requires a DB-path override seam for isolation because model-cache uses `homedir()/.houtini-lm`. If no such seam exists, ADD one (e.g. honor an env override) as part of this work.

| Case | Assertion |
|---|---|
| `recordCall` inserts correct fields | Persisted row matches the provided entry fields. |
| `tokens_saved === prompt + completion` | `tokens_saved` equals prompt tokens plus completion tokens. |
| Pruning caps at MAX keeping newest | Row count is capped and the newest rows remain. |
| `getUsageSummary` aggregates by tier/tool | Summary groups and sums by `tier` and `tool`. |
| Telemetry disabled (`env=0`) records nothing | No row is inserted when disabled. |
| Failed call (`ok=0`) recorded with zero tokens | Failed diagnostic row persists with `ok=0` and zero tokens. |

## 9. Docs

| File | Required change |
|---|---|
| CHANGELOG | Add a `## [Unreleased]` → `### Added` entry, Keep-a-Changelog style, matching existing entries. |
| README | Add env table rows, a short "Usage telemetry" section, and stats detail usage. |
| DEVELOPER.md | Add a schema note. |

## 10. Non-goals

| Non-goal | Reason |
|---|---|
| Non-use telemetry | Client-side concern (the server cannot observe a call that never happened). |
| Cost ($) computation | Tokens only — pricing is client/model-specific. |
| Per-call prompt/response CONTENT | Store counts only — privacy + DB size. |

## 11. PR plan (DEFERRED — do not open PR yet)

1. Branch off `upstream/main`.
2. Implement (TDD).
3. `npm run build`.
4. `npm run test:unit`.
5. `npm run shakedown` for a live check.
6. Manually verify future Claude sessions record.
7. Only after verified locally: open PR to houtini-ai/lm. Not before.

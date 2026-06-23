# Houtini LM — Shakedown test prompt

This is the canonical end-to-end test for houtini-lm. There are two ways to
run it:

1. **Automated** — `npm run shakedown` runs [`shakedown.mjs`](./shakedown.mjs)
   which talks directly to your configured endpoint (LM Studio, Ollama, or any
   OpenAI-compatible host) and prints a summary table with real TTFT / tok/s /
   reasoning-token-split for each tool.

2. **Conversational via Claude / any MCP client** — copy the prompt below into
   a Claude session that has the houtini-lm MCP server attached. Claude will
   drive the seven steps one at a time, observe each footer, and write you the
   report at the end. Useful when you want a human-readable quality review, not
   just latency numbers.

Both modes exercise the same seven tools in the same order. The conversational
version additionally evaluates output quality — did the JSON conform to the
schema, are the tests usable, did cross-file review actually cross-reference.
The automated script only checks shape (valid JSON, code-like content,
cross-file mentions); it does not judge correctness.

---

## The prompt

Paste everything from the first `#` below into your MCP-enabled chat.

---

# Houtini LM shakedown

You have the houtini-lm MCP server available. I want to exercise it
end-to-end and get a read on latency, quality, routing, and the footer
metadata.

## Ground rules (non-negotiable)

- When delegating to houtini-lm, always send COMPLETE code. If a whole file is
  too large to include, send the complete function or class under review —
  never a snippet with "..." in the middle. The local LLM cannot read files
  unless you use `code_task_files` with absolute paths.
- Between each step, check the response footer. Note the model, TTFT, tok/s,
  any quality flags (think-blocks-stripped, TRUNCATED, tokens-estimated,
  reasoning-only, PREFILL-STALL), and how the 💰 "Claude quota saved"
  number climbs over the session.
- If the 📊 first-call benchmark line appears on the first measured call,
  record the tok/s figure — that's our baseline for deciding whether to
  delegate longer work.

## Steps

1. Call `discover` first. Report:
   - Is the endpoint online? What's the active model?
   - Context window size?
   - Connection latency (which is NOT inference speed)
   - Any measured speed shown? (Should say "not yet benchmarked" on a fresh
     install; returning users see lifetime stats from the SQLite cache.)

2. Call `list_models`. Report:
   - How many models are loaded vs available-but-not-loaded?
   - Does the routing suggestion look sensible for code vs chat vs embedding?

3. `chat` — low-stakes sanity check.
   Ask: "In 3 bullets, what are the main trade-offs between WebSockets and
   Server-Sent Events?" Note TTFT and final answer quality.

4. `custom_prompt` — structured review.
   Pick a real function from this codebase (paste the COMPLETE function, not
   a snippet). Use system="Senior TypeScript reviewer, focused on error
   handling and edge cases. No preamble.", context=<the full function>,
   instruction="Return a JSON array of {line, severity: low|medium|high,
   issue, suggestion}. Max 5 items." Include a json_schema to force valid
   JSON. Check: did it return valid JSON? Did severity values stay in the
   enum? Did line numbers make sense?

5. `code_task` — test stub generation.
   Paste a COMPLETE small function from this codebase (imports + full body).
   Task: "Write 3 Jest tests covering happy path, one edge case, and one
   error path. No preamble, output only the test code." Language:
   "typescript". Check: does the test compile mentally? Does it import
   what it needs?

6. `code_task_files` — multi-file review.
   Give it the ABSOLUTE paths of two related files (e.g. a module and its
   test, or two files from a single feature). Task: "Find any bug, dead
   code, or naming inconsistency. Reference filename and line number for
   each finding. Return a terse list, max 7 items." Check: does it actually
   cross-reference across files, or just review each in isolation?

7. `embed` — quick vector test.
   Embed the sentence "Large language models running locally." Report the
   dimension count and confirm the response shape.

8. Final `discover` call. Report:
   - Does measured speed now show (tok/s + TTFT averaged over the session)?
   - How does the cumulative 💰 number compare to your own token spend
     guessing at what those same tasks would have cost on Claude?

## Report format

After step 8, give me:

- A table: tool | worked? | TTFT ms | tok/s | quality flags | notes
- One honest paragraph on quality of outputs — was step 4's JSON clean?
  Were the tests in step 5 usable? Did step 6's cross-file analysis feel
  real?
- Any footguns you hit (timeout, empty response, routing surprises, model
  load state, weird flag combinations).
- Your own verdict: for which kinds of tasks in this codebase is houtini
  a genuine win, and where is it not worth the wall-clock cost?

Do NOT fabricate latency numbers. If a call fails, report the failure and
move on — no synthetic warmups, no "averaged" guesses. The only numbers
that belong in the report are the ones the footer actually emitted.

---

# Part 2 — CLI delegation shakedown (router mode)

Everything above exercises the **local model only**. This fork adds a tiered
router (`HOUTINI_LM_BACKEND=router`) that holds a local backend **and** a CLI
backend (codex / claude / llm) in one instance and routes each call. Part 2
stress-tests that routing: easy work must stay **local** (cheap), and tasks the
local model is *proven* to handle badly must escalate to the **CLI tier**.

## Why these cases

From the 2026-06-21 gpt-oss-120b shakedown (`houtini-lm-usage.md`), the local
model's proven holes are: **cross-file reasoning** (it reviewed files in
isolation and hallucinated two findings), **large inputs** (>~8k tok hit the
~60s timeout), and **deep / correctness-critical reasoning** (very high
reasoning:visible ratio, confidently wrong). Those are exactly the tasks the
CLI tier — a frontier model on the user's own subscription — should pick up.
Routing is deterministic and upfront: `model` override → caller `tier` → the
default escalation rules (`code_task_files` ≥2 files, input ≥28 000 chars,
`analysis` ≥12 000, `code` ≥16 000) → else local.

## Automated — `npm run shakedown:cli`

`shakedown-cli.mjs` drives the **built MCP server over stdio in router mode**
(the only path that exercises the Router) and asserts, per case, *which*
backend actually answered — parsed from the footer `Model:` line — against the
expected tier.

```
npm run build
HOUTINI_LM_ENDPOINT_URL=http://<host>:<port> \
HOUTINI_LM_CLI_CONFIG=/abs/path/pool.json \
npm run shakedown:cli
```

`pool.json` is a CLI pool with at least one profile, e.g.:

```json
{ "profiles": [
  { "id": "codex", "provider": "codex", "bin": "codex",
    "model": "<your-codex-model>", "capabilities": ["chat", "code", "analysis"] }
] }
```

## Cases

| # | Tool | Input | Tier directive | Expected route | Why |
|---|------|-------|----------------|----------------|-----|
| 1 | `discover` | — | — | topology shown | the caller must see the `local:` / `cli:` groups + active rules |
| 2 | `chat` | easy explainer | none | **local** | cheap, bounded work stays local |
| 3 | `code_task` | tiny function | none | **local** | small code must NOT over-escalate |
| 4 | `chat` | subtle concurrency bug, reason precisely | `tier:"cli"` | **cli** | correctness-critical reasoning — explicit caller escalation |
| 5 | `code_task_files` | two real source files | none | **cli** | cross-file reasoning (proven local hole) auto-escalates via the ≥2-files rule |

Pass = the call returned real output **and** the backend that answered matches
the expected tier. A "MISMATCH" means routing sent the call to the wrong tier.

## Ground rules

- CLI-tier calls spend the user's **subscription** quota (codex/claude) — not
  the Claude quota, not local compute. They are slower than local but handle
  what local can't. Don't escalate work the local model already does well.
- Send COMPLETE code (same rule as Part 1) — the local model can't read files
  except via `code_task_files`.
- Report only real numbers from the run — no synthetic latency.

## Report format

A table: case | tool | expected tier | routed tier | model that answered |
time | ok | notes — plus one honest paragraph: did escalation fire where it
should, did local hold the cheap cases without over-escalating, and was the
CLI output actually better on the hard ones than local would have been.

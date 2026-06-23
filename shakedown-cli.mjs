#!/usr/bin/env node
/**
 * Houtini LM — CLI-delegation shakedown (router mode, live end-to-end)
 *
 * Unlike shakedown.mjs (which talks DIRECTLY to the /v1 endpoint and therefore
 * only exercises the LOCAL model), this harness drives the *built MCP server*
 * over stdio in ROUTER mode (HOUTINI_LM_BACKEND=router). That is the only way
 * to exercise the tiered-routing path that this fork adds:
 *
 *   - easy work should stay LOCAL (cheap gpt-oss), and
 *   - tasks the local model is PROVEN to handle badly (cross-file reasoning,
 *     correctness-critical reasoning) should escalate to the CLI tier (codex) —
 *     either by an explicit tier:"cli" directive or by the default rules.
 *
 * For each case it asserts WHICH backend actually answered — parsed from the
 * response footer's `Model:` line — against the expected tier, then prints a
 * summary table. No synthetic numbers: every figure comes from the live run.
 *
 * Usage:
 *   npm run build
 *   HOUTINI_LM_ENDPOINT_URL=http://<host>:<port> \
 *   HOUTINI_LM_CLI_CONFIG=/abs/path/pool.json \
 *   node shakedown-cli.mjs          # or: npm run shakedown:cli
 *
 * Optional: HOUTINI_LM_ROUTING_CONFIG=/abs/routing.json (else DEFAULT rules).
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.SHAKEDOWN_SERVER || join(REPO, 'dist', 'index.js');
const ENDPOINT = process.env.HOUTINI_LM_ENDPOINT_URL || process.env.LM_STUDIO_URL;
const POOL = process.env.HOUTINI_LM_CLI_CONFIG;

if (!ENDPOINT) { console.error('Set HOUTINI_LM_ENDPOINT_URL to your local OpenAI-compatible endpoint.'); process.exit(2); }
if (!POOL) { console.error('Set HOUTINI_LM_CLI_CONFIG to a CLI pool JSON (>=1 profile, e.g. codex).'); process.exit(2); }

// ── spawn the server in router mode ────────────────────────────────────
const child = spawn('node', [SERVER], {
  env: { ...process.env, HOUTINI_LM_BACKEND: 'router' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (/router active|CLI backend|error/i.test(s)) process.stderr.write(`   [server] ${s}\n`);
});
child.on('exit', (code, sig) => { if (code && code !== 0) process.stderr.write(`   [server exited code=${code} sig=${sig}]\n`); });

// ── newline-delimited JSON-RPC client (matches MCP stdio transport) ─────
let buf = '';
let nextId = 1;
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg);
    }
    // unmatched messages (progress notifications etc.) are ignored
  }
});

function rpc(method, params, timeoutMs = 240_000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const textOf = (res) => (res?.result?.content || []).map((c) => c.text || '').join('\n');
const footerModel = (txt) => { const m = txt.match(/Model:\s*([^\n|]+)/); return m ? m[1].trim() : null; };

// ── stress cases — easy stays local, hard escalates to CLI ──────────────
const SUBTLE_BUG = `let cache = {};
async function getOnce(key, fetchFn) {
  if (cache[key]) return cache[key];
  cache[key] = await fetchFn(key);
  return cache[key];
}`;

const SMALL_FN = `export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}`;

const CASES = [
  {
    name: 'chat-easy', tool: 'chat', expect: 'local',
    args: { message: 'In exactly 3 bullet points, summarise the main trade-offs between WebSockets and Server-Sent Events. No preamble.' },
  },
  {
    name: 'code_task-small', tool: 'code_task', expect: 'local',
    args: { code: SMALL_FN, task: 'Explain what this function does in 2 sentences.', language: 'typescript' },
  },
  {
    name: 'chat-hard (tier:cli)', tool: 'chat', expect: 'cli',
    args: {
      tier: 'cli',
      message: `Reason precisely about this JavaScript:\n\n${SUBTLE_BUG}\n\nIf getOnce is called TWICE CONCURRENTLY with the same key before the first fetchFn resolves, exactly how many times is fetchFn invoked, and why? Then give the precise one-line fix.`,
    },
  },
  {
    name: 'code_task_files-crossfile (rules escalate)', tool: 'code_task_files', expect: 'cli',
    args: {
      language: 'typescript',
      paths: [join(REPO, 'src/backends/router.ts'), join(REPO, 'src/backends/routing-config.ts')],
      task: 'Cross-reference BOTH files. Does the Router use every export of routing-config.ts correctly? Flag any inconsistency between how routing-config defines escalation-rule evaluation and how the Router invokes it. Reference filename and line for each point. Max 7 bullets.',
    },
  },
];

const results = [];
const hr = (l) => console.log(`\n${'─'.repeat(72)}\n${l}\n${'─'.repeat(72)}`);

function classify(model, localIds, cliIds) {
  if (!model || model === '—') return 'unknown';
  if (cliIds.has(model)) return 'cli';
  if (localIds.has(model)) return 'local';
  // fallback heuristic when the footer model isn't in either set
  return /gpt-oss|gemma|qwen|llama|nemotron|granite|instruct/i.test(model) ? 'local' : 'cli';
}

async function main() {
  console.log(`\n🧪 Houtini LM — CLI-delegation shakedown (router mode)`);
  console.log(`   Server:   ${SERVER}`);
  console.log(`   Endpoint: ${ENDPOINT}`);
  console.log(`   Pool:     ${POOL}`);

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shakedown-cli', version: '1' } }, 20_000);
  notify('notifications/initialized', {});

  // CLI ids from the pool (for routing classification)
  const cliIds = new Set();
  try {
    const pool = JSON.parse(await readFile(POOL, 'utf8'));
    for (const p of pool.profiles || []) { if (p.id) cliIds.add(p.id); if (p.model) cliIds.add(p.model); }
  } catch { /* classification falls back to the heuristic */ }

  // discover — topology + learn local ids
  hr('discover — routing topology (local + cli groups + active rules)');
  const localIds = new Set();
  try {
    const r = await rpc('tools/call', { name: 'discover', arguments: {} }, 30_000);
    const txt = textOf(r);
    console.log(txt.split('\n').map((l) => '   ' + l).join('\n'));
    const m = txt.match(/local:\s*(.+)/i);
    if (m) m[1].split(/[,]+/).map((s) => s.trim()).filter((s) => s && s !== '(none)').forEach((id) => localIds.add(id));
    const ok = /local:/i.test(txt) && /cli:/i.test(txt);
    results.push({ name: 'discover', tool: 'discover', expect: 'topology', actual: ok ? 'topology' : 'missing', ms: 0, ok, model: '—', note: ok ? 'local+cli groups shown' : 'no tier grouping' });
  } catch (e) {
    results.push({ name: 'discover', tool: 'discover', expect: 'topology', actual: 'ERROR', ms: 0, ok: false, model: '—', note: e.message });
    console.log(`   ❌ ${e.message}`);
  }

  for (const c of CASES) {
    hr(`${c.tool} — ${c.name}  (expect: ${c.expect})`);
    const t0 = Date.now();
    try {
      const r = await rpc('tools/call', { name: c.tool, arguments: c.args }, 240_000);
      const ms = Date.now() - t0;
      const txt = textOf(r);
      const isErr = r.result?.isError === true || /^Error:/m.test(txt);
      const model = footerModel(txt) || '—';
      const actual = classify(model, localIds, cliIds);
      const ok = !isErr && txt.trim().length > 0 && actual === c.expect;
      console.log(txt.slice(0, 700) + (txt.length > 700 ? '\n   …[truncated]' : ''));
      const verdict = ok ? 'PASS' : isErr ? 'ERROR' : actual !== c.expect ? `MISMATCH (routed ${actual})` : 'EMPTY';
      console.log(`\n   → model=${model} · routed=${actual} · expected=${c.expect} · ${(ms / 1000).toFixed(1)}s · ${verdict}`);
      results.push({ name: c.name, tool: c.tool, expect: c.expect, actual, ms, ok, model, note: isErr ? 'tool error' : actual !== c.expect ? 'wrong tier' : 'ok' });
    } catch (e) {
      results.push({ name: c.name, tool: c.tool, expect: c.expect, actual: 'ERROR', ms: Date.now() - t0, ok: false, model: '—', note: e.message });
      console.log(`   ❌ ${e.message}`);
    }
  }

  hr('Summary');
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n   ${pass}/${results.length} cases passed (endpoint=${ENDPOINT})\n`);
  console.log('| Case | Tool | Expect | Routed | Model | Time | OK | Note');
  console.log('|------|------|--------|--------|-------|------|----|----');
  for (const r of results) {
    console.log(`| ${r.name} | ${r.tool} | ${r.expect} | ${r.actual} | ${r.model} | ${r.ms ? (r.ms / 1000).toFixed(1) + 's' : '—'} | ${r.ok ? '✅' : '❌'} | ${r.note}`);
  }
  console.log('');
  child.stdin.end();
  child.kill('SIGTERM');
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error(`\n💥 shakedown-cli crashed: ${e.stack || e.message}`); try { child.kill('SIGKILL'); } catch {} process.exit(2); });

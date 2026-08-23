/**
 * A/B arm driver — runs each task through both arms and appends ledger entries.
 *
 * Arm A (direct):     spawn `python3 -m flux run-md <task-file> --json`.
 * Arm B (dsh-plugin): call flux_exec.execute() through the mounted plugin.
 *
 * Measures whole-call wall time per arm; arm B additionally measures the
 * harness-path overhead around the child process (validation + scratch write).
 * Runs node --experimental-strip-types (Node >= 22.6).
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { apply } = await import(join(ROOT, 'plugin/src/index.ts'))

const args = Object.fromEntries(process.argv.map((a, i, all) => {
  const m = /^--([\w-]+)$/.exec(a)
  return m ? [m[1], all[i + 1]] : ['_pos' + i, a]
}))
const ROUNDS = Number(args.rounds ?? 3)
const LEDGER = args.ledger
const RUN_ID = args['run-id'] ?? 'unpinned'
const FLUX_SRC = args['flux-src'] ?? '/home/eileen/projects/flux-runtime/src'

const TASKS = [
  { id: 'factorial-small', source: 'factorial of 5', expect: 120 },
  { id: 'sum-100', source: 'sum 1 to 100', expect: 5050 },
  { id: 'arithmetic', source: '6 times 7', expect: 42 },
  { id: 'parse-fail', source: 'movi r999, 5', expect: null },
  { id: 'no-op-garbage', source: 'nothing parses here ((((', expect: 0 },
]

const envFacts = {
  dshTools: JSON.parse(await readFile(join(ROOT, 'plugin/node_modules/@deepseek-ai/dsh-tools/package.json'), 'utf8')).version,
  fluxSource: FLUX_SRC,
  node: process.version,
}

/** Arm A: direct flux CLI, exactly as an agent would call it today. */
function runDirect(file) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn('python3', ['-m', 'flux', 'run-md', file, '--json'], {
      env: { ...process.env, PYTHONPATH: FLUX_SRC },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    child.on('close', () => {
      let ok = false, result = null, cycles = null, error = null
      try {
        const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
        ok = j.success === true
        result = j.result ?? null
        cycles = j.cycles ?? null
        error = j.error ?? null
      } catch { error = 'unparseable' }
      resolve({ ok, result, cycles, error, durationMs: Date.now() - t0, harnessOverheadMs: null })
    })
  })
}

/** Arm B: the flux_exec tool through the plugin's apply()/defineTool path. */
async function runThroughPlugin(tool, source, signal) {
  const t0 = Date.now()
  // Harness-path overhead = everything except the child process itself.
  // Measure by timing execute() minus the bridge outcome's own durationMs
  // (the bridge reports child-process wall time precisely).
  try {
    const value = await tool.execute({ source }, { signal, deferContext() {}, concludeTurn() {} })
    const total = Date.now() - t0
    return {
      ok: value.ok, result: value.result, cycles: value.cycles, error: value.error,
      durationMs: total,
      harnessOverheadMs: total - value.durationMs,
    }
  } catch (err) {
    return {
      ok: false, result: null, cycles: null, error: String(err),
      durationMs: Date.now() - t0, harnessOverheadMs: null,
    }
  }
}

// Mount the plugin once per run (as DSH would).
const registry = new Map()
const effects = []
const ctx = {
  tools: { register: d => registry.set(d.name, d) },
  effect: fn => { const dis = fn(); effects.push(() => dis?.()) },
}
apply(ctx, { fluxBin: 'python3-mux-unused', pythonPath: FLUX_SRC })
// Re-mount with a wrapper binary for `python3 -m flux` (bridge spawns [fluxBin, 'run-md', ...]).
const wrapDir = join(ROOT, 'ab/out', `wrap-${RUN_ID}`)
await mkdir(wrapDir, { recursive: true })
const wrapBin = join(wrapDir, 'flux')
await writeFile(wrapBin, `#!/bin/sh\nexport PYTHONPATH="${FLUX_SRC}:$PYTHONPATH"\nexec python3 -m flux "$@"\n`, { mode: 0o700 })
await import('node:fs').then(fs => fs.chmodSync(wrapBin, 0o700))
registry.clear()
apply(ctx, { fluxBin: wrapBin })
const tool = registry.get('flux_exec')

const entries = []
for (let round = 1; round <= ROUNDS; round++) {
  for (const task of TASKS) {
    // Arm A
    const taskFile = join(wrapDir, `task-${task.id}.md`)
    await writeFile(taskFile, task.source + '\n', 'utf8')
    const a = await runDirect(taskFile)
    entries.push(entry(task.id, 'direct', a))

    // Arm B
    const b = await runThroughPlugin(tool, task.source, new AbortController().signal)
    entries.push(entry(task.id, 'dsh-plugin', b))
  }
}

function entry(task, arm, r) {
  return {
    ts: new Date().toISOString(),
    runId: RUN_ID,
    task,
    arm,
    ok: r.ok,
    result: r.result,
    cycles: r.cycles,
    error: r.error,
    durationMs: r.durationMs,
    harnessOverheadMs: r.harnessOverheadMs,
    timedOut: false,
    aborted: false,
    env: envFacts,
    notes: null,
  }
}

// Append JSONL.
const { appendFile } = await import('node:fs/promises')
for (const e of entries) await appendFile(LEDGER, JSON.stringify(e) + '\n', 'utf8')

// Summary printout (NOT a judgment — raw medians for eyeballing).
const byArmTask = new Map()
for (const e of entries) {
  const key = `${e.arm}|${e.task}`
  byArmTask.get(key) ?? byArmTask.set(key, [])
  byArmTask.get(key).push(e.durationMs)
}
console.log(`runId=${RUN_ID} rounds=${ROUNDS} tasks=${TASKS.length} entries=${entries.length}`)
for (const [key, times] of [...byArmTask.entries()].sort()) {
  const med = [...times].sort((x, y) => x - y)[Math.floor(times.length / 2)]
  console.log(`  ${key.padEnd(28)} median ${String(med).padStart(6)}ms  (n=${times.length})`)
}
console.log('ledger: ' + LEDGER)

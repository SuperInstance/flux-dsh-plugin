/**
 * flux-cells-bridge — the organism's ACTUATORS. Where the cellular seam
 * touches a process. Reuses the embassy's proven process discipline
 * (../../plugin/src/flux-bridge.ts: scrubbed env, detached process groups,
 * SIGTERM→SIGKILL escalation, quiescent close) but splits the single
 * `run-md` call into the two expressions the cells actually own:
 *
 *   flux-parse.py <in.md> <out.flux>   ← the compile cell's scoped expression
 *     (the runtime's OWN parser via scripts/flux-parse.py — the `flux
 *     compile` CLI is broken upstream: empty modules for md/python, broken
 *     register allocation for C. See scripts/flux-parse.py header.)
 *   flux run <out.flux> --cycles N     ← the run cell's scoped expression
 *     (raw bytecode files are accepted as-is by the CLI)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { killTree, scrubEnv } from '../../plugin/src/flux-bridge.ts'

export interface SpawnOutcome {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

export interface CellSpawnOptions {
  fluxBin?: string
  pythonPath?: string
  /** flux-runtime source dir (PYTHONPATH); default FLUX_RUNTIME_SRC or
   *  /home/eileen/projects/flux-runtime/src — same convention as the
   *  embassy test harness. */
  fluxRuntimeSrc?: string
  timeoutMs?: number
  signal?: AbortSignal
  onSpawn?: (child: ChildProcess) => void
}

const DEFAULT_RUNTIME_SRC = process.env.FLUX_RUNTIME_SRC ?? '/home/eileen/projects/flux-runtime/src'

const PARSE_SCRIPT = new URL('../scripts/flux-parse.py', import.meta.url).pathname

/** One scrubbed, group-detached, timeout-guarded flux invocation. Never throws. */
function runFluxArgv(
  argv: string[], opts: CellSpawnOptions = {},
  extraEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
): Promise<SpawnOutcome> {
  const fluxBin = opts.fluxBin ?? 'flux'
  const timeoutMs = opts.timeoutMs ?? 10_000
  const started = Date.now()

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(fluxBin, argv, {
        env: extraEnv ? extraEnv(scrubEnv(process.env, opts.pythonPath)) : scrubEnv(process.env, opts.pythonPath),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (err) {
      resolve({
        ok: false, stdout: '', stderr: `failed to spawn ${fluxBin}: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: null, timedOut: false, aborted: false, durationMs: Date.now() - started,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    opts.onSpawn?.(child)
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8') })

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        ok: !timedOut && !aborted && child.exitCode === 0,
        stdout, stderr,
        exitCode: child.exitCode,
        timedOut, aborted,
        durationMs: Date.now() - started,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      setTimeout(() => { if (!settled) killTree(child) }, 2_000)
    }, timeoutMs)

    function onAbort() {
      if (settled) return
      aborted = true
      killTree(child)
    }

    child.on('error', (err) => { stderr += `\n${err.message}`; finish() })
    child.on('close', finish)
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export interface CompileOutcome extends SpawnOutcome {
  /** Path of the written bytecode file (only when ok). */
  bytecodeFile: string | null
  bytecodeBytes: number | null
}

export function fluxCompile(mdFile: string, out: string, opts: CellSpawnOptions = {}): Promise<CompileOutcome> {
  const runtimeSrc = opts.fluxRuntimeSrc ?? DEFAULT_RUNTIME_SRC
  const python = opts.pythonPath ?? 'python3'
  return runFluxArgv(
    [PARSE_SCRIPT, mdFile, out],
    { ...opts, fluxBin: python },
    // the parser subprocess needs the runtime on its PYTHONPATH
    (env) => ({ ...env, PYTHONPATH: `${runtimeSrc}:${env.PYTHONPATH ?? ''}` }),
  ).then((r) => {
    const m = /^OK (\d+)$/.exec(r.stdout.trim().split('\n').pop() ?? '')
    return {
      ...r,
      ok: r.ok && m !== null,
      stderr: r.ok && !m ? `${r.stderr}\nflux-parse printed unparseable output: ${r.stdout.slice(0, 200)}` : r.stderr,
      bytecodeFile: r.ok && m ? out : null,
      bytecodeBytes: m ? Number(m[1]) : null,
    }
  })
}

export interface RunOutcome extends SpawnOutcome {
  cycles: number
  r0: number | null
  parseError: string | null
}

/** `flux run` prints `Executed in N cycles. R0=V` on success. */
export function fluxRun(bytecodeFile: string, maxCycles: number, opts: CellSpawnOptions = {}): Promise<RunOutcome> {
  return runFluxArgv(['run', bytecodeFile, '--cycles', String(Math.trunc(maxCycles))], opts).then((r) => {
    const m = /Executed in (\d+) cycles\. R0=(-?\d+)/.exec(r.stdout)
    return {
      ...r,
      cycles: m ? Number(m[1]) : 0,
      r0: m ? Number(m[2]) : null,
      parseError: r.ok && !m ? 'unparseable flux run output' : null,
    }
  })
}

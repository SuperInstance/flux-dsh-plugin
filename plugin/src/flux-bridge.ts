/**
 * flux-bridge — the only place this plugin touches a process.
 *
 * Spawns `flux run-md <file> --json` (FLUX runtime, Python impl) and returns
 * ONE structured outcome with orthogonal facts reported independently
 * (ok / timedOut / aborted / exitCode), per DSH `docs/defensive-patterns.md`:
 * "Report orthogonal outcomes independently" — a process can be cancelled
 * AND produce partial stdout, and the caller must see both facts.
 *
 * Quiescence rule (same doc): teardown awaits child exit after kill; we never
 * resolve "killed" before the OS agrees.
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** Raw flux `run-md --json` payload (see flux-runtime src/flux/cli.py _cmd_run_md). */
export interface FluxJsonResult {
  success: boolean
  result?: unknown
  cycles?: number
  halted?: boolean
  registers?: Record<string, number>
  error?: string
  bytecode?: string
  disassembly?: string
}

/** Everything the tool layer needs; no fact folded into another fact's branch. */
export interface FluxRunOutcome {
  /** VM-level success of compile+execute (false on compile error, timeout, cancel). */
  ok: boolean
  /** Cycles executed (0 when the script never ran). */
  cycles: number
  /** Final R0 value, null when unavailable. */
  result: unknown
  /** Whether the VM halted normally. */
  halted: boolean
  /** Final register map, null when unavailable. */
  registers: Record<string, number> | null
  /** Human-readable failure reason; null iff ok. */
  error: string | null
  /** True iff our timeout fired (independent of exit code / VM success). */
  timedOut: boolean
  /** True iff the caller's AbortSignal fired (independent of timeout). */
  aborted: boolean
  /** Child exit code; null when killed by a signal or never exited cleanly. */
  exitCode: number | null
  /** Signal name if the child died by signal; null otherwise. */
  killedBySignal: string | null
  /** Raw stdout (the JSON line stream / error text) for the terminal card. */
  stdout: string
  /** Raw stderr for diagnostics. */
  stderr: string
  /** Wall-clock duration of the attempt. */
  durationMs: number
}

export interface FluxRunOptions {
  /** FLUX CLI to invoke. Default `flux` (pip `flux-vm`). */
  fluxBin?: string
  /** Extra PYTHONPATH for a source checkout, when needed. */
  pythonPath?: string
  /** Hard wall-clock timeout in ms. Default 10_000. */
  timeoutMs?: number
  /** Caller cancellation (the tool's `exec.signal`). Honored at every stage. */
  signal?: AbortSignal
  /** Passed through as `--cycles` when set. */
  maxCycles?: number
  /** Observe each spawned child (for the plugin's quiescent-dispose tracking). */
  onSpawn?: (child: ChildProcess) => void
}

/** Kill a child AND its process group (SIGTERM then SIGKILL escalation). */
export function killTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    child.kill('SIGTERM')
    return
  }
  // detached:true puts the child in its own group; -pid signals the whole tree,
  // so an `sh -c "sleep 30"` orphan cannot outlive its parent and hold our pipes.
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
}

/**
 * Drop credential-shaped env vars before handing the environment to a spawned
 * process (DSH defensive pattern: never hand untrusted output the ambient
 * environment). FLUX itself needs PATH and (optionally) PYTHONPATH only.
 */
export function scrubEnv(env: NodeJS.ProcessEnv, pythonPath?: string): NodeJS.ProcessEnv {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) continue
    clean[key] = value
  }
  if (pythonPath) {
    // Prefix, so a checkout wins over an installed flux-vm.
    clean.PYTHONPATH = pythonPath + (env.PYTHONPATH ? ':' + env.PYTHONPATH : '')
  }
  return clean
}

function parseFluxJson(stdout: string): FluxJsonResult | null {
  // `flux run-md --json` prints one JSON document; be tolerant of leading noise.
  const start = stdout.indexOf('{')
  if (start < 0) return null
  const end = stdout.lastIndexOf('}')
  if (end <= start) return null
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as FluxJsonResult
  } catch {
    return null
  }
}

/** Run one markdown polyglot script through FLUX. Never throws — outcomes carry errors. */
export function runFluxMarkdown(file: string, opts: FluxRunOptions = {}): Promise<FluxRunOutcome> {
  const fluxBin = opts.fluxBin ?? 'flux'
  const timeoutMs = opts.timeoutMs ?? 10_000
  const started = Date.now()

  const argv = [fluxBin, 'run-md', file, '--json']
  if (opts.maxCycles !== undefined) argv.push('--cycles', String(Math.trunc(opts.maxCycles)))

  return new Promise<FluxRunOutcome>((resolve) => {
    if (opts.signal?.aborted) {
      resolve({
        ok: false, cycles: 0, result: null, halted: false, registers: null,
        error: 'aborted before start', timedOut: false, aborted: true,
        exitCode: null, killedBySignal: null, stdout: '', stderr: '',
        durationMs: Date.now() - started,
      })
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        env: scrubEnv(process.env, opts.pythonPath),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // own process group → killTree can reap the whole tree
      })
    } catch (err) {
      resolve({
        ok: false, cycles: 0, result: null, halted: false, registers: null,
        error: `failed to spawn ${fluxBin}: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: false, aborted: false, exitCode: null, killedBySignal: null,
        stdout: '', stderr: '', durationMs: Date.now() - started,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let spawnError: string | null = null

    opts.onSpawn?.(child)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)

      const parsed = parseFluxJson(stdout)
      const bySignal = child.signalCode
      let error: string | null = null
      if (spawnError !== null) error = spawnError
      else if (timedOut) error = `flux exceeded ${timeoutMs}ms wall clock and was killed`
      else if (aborted) error = 'aborted by caller signal'
      else if (parsed === null) error = stderr.trim() || 'flux produced no parseable JSON result'
      else if (!parsed.success) error = parsed.error ?? 'flux reported failure'

      resolve({
        ok: !timedOut && !aborted && parsed !== null && parsed.success === true,
        cycles: parsed?.cycles ?? 0,
        result: parsed?.result ?? null,
        halted: parsed?.halted ?? false,
        registers: parsed?.registers ?? null,
        error,
        timedOut,
        aborted,
        exitCode: child.exitCode,
        killedBySignal: bySignal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // Escalate; then resolve regardless so we never hang the pipeline.
      setTimeout(() => { if (!settled) killTreeWith('SIGKILL') }, 2_000)
    }, timeoutMs)

    function killTreeWith(sig: NodeJS.Signals) {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, sig) } catch { child.kill(sig) }
      } else {
        child.kill(sig)
      }
    }

    function onAbort() {
      if (settled) return
      aborted = true
      killTree(child)
      setTimeout(() => { if (!settled) killTreeWith('SIGKILL') }, 2_000)
    }

    // Quiescence: we resolve on the child's OWN exit/close, not on kill issue.
    child.on('error', (err) => { spawnError = `failed to spawn ${fluxBin}: ${err.message}`; finish() })
    child.on('close', finish)
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

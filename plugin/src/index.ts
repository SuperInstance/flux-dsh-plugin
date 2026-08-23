/**
 * flux-dsh-plugin — mount FLUX (SuperInstance polyglot runtime) as ONE
 * DeepSeek Harness plugin.
 *
 * Embassy, not a migration: this plugin exposes exactly one capability —
 * polyglot script execution (`flux run-md`) — through DSH's tool contract
 * and Cordis lifecycle. Nothing is moved out of SuperInstance; the FLUX
 * runtime stays wherever it lives and is driven as a subprocess.
 *
 * Contract pinned to DSH `dsh-v0.1.1-rc.2` (commit b150a55):
 *   - docs/cookbook/adding-a-tool.md   (defineTool shape, purity rules)
 *   - docs/cordis-primer.md            (Service shape, reversible effects)
 *   - docs/defensive-patterns.md       (orthogonal outcomes, quiescent dispose,
 *                                      scrubbed env)
 *
 * @module flux-dsh-plugin
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runFluxMarkdown, killTree } from './flux-bridge.ts'

/** Plugin-level config (from the cordis.yml row's `config`). */
export interface Config {
  /** FLUX CLI (default `flux` on PATH). */
  fluxBin?: string
  /** PYTHONPATH when driving a flux-runtime source checkout instead of pip flux-vm. */
  pythonPath?: string
  /** Default per-call wall clock (default 10_000ms). Calls may lower it, not raise it. */
  defaultTimeoutMs?: number
  /** Keep scratch files for debugging (default false: cleaned on dispose). */
  keepScratch?: boolean
}

export const name = 'flux-exec'
export const inject = ['tools']

/** In-flight FLUX children, so plugin dispose can reach quiescence. */
const inFlight = new Set<ChildProcess>()
/** Test/bridge seam: expose the set for lifecycle assertions. */
export const __inFlightForTests = inFlight

/** Hand-checked cross-field rule the schema DSL cannot express: source XOR path. */
export function validateFluxExecArgs(
  args: { source?: unknown; path?: unknown; timeoutMs?: unknown; maxCycles?: unknown },
): string[] {
  const violations: string[] = []
  const hasSource = typeof args.source === 'string' && args.source.length > 0
  const hasPath = typeof args.path === 'string' && args.path.length > 0
  if (hasSource === hasPath) {
    violations.push('exactly one of `source` (inline markdown) or `path` (file) is required')
  }
  const t = args.timeoutMs
  if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t) || t <= 0)) {
    violations.push('timeoutMs must be a positive number')
  }
  const c = args.maxCycles
  if (c !== undefined && (typeof c !== 'number' || !Number.isFinite(c) || c <= 0)) {
    violations.push('maxCycles must be a positive number')
  }
  return violations
}

export function apply(ctx: Context, config: Partial<Config> = {}) {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 10_000

  // Plugin-scoped scratch dir for inline sources, created LAZILY on first
  // inline execution. Registered as a reversible effect: when this plugin's
  // fiber is disposed (unload/hot-reload), the dir goes away. This is Cordis
  // revertible-effects in practice — see docs/SEAM-REPORT.md for what that
  // does and does NOT revert.
  let scratchDirPromise: Promise<string> | null = null
  const getScratch = () => (scratchDirPromise ??= mkdtemp(join(tmpdir(), 'flux-dsh-')))

  ctx.effect(() => {
    // Disposer — unwinds every registration made below plus plugin-owned state.
    return () => {
      // Quiescence first: kill children and wait for their exit before rm.
      for (const child of inFlight) {
        killTree(child)
      }
      const drained = Promise.allSettled(
        [...inFlight].map(c => new Promise<void>(res => { c.once('close', () => res()); c.once('error', () => res()) })),
      )
      void drained.then(async () => {
        inFlight.clear()
        if (!config.keepScratch && scratchDirPromise) {
          const dir = await scratchDirPromise.catch(() => null)
          if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
        }
      })
    }
  })

  ctx.tools.register(defineTool({
    name: 'flux_exec',
    description:
      'Execute a polyglot script through FLUX (markdown with mixed-language code blocks '
      + 'compiled to one deterministic bytecode and run on a 64-register VM). '
      + 'Provide `source` (inline markdown, same format as a .md file) XOR `path` '
      + '(path to a .md file). Returns the VM outcome: ok, cycles, the R0 result, '
      + 'final registers, and the raw JSON payload. Use FLUX when reproducible, '
      + 'verifiable execution of mixed-language logic matters; use bash for '
      + 'ambient shell work.',
    parameters: {
      source: {
        type: 'string',
        description: 'Inline polyglot markdown source (mutually exclusive with `path`).',
      },
      path: {
        type: 'string',
        description: 'Path to a .md file to execute (mutually exclusive with `source`).',
      },
      maxCycles: {
        type: 'number',
        description: 'Optional VM cycle cap (default 100000).',
      },
      timeoutMs: {
        type: 'number',
        description: `Optional wall-clock cap in ms (default ${defaultTimeoutMs}, capped at plugin default).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'VM-level success of compile+execute.' },
          cycles: { type: 'number', required: true, description: 'VM cycles executed; 0 if the script never ran.' },
          result: { type: 'json', required: true, description: 'Final R0 value; null when unavailable.' },
          registers: { type: 'json', required: true, description: 'Final register map; null when unavailable.' },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: 'Failure reason; null iff ok.' },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true, description: 'True iff the harness cancelled the call.' },
          durationMs: { type: 'number', required: true },
        },
      } as const,
      render(_args, value) {
        // Pure: function of (args, value) only. No I/O, no clock, no session state.
        const head = value.ok
          ? `flux ok — ${value.cycles} cycles, R0=${JSON.stringify(value.result)} (${value.durationMs}ms)`
          : `flux failed — ${value.error}`
        return [{ type: 'text', text: head }]
      },
      presentationMeta(_args, value) {
        // Replayable card facts (pure JSON derived from the canonical value).
        return { ok: value.ok, cycles: value.cycles, durationMs: value.durationMs }
      },
    },
    isConcurrencySafe() {
      return true // each call compiles to an isolated scratch/bytecode run
    },
    async execute(args, exec) {
      // Cross-field constraints the DSL does not express.
      const violations = validateFluxExecArgs(args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)

      let file: string
      if (args.path !== undefined) {
        file = args.path
      } else {
        const dir = await getScratch()
        file = join(dir, `inline-${randomUUID()}.md`)
        await writeFile(file, args.source!, { encoding: 'utf8', mode: 0o600 })
      }

      const timeoutMs = Math.min(args.timeoutMs ?? defaultTimeoutMs, defaultTimeoutMs)

      // Non-zero exit or VM failure stays a SUCCESSFUL domain outcome (isError
      // false) per the contract; only infrastructure failures throw.
      const outcome = await runFluxMarkdown(file, {
        fluxBin: config.fluxBin,
        pythonPath: config.pythonPath,
        timeoutMs,
        maxCycles: args.maxCycles,
        signal: exec.signal,
        onSpawn(child) {
          inFlight.add(child)
          child.once('close', () => inFlight.delete(child))
          child.once('error', () => inFlight.delete(child))
        },
      })

      return {
        ok: outcome.ok,
        cycles: outcome.cycles,
        result: outcome.result as JsonValue | null,
        registers: outcome.registers,
        error: outcome.error,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        durationMs: outcome.durationMs,
      }
    },
    presentCall(args) {
      // Pure pending-state presenter: generic card (a terminal card implies an
      // ambient shell; FLUX runs in its own VM, so we show the virtual command).
      return {
        card: 'generic',
        title: `flux run-md ${args.path ?? '(inline polyglot markdown)'}`,
        kind: 'execute',
        content: [{ type: 'text', text: 'compiling markdown → bytecode → 64-register VM' }],
      }
    },
    presentResult(args, { isError, meta }) {
      // Soft-validated on replay: tolerate older logged args/meta shapes.
      const m = (meta ?? {}) as { ok?: boolean; cycles?: number; durationMs?: number }
      const title = `flux run-md ${args.path ?? '(inline polyglot markdown)'}`
      if (isError) return { card: 'terminal', title, output: 'error' }
      return {
        card: 'terminal',
        title,
        output: m.ok
          ? `ok — ${m.cycles ?? '?'} cycles (${m.durationMs ?? '?'}ms)`
          : 'failed (see model-facing result)',
      }
    },
  }))
}

// Re-exports for consumers/tests.
export { runFluxMarkdown, scrubEnv, killTree } from './flux-bridge.ts'
export type { FluxRunOutcome, FluxRunOptions, FluxJsonResult } from './flux-bridge.ts'

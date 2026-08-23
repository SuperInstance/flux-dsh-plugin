/**
 * Minimal Cordis-context harness: enough of `ctx.tools` + `ctx.effect` to
 * exercise the plugin's registration and REVERSIBLE-EFFECT lifecycle without
 * booting a whole DSH runtime. This is the embassy's honest scope: we test
 * OUR side of the contract; DSH's side is covered by their own suite.
 */
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export interface MockContext {
  tools: {
    registered: Map<string, ToolDefinition>
    register(def: ToolDefinition): void
    /** Simulate plugin unload: what Cordis does when the fiber is disposed. */
    disposeAll(): void
  }
  effects: Array<() => void | Promise<void>>
  effect(fn: () => void | (() => void | Promise<void> | undefined)): void
  /** Run all disposers (plugin unload). */
  dispose(): Promise<void>
}

export function createMockContext(): MockContext {
  const registered = new Map<string, ToolDefinition>()
  const effects: Array<() => void | Promise<void>> = []
  const ctx: MockContext = {
    tools: {
      registered,
      register(def) {
        if (registered.has(def.name)) throw new Error(`duplicate tool: ${def.name}`)
        registered.set(def.name, def)
      },
      disposeAll() {
        registered.clear()
      },
    },
    effects,
    effect(fn: () => void | (() => void | Promise<void> | undefined)) {
      // True Cordis semantics: fn() is the ACTIVATION and returns the disposer.
      const disposer = fn()
      effects.push(() => disposer?.())
    },
    async dispose() {
      // Cordis semantics: disposal unwinds effects (LIFO) and every
      // registration made through them.
      for (const dispose of effects.reverse()) await dispose()
      ctx.tools.disposeAll()
    },
  }
  return ctx
}

/** Cast helper: the mock implements the Cordis Context subset this plugin touches. */
export function asCordis(ctx: MockContext): Parameters<(typeof import('../src/index.ts'))['apply']>[0] {
  return ctx as unknown as Parameters<(typeof import('../src/index.ts'))['apply']>[0]
}

/**
 * Create a `flux` wrapper script that runs the local flux-runtime checkout
 * via `python3 -m flux`, so tests exercise the REAL bridge + REAL FLUX
 * without requiring `pip install flux-vm`.
 */
export async function createFluxWrapper(): Promise<{ bin: string; dir: string }> {
  const dir = await mkdir(join(tmpdir(), `flux-wrap-${Date.now()}-${Math.random().toString(36).slice(2)}`), { recursive: true })
  const bin = join(dir!, 'flux')
  const src = process.env.FLUX_RUNTIME_SRC ?? '/home/eileen/projects/flux-runtime/src'
  await writeFile(
    bin,
    `#!/bin/sh\nexport PYTHONPATH="${src}:$PYTHONPATH"\nexec python3 -m flux "$@"\n`,
    { mode: 0o700 },
  )
  await chmod(bin, 0o700)
  return { bin, dir: dir! }
}

/** Build a minimal exec context (what the registry hands to execute()). */
export function execContext(overrides: Partial<{ signal: AbortSignal; token: string; callId: string }> = {}) {
  return {
    signal: new AbortController().signal,
    token: 'test-token',
    callId: 'call-test',
    deferContext: () => {},
    concludeTurn: () => {},
    ...overrides,
  }
}

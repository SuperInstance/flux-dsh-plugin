import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { runFluxMarkdown, scrubEnv } from '../src/flux-bridge.ts'
import { createMockContext, createFluxWrapper, execContext, asCordis, type MockContext } from './harness.ts'

let fluxBin: string
let wrapDir: string

beforeAll(async () => {
  const w = await createFluxWrapper()
  fluxBin = w.bin
  wrapDir = w.dir
})

afterAll(async () => {
  await rm(wrapDir, { recursive: true, force: true }).catch(() => {})
})

describe('plugin lifecycle (Cordis revertible effects)', () => {
  it('registers exactly one flux_exec tool through ctx.tools', () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    expect([...ctx.tools.registered.keys()]).toEqual(['flux_exec'])
    expect(ctx.effects.length).toBeGreaterThan(0)
  })

  it('disposing the plugin unregisters the tool (registration is an effect)', async () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    expect(ctx.tools.registered.size).toBe(1)
    await ctx.dispose()
    expect(ctx.tools.registered.size).toBe(0)
  })

  it('plugin unload removes the scratch dir (quiescent cleanup)', async () => {
    const { readdir } = await import('node:fs/promises')
    const before = new Set((await readdir(tmpdir())).filter(e => e.startsWith('flux-dsh-')))

    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    const tool = ctx.tools.registered.get('flux_exec')!

    // Run one inline execution to force lazy scratch creation.
    const res = await tool.execute(
      { source: 'factorial of 5' } as never,
      execContext() as never,
    )
    expect((res as { ok: boolean }).ok).toBe(true)

    await ctx.dispose()
    // Disposer is async (awaits child quiescence); poll briefly for rm.
    await new Promise(r => setTimeout(r, 250))
    const after = (await readdir(tmpdir())).filter(e => e.startsWith('flux-dsh-'))
    const newLeftovers = after.filter(e => !before.has(e))
    expect(newLeftovers).toEqual([])
  })

  it('lazy scratch: apply() alone allocates nothing until first inline exec', async () => {
    const { readdir } = await import('node:fs/promises')
    const before = new Set((await readdir(tmpdir())).filter(e => e.startsWith('flux-dsh-')))
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    await new Promise(r => setTimeout(r, 50))
    const after = (await readdir(tmpdir())).filter(e => e.startsWith('flux-dsh-'))
    expect(after.filter(e => !before.has(e))).toEqual([])
    await ctx.dispose()
  })
})

describe('flux_exec end-to-end through the real bridge + real FLUX', () => {
  it('runs an inline FLUX-ese script and returns the canonical value', async () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    const tool = ctx.tools.registered.get('flux_exec')!
    const value = (await tool.execute(
      { source: 'factorial of 5' } as never,
      execContext() as never,
    )) as {
      ok: boolean; cycles: number; result: unknown; error: string | null
      timedOut: boolean; aborted: boolean; durationMs: number; registers: unknown
    }

    expect(value.ok).toBe(true)
    expect(value.result).toBe(120)
    expect(value.cycles).toBeGreaterThan(0)
    expect(value.error).toBeNull()
    expect(value.timedOut).toBe(false)
    expect(value.aborted).toBe(false)
    expect(value.durationMs).toBeGreaterThan(0)
    expect(value.registers).toBeTruthy()
  })

  it('runs a path-based script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flux-path-'))
    const file = join(dir, 'fib.md')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'sum 1 to 100\n', 'utf8')

    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    const tool = ctx.tools.registered.get('flux_exec')!
    const value = (await tool.execute(
      { path: file } as never,
      execContext() as never,
    )) as { ok: boolean; result: unknown }
    expect(value.ok).toBe(true)
    expect(value.result).toBe(5050)
    await rm(dir, { recursive: true, force: true })
  })

  it('VM failure is a successful domain outcome with error set (not isError)', async () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    const tool = ctx.tools.registered.get('flux_exec')!
    // `movi r999, 5` is a REAL parse failure (register out of range);
    // note: arbitrary garbage parses as a no-op success upstream — see
    // docs/SEAM-REPORT.md “honest friction”.
    const value = (await tool.execute(
      { source: 'movi r999, 5' } as never,
      execContext() as never,
    )) as { ok: boolean; error: string | null }
    expect(value.ok).toBe(false)
    expect(value.error).toBeTruthy()
  })

  it('execute throws only on invalid args (infrastructure-class failure)', async () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    const tool = ctx.tools.registered.get('flux_exec')!
    await expect(
      tool.execute({} as never, execContext() as never),
    ).rejects.toThrow(/exactly one/)
    await expect(
      tool.execute({ source: 'x', path: 'y' } as never, execContext() as never),
    ).rejects.toThrow(/exactly one/)
  })

  it('timeout is reported orthogonally (timedOut flag, independent of exit code)', async () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin, defaultTimeoutMs: 300 })
    const tool = ctx.tools.registered.get('flux_exec')!
    // 1ms budget: guaranteed to fire while the Python interpreter is still starting.
    const value = (await tool.execute(
      { source: 'factorial of 5', timeoutMs: 1 } as never,
      execContext() as never,
    )) as { ok: boolean; timedOut: boolean; error: string | null }
    expect(value.timedOut).toBe(true)
    expect(value.ok).toBe(false)
    expect(value.error).toMatch(/wall clock/)
  }, 20_000)

  it('harness cancellation (exec.signal) aborts and reports aborted=true', async () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin, defaultTimeoutMs: 30_000 })
    const tool = ctx.tools.registered.get('flux_exec')!
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const value = (await tool.execute(
      { source: 'factorial of 5' } as never,
      execContext({ signal: ac.signal }) as never,
    )) as { aborted: boolean; ok: boolean }
    expect(value.aborted).toBe(true)
    expect(value.ok).toBe(false)
  }, 20_000)
})

describe('pure presentation contracts', () => {
  it('presentCall is pure: same args → same view, terminal/generic card shape', () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    const tool = ctx.tools.registered.get('flux_exec')!
    // Reach through the defineTool wrapper's raw options for direct purity test.
    const raw = (tool as unknown as { definition?: unknown }).definition
    void raw // wrapper-managed; call through the public surface instead:
    const a = tool.presentCall?.({ source: 'factorial of 5' } as never)
    const b = tool.presentCall?.({ source: 'factorial of 5' } as never)
    expect(a).toEqual(b)
    expect((a as { card: string }).card).toBe('generic')
  })

  it('presentResult tolerates missing/legacy meta (soft validation, never throws)', () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    const tool = ctx.tools.registered.get('flux_exec')!
    const view = tool.presentResult?.({ source: 'x' } as never, {
      content: [{ type: 'text', text: 'flux ok' }],
      isError: false,
    })
    expect((view as { card: string }).card).toBe('terminal')
    const errView = tool.presentResult?.({} as never, {
      content: [],
      isError: true,
    })
    expect((errView as { card: string }).card).toBe('terminal')
  })

  it('render is a pure function of (args, value)', () => {
    const ctx = createMockContext()
    apply(asCordis(ctx), { fluxBin })
    const tool = ctx.tools.registered.get('flux_exec')!
    const value = {
      ok: true, cycles: 19, result: 120, registers: null, error: null,
      timedOut: false, aborted: false, durationMs: 42,
    }
    const blocks = tool.output.render({ source: 'factorial of 5' } as never, value as never)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect((blocks[0] as { text: string }).text).toContain('ok')
    expect((blocks[0] as { text: string }).text).toContain('19 cycles')
  })
})

describe('flux-bridge unit behavior', () => {
  it('scrubEnv drops credential-shaped vars and preserves the rest', () => {
    const env = scrubEnv(
      { PATH: '/bin', HOME: '/home/x', API_KEY: 'k', GITHUB_TOKEN: 't', MY_PASSWORD: 'p', FLUX_OK: '1' },
      '/extra/path',
    )
    expect(env.PATH).toBe('/bin')
    expect(env.FLUX_OK).toBe('1')
    expect(env.PYTHONPATH).toBe('/extra/path')
    expect(Object.keys(env).filter(k => /KEY|SECRET|TOKEN|PASSWORD/i.test(k))).toEqual([])
  })

  it('pre-aborted signal resolves without spawning', async () => {
    const ac = new AbortController()
    ac.abort()
    const out = await runFluxMarkdown('/nonexistent.md', { fluxBin, signal: ac.signal })
    expect(out.aborted).toBe(true)
    expect(out.ok).toBe(false)
    expect(out.cycles).toBe(0)
  })

  it('missing flux binary reports spawn failure without throwing', async () => {
    const out = await runFluxMarkdown('/tmp/whatever.md', {
      fluxBin: '/nonexistent/flux-binary',
      timeoutMs: 2_000,
    })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/spawn|ENOENT/i)
    expect(out.timedOut).toBe(false)
  })

  it('SIGTERM-killed child resolves quiescently (after process exit, not kill issue)', async () => {
    // A sleeping stub child isolates bridge kill/quiescence from FLUX behavior.
    const sleepDir = await mkdtemp(join(tmpdir(), 'flux-sleep-'))
    const sleepBin = join(sleepDir, 'flux')
    const { writeFile, chmod } = await import('node:fs/promises')
    await writeFile(sleepBin, '#!/bin/sh\nsleep 30\n', { mode: 0o700 })
    await chmod(sleepBin, 0o700)
    const t0 = Date.now()
    const out = await runFluxMarkdown('/tmp/any.md', {
      fluxBin: sleepBin,
      timeoutMs: 150,
    })
    // Resolved only after real exit: close-event quiescence, bounded escalation window.
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(out.timedOut).toBe(true)
    expect(out.exitCode).not.toBe(0)
    await rm(sleepDir, { recursive: true, force: true })
  }, 15_000)
})

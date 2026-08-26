/**
 * cellular tests — the prototype's proof. Three tiers:
 *
 *   1. unit: ledger sealing/replay/tamper, fascia math, transduction, error classes
 *   2. e2e (REAL flux runtime, python3 subprocess lane): perception → compile
 *      → run, mint tables, cache hits on the second call
 *   3. heal/germ lane: broken source, germ patch (test seam), mint, table serve
 *
 * The e2e tests use the same flux-runtime checkout as the embassy harness
 * (FLUX_RUNTIME_SRC, default /home/eileen/projects/flux-runtime/src).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CellLedger, canonicalJson, meanL1Distance } from '../src/quilt-ledger.ts'
import { cohesion_at_boundary, annotate, tissue_deadband } from '../src/fascia.ts'
import { transduce, errorClass, driveCellularFlux, type CellularOutcome } from '../src/driver.ts'
import { FluxOrganism, type ModelCall, type SheetModel } from '../src/organism.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME_SRC = process.env.FLUX_RUNTIME_SRC ?? '/home/eileen/projects/flux-runtime/src'

let fluxBin = ''
let scratch = ''

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'flux-cells-test-'))
  // wrapper bin: same pattern as the embassy test harness (plugin/test/harness.ts)
  fluxBin = join(scratch, 'flux')
  await writeFile(fluxBin, `#!/bin/sh\nexport PYTHONPATH="${RUNTIME_SRC}:$PYTHONPATH"\nexec python3 -m flux "$@"\n`)
  await chmod(fluxBin, 0o755)
  return () => rm(scratch, { recursive: true, force: true })
})

// ── 1. unit: the quilt ledger ───────────────────────────────────────────────

describe('CellLedger (mini-port of quilt-rust cell-ledger.md)', () => {
  it('seals a hash chain that verifies', () => {
    const led = new CellLedger('t', [0])
    led.record_with({ kind: 'step' }, [1], 1000, { origin: 'local', trace: [] })
    led.record_with({ kind: 'step' }, [2], 2000, { origin: 'local', trace: [] })
    const v = led.verify_chain()
    expect(v.intact).toBe(true)
    expect(led.entries.length).toBe(2)
  })

  it('tamper breaks the chain at the tampered entry (seal-first)', () => {
    const led = new CellLedger('t', [0])
    led.record_with({ kind: 'step' }, [1], 1000, { origin: 'local', trace: [] })
    led.record_with({ kind: 'step' }, [2], 2000, { origin: 'local', trace: [] })
    const robj = led as unknown as { chain: Array<{ delta: { after: unknown } }> }
    robj.chain[1]!.delta.after = [999]
    const v = led.verify_chain()
    expect(v.intact).toBe(false)
    expect(v.broken_at).toBe(1)
  })

  it('replay reconstructs state at any past cut (no time leakage)', () => {
    const led = new CellLedger('t', [0])
    led.record_with('a', [1], 1000, { origin: 'local', trace: [] })
    led.record_with('b', [2], 2000, { origin: 'local', trace: [] })
    led.record_with('c', [3], 3000, { origin: 'local', trace: [] })
    expect(led.replay(1500).state).toEqual([1])
    expect(led.replay(9999).state).toEqual([3])
    expect(led.replay(1500).entries).toBe(1)
  })

  it('persistence prior: expected=before sealed into the hash; imbalance == magnitude', () => {
    const led = new CellLedger('t', [0])
    const e = led.record_with('x', [5], 1000, { origin: 'local', trace: [] })
    expect(e.expected).toEqual([0])
    expect(e.imbalance).toBe(5)
  })

  it('caller-supplied forecast is sealed — the surprise is falsifiable', () => {
    const led = new CellLedger('t', [0])
    const e = led.record_with('x', [5], 1000, { origin: 'local', trace: [] }, [5])
    expect(e.expected).toEqual([5])
    expect(e.imbalance).toBe(0)
  })

  it('meanL1Distance: honest null across incomparable shapes', () => {
    expect(meanL1Distance([1, 2], [3, 4])).toBe(2)
    expect(meanL1Distance([1], [1, 2])).toBe(null)
    expect(meanL1Distance('a', 'b')).toBe(1)
  })

  it('canonicalJson is key-order independent (hash stability)', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })
})

// ── 1b. unit: the fascia reader ────────────────────────────────────────────

describe('fascia (cohesion-and-fascia.md vocabulary)', () => {
  const mkLed = (id: string, edges: number[][]) => {
    const led = new CellLedger(id, [0, 0])
    let t = 100
    for (const e of edges) led.record_with('s', e, (t += 60), { origin: 'local', trace: [] })
    return led
  }

  it('cohesion: a school of cells moving together → high COH, tiny residuals', () => {
    const ledgers = new Map<string, CellLedger>([
      ['a', mkLed('a', [[0, 0], [4, 4]])],
      ['b', mkLed('b', [[0, 0], [5, 5]])],
      ['c', mkLed('c', [[0, 0], [4, 5]])],
    ])
    const read = cohesion_at_boundary(ledgers, { b: 150, w: 200 }, 3)
    expect(read).not.toBeNull()
    expect(read!.roster).toContain('a')
    expect(read!.coh).toBeGreaterThan(1)      // collective translation dominates
    for (const r of Object.values(read!.residuals)) {
      for (const v of r) expect(Math.abs(v)).toBeLessThan(1)
    }
  })

  it('a defector cell lands in the residuals, not the common shift', () => {
    const ledgers = new Map<string, CellLedger>([
      ['a', mkLed('a', [[0, 0], [10, 10]])],
      ['b', mkLed('b', [[0, 0], [10, 10]])],
      ['odd', mkLed('odd', [[0, 0], [-10, -10]])],
    ])
    const read = cohesion_at_boundary(ledgers, { b: 150, w: 200 }, 5)
    const odd = read!.residuals['odd']!
    expect(Math.hypot(...odd)).toBeGreaterThan(10)
  })

  it('REG-1: annotate flags tissue-aligned axes as composition-suspect', () => {
    const axis = [1, 0]
    const annTissue = annotate(axis, [1, 0], [0, 1])   // aligned to tissue beam
    const annFiber = annotate(axis, [0, 1], [1, 0])    // aligned to fiber
    expect(annTissue.verdict).toBe('composition-suspect')
    expect(annFiber.verdict).toBe('tissue-like')
  })

  it('λ* deadband: 0.27·corpus_sd', () => {
    expect(tissue_deadband(10)).toBeCloseTo(2.7)
  })
})

// ── 1c. unit: transduction + error classes ─────────────────────────────────

describe('driver transduction (the membrane owns no judgment)', () => {
  it('xor + emptiness rules', () => {
    expect(transduce({ source: 'x' }).shape).toBe('inline')
    expect(transduce({ path: '/tmp/x' }).shape).toBe('path')
    expect(transduce({}).shape).toBe('invalid:xor')
    expect(transduce({ source: 'x', path: 'y' }).shape).toBe('invalid:xor')
    expect(transduce({ source: '  ' }).shape).toBe('invalid:empty')
  })

  it('errorClass normalizes digits/registers/strings — the semantic key', () => {
    // digits, register indices and quoted strings collapse; opcode WORDS stay
    expect(errorClass('Unknown opcode in assembly: FOO at r7 with 42'))
      .toBe(errorClass('Unknown opcode in assembly: FOO at r0 with 7'))
    expect(errorClass('Unknown opcode in assembly: FOO with 42'))
      .not.toBe(errorClass('Register index out of range: 99'))
  })
})

// ── 2. e2e: the real runtime, the real seam ────────────────────────────────

function realOrg(llmOverride?: (cfg: SheetModel, req: { system: string; user: string }) => Promise<ModelCall>) {
  return new FluxOrganism(
    { scratchDir: scratch, fluxBin, deepseekKey: undefined },
    { fluxRuntimeSrc: RUNTIME_SRC, timeoutMs: 15_000 },
    llmOverride,
  )
}

describe('e2e: FLUX granularized (REAL flux runtime subprocesses)', () => {
  it('perception → compile → run, all five cells, ledgers seal', async () => {
    const org = realOrg()
    const out = await driveCellularFlux(org, {
      source: '```flux\nMOVI r0, 6\nMOVI r1, 7\nIMUL r0, r0, r1\n```\n',
    })
    expect(out.ok).toBe(true)
    expect(out.result).toBe(42)
    expect(out.cycles).toBeGreaterThan(0)
    expect(out.serve.perceive).toBe('table')
    expect(out.serve.compile).toBe('model')          // miss → the flux-vm seam
    expect(out.serve.run).toBe('model')
    // minted: compile (source_hash) + run (bytecode_hash)
    expect(out.mints.length).toBe(2)
    // both mints are evidence-cited canons
    expect(org.canonJson('flux.compile')).toContain('source_hash')
    expect(org.canonJson('flux.run')).toContain('bytecode_hash')
    // every ledger in the roster seals intact
    for (const led of org.ledgers.values()) {
      expect(led.verify_chain().intact).toBe(true)
    }
    // the seam-split proof: both provider lanes were exercised
    expect(org.seamCalls['flux-vm']).toBeGreaterThanOrEqual(2)
    expect(org.seamCalls.llm).toBe(0)
    // fascia read came back with the roster
    expect(out.fascia).not.toBeNull()
    expect(out.fascia!.roster.length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('second identical call serves from minted tables (organism learned its determinism)', async () => {
    const org = realOrg()
    const src = '```flux\nMOVI r0, 21\nIADD r0, r0, r0\n```\n'
    const first = await driveCellularFlux(org, { source: src })
    expect(first.ok).toBe(true)
    expect(first.result).toBe(42)
    expect(first.serve.compile).toBe('model')
    const second = await driveCellularFlux(org, { source: src })
    expect(second.ok).toBe(true)
    expect(second.result).toBe(42)
    expect(second.serve.compile).toBe('table')       // source_hash tendency served
    expect(second.serve.run).toBe('table')           // bytecode_hash tendency served
    expect(org.seamCalls['flux-vm']).toBe(2)         // exactly the two first-call misses
    // the run ledger's sealed forecast: identical bytecode → imbalance ~0
    const runLed = org.ledgers.get('flux.run')!
    const last = runLed.entries[runLed.entries.length - 1]!
    expect(last.expected).toEqual(last.delta.after)
    expect(last.imbalance).toBe(0)
    // health snapshot is coherent
    const h = org.health()
    expect(h.organism).toBe('flux')
    expect(h.cells_total).toBe(5)
  }, 60_000)

  it('garbage source is rejected honestly (perception or compile, no fake ok)', async () => {
    const org = realOrg()
    const out = await driveCellularFlux(org, { source: 'definitely not flux {{{' })
    expect(out.ok).toBe(false)
    expect(out.error).toBeTruthy()
  }, 60_000)

  it('invalid args never touch the runtime', async () => {
    const org = realOrg()
    const out = await driveCellularFlux(org, { source: 'a', path: 'b' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/exactly one/)
    expect(org.seamCalls['flux-vm']).toBe(0)
  })
})

// ── 3. heal ⇄ germ lane (test seam for the LLM; escalation path is real) ──

describe('heal cell + germ escalation (the immune lineage)', () => {
  const germPatch = (find: string, replace: string) =>
    async (): Promise<ModelCall> => ({
      ok: true,
      content: JSON.stringify({ patch: { find, replace }, generalizes: true, note: 'test germ' }),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      latency_ms: 1,
      cost_estimate_usd: 0,
      log: {
        provider: 'test-seam', model: 'germ', system_prompt: '(test)',
        prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
        latency_ms: 1, cost_estimate_usd: 0, base_url: 'test://',
      },
    })

  it('broken opcode → germ patch → compile ok → patch minted by error class', async () => {
    // FOO is not an opcode: the parser raises, heal misses, the germ answers
    const org = realOrg(germPatch('FOOBAR', 'MOVI'))
    const broken = '```flux\nFOOBAR r0, 40\nIADD r0, r0, r0\n```\n'
    const out = await driveCellularFlux(org, { source: broken })
    expect(out.ok).toBe(true)
    expect(out.result).toBe(80)
    expect(out.repairs).toBe(1)
    expect(out.serve.heal).toContain('escalated')
    // the germ-certified general patch is now a canon rule keyed by error class
    const canon = JSON.parse(org.canonJson('flux.heal')) as { rules: Array<{ when: { payload_equals: Record<string, string> } }> }
    expect(canon.rules.length).toBe(1)
    expect(Object.keys(canon.rules[0]!.when.payload_equals)[0]).toBe('error_class')
  }, 60_000)

  it('a DIFFERENT broken source in the same error class serves from the heal TABLE (no germ)', async () => {
    const org = realOrg(germPatch('NOPE', 'MOVI'))
    // prime the heal table with error_class "Unknown opcode ... MOVI"
    const first = await driveCellularFlux(org, { source: '```flux\nNOPE r0, 10\n```\n' })
    expect(first.ok).toBe(true)
    expect(first.serve.heal).toContain('escalated')
    const llmCallsBefore = org.seamCalls.llm

    // same class, different source body: table must serve
    const second = await driveCellularFlux(org, { source: '```flux\nNOPE r0, 6\nIADD r0, r0, r0\n```\n' })
    expect(second.ok).toBe(true)
    expect(second.result).toBe(12)
    expect(second.serve.heal).toBe('table')
    expect(org.seamCalls.llm).toBe(llmCallsBefore)   // zero germ calls this round
  }, 60_000)
})

// ── 4. cross-run distillation (canon reload) ──────────────────────────────

describe('canon persistence (cross-run distillation)', () => {
  it('a minted canon reloads into a fresh organism at genesis', async () => {
    const org1 = realOrg()
    await driveCellularFlux(org1, { source: '```flux\nMOVI r0, 5\n```\n' })
    const compileCanon = JSON.parse(org1.canonJson('flux.compile'))

    const org2 = new FluxOrganism({ scratchDir: scratch, fluxBin }, { fluxRuntimeSrc: RUNTIME_SRC })
    org2.loadCanon('flux.compile', compileCanon)
    const out = await driveCellularFlux(org2, { source: '```flux\nMOVI r0, 5\n```\n' })
    expect(out.ok).toBe(true)
    expect(out.result).toBe(5)
    expect(out.serve.compile).toBe('table')
  }, 60_000)
})

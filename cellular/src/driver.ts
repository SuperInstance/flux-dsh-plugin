/**
 * driver — the membrane. ONE tool call enters (the DSH model invoked
 * flux_exec_cellular); the driver transduces it into cell-addressable facts,
 * walks the signal chain perception → cognition → (heal ⇄ germ) → actuation,
 * seals every state edge on the quilt ledgers, and reads the fascia at the
 * call boundary. The driver OWNS no judgment (cell-cascade doctrine): it
 * trusts table verdicts, extracts only notation it can verify, and reports.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FireResult } from '../../../cell-cascade/src/firing.ts'
import { FluxOrganism, hashSource, readBytecodeHash } from './organism.ts'
import { cohesion_at_boundary, annotate, type CohesionRead, type FasciaAnnotation } from './fascia.ts'

export interface CellularArgs {
  source?: unknown
  path?: unknown
  maxCycles?: unknown
  timeoutMs?: unknown
}

export interface TraceStep {
  signal_id: number
  to: string
  kind: string
  mode: string
  ok: boolean
  latency_ms: number
  cost_per_call: number
  answered_by?: string | null
  note?: string
}

export interface FasciaRead {
  coh: number
  q: number | null
  roster: string[]
  dropped: string[]
  c_hat: number[]
  annotation: FasciaAnnotation
  corpus_sd: number
}

export interface CellularOutcome {
  ok: boolean
  cycles: number
  result: unknown
  registers: null
  error: string | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
  /** the organism's account of itself */
  trace: TraceStep[]
  serve: { perceive: string; compile: string; heal: string; run: string }
  mints: string[]
  repairs: number
  fascia: FasciaRead | null
}

const MAX_REPAIRS = 2

/** Sensory transduction: raw model args → cell-addressable facts.
 *  (The sense organ's job is transduction; the RULE TABLE is the perception.) */
export function transduce(args: CellularArgs): { shape: string; source: string | null; reason?: string } {
  const hasSource = typeof args.source === 'string' && args.source.length > 0
  const hasPath = typeof args.path === 'string' && args.path.length > 0
  if (hasSource && hasPath) return { shape: 'invalid:xor', source: null, reason: 'exactly one of source or path is required' }
  if (!hasSource && !hasPath) return { shape: 'invalid:xor', source: null, reason: 'exactly one of source or path is required' }
  if (hasSource) {
    const src = args.source as string
    if (!src.trim()) return { shape: 'invalid:empty', source: null, reason: 'source must be non-empty markdown' }
    return { shape: 'inline', source: src }
  }
  return { shape: 'path', source: null }
}

/** Reduce a flux compile error to a semantic error class (the heal table's
 *  key: generalizes across distinct sources — digits and paths stripped). */
export function errorClass(error: string): string {
  const first = error.trim().split('\n')[0] ?? 'unknown'
  return first
    .replace(/r\d+/gi, 'rN').replace(/-?\d+/g, 'N')
    .replace(/"[^"]*"/g, '"S"').replace(/\/[^\s:]*\//g, 'PATH')
    .replace(/\s+/g, ' ').trim().slice(0, 120) || 'unknown'
}

interface ParsedSeam {
  ok: boolean
  [k: string]: unknown
}

function parseSeamContent(fr: FireResult): ParsedSeam | null {
  const answer = (fr.response as { answer?: unknown }).answer
  if (typeof answer !== 'string') return null
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(answer.slice(start, end + 1)) as ParsedSeam } catch { return null }
}

interface GermPatch {
  patch?: { find?: unknown; replace?: unknown }
  generalizes?: unknown
  note?: unknown
  repaired_source?: unknown
}

function parseGerm(fr: FireResult): GermPatch | null {
  // table serves carry the minted rule's respond object DIRECTLY
  // ({patch, from_germ}); model/escalated serves carry it inside an
  // `answer` JSON string — one extractor for both lanes.
  const direct = fr.response as { patch?: { find?: unknown; replace?: unknown } }
  if (fr.mode === 'table' && direct?.patch) return direct as GermPatch
  const p = parseSeamContent(fr)
  if (p) return p as GermPatch
  const answer = (fr.response as { answer?: unknown }).answer
  if (typeof answer === 'string' && answer.includes('```')) {
    // tolerant: fenced markdown = a repaired source, no patch
    return { repaired_source: answer }
  }
  return null
}

export interface DriveOptions {
  now?: () => number
  onMint?: (desc: string) => void
}

export async function driveCellularFlux(
  org: FluxOrganism,
  args: CellularArgs,
  opts: DriveOptions = {},
): Promise<CellularOutcome> {
  const t0 = Date.now()
  const trace: TraceStep[] = []
  const mints: string[] = []
  let repairs = 0

  const note = (fr: FireResult, to: string, kind: string) => {
    trace.push({
      signal_id: fr.signal_id, to, kind,
      mode: fr.mode, ok: fr.ok, latency_ms: fr.latency_ms, cost_per_call: fr.cost_per_call,
      answered_by: fr.answered_by,
    })
  }

  // ── 1. perception: transduce + rule table ─────────────────────────────────
  const facts = transduce(args)
  let source = facts.source
  if (facts.shape === 'path') {
    try { source = await readFile(args.path as string, 'utf8') } catch (e) {
      return outcomeFor(new Error(`cannot read path: ${e instanceof Error ? e.message : String(e)}`))
    }
  }

  const per = await org.fire({ from: 'harness', to: 'flux.perceive', kind: 'request', payload: { shape: facts.shape } })
  note(per, 'flux.perceive', 'request')
  const perRespond = per.response as { action?: string; reason?: string }
  if (perRespond?.action === 'reject' || !per.ok) {
    sealPerceive('reject')
    return outcomeFor(new Error(perRespond?.reason ?? 'perception rejected the request'))
  }
  sealPerceive('accept')

  // scratch: one md file per distinct source hash
  const dir = join(org.env.scratchDir ?? '/tmp', 'flux-cells')
  await mkdir(dir, { recursive: true })

  // ── 2. cognition: compile (tendency first, seam second, mint on success) ──
  let currentSource = source as string
  let compileFr: FireResult | null = null
  let compileOut: { ok: boolean; bytecode_file?: string | null; error?: string | null; timedOut?: boolean } | null = null

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const h = hashSource(currentSource)
    const mdFile = join(dir, `src-${h}-${randomUUID().slice(0, 8)}.md`)
    await writeFile(mdFile, currentSource, 'utf8')
    const out = join(dir, `bc-${h}.flux`)

    compileFr = await org.fire({
      from: 'flux.perceive', to: 'flux.compile', kind: 'compile',
      payload: { source_hash: h, source_file: mdFile, out_file: out },
    })
    note(compileFr, 'flux.compile', 'compile')

    if (compileFr.mode === 'table') {
      compileOut = compileFr.response as { ok: boolean; bytecode_file?: string }
      sealCompile('hit')
    } else {
      compileOut = parseSeamContent(compileFr)
      if (compileOut?.ok && compileOut.bytecode_file) {
        const desc = org.mint('flux.compile',
          { when: { kind: 'compile', payload_equals: { source_hash: h } },
            respond: { ok: true, bytecode_file: compileOut.bytecode_file } },
          `signal:${compileFr.signal_id}`, Date.now())
        mints.push(desc); opts.onMint?.(desc)
        sealCompile('miss-mint')
      } else {
        sealCompile('fail')
      }
    }

    if (compileOut?.ok && compileOut.bytecode_file) break

    // ── 3. immunity: heal (table of error-class patches; germ on miss) ─────
    if (attempt === MAX_REPAIRS) break
    const err = String(compileOut?.error ?? 'compile failed')
    const ec = errorClass(err)

    let healed = false
    // 3a. the minted-patch lane: kind 'heal' (heal table may hold this class)
    let healFr = await org.fire({
      from: 'flux.compile', to: 'flux.heal', kind: 'heal',
      payload: { error_class: ec, source_hash: hashSource(currentSource) },
    })
    note(healFr, 'flux.heal', 'heal')

    let germ: GermPatch | null = parseGerm(healFr)
    let patch = germ?.patch && typeof germ.patch.find === 'string' && typeof germ.patch.replace === 'string'
      ? { find: germ.patch.find, replace: germ.patch.replace } : null

    if (healFr.mode === 'escalated' && !patch) {
      // germ answered with a whole repaired source (tolerant lane)
      if (typeof germ?.repaired_source === 'string' && germ.repaired_source.trim()) {
        currentSource = germ.repaired_source
        repairs++; sealHeal('escalated-source')
        continue
      }
    }

    if (healFr.mode === 'escalated' || healFr.mode === 'model' || healFr.mode === 'escalation-failed') {
      sealHeal(healFr.mode === 'escalated' ? 'escalated' : healFr.mode)
    } else {
      sealHeal('table')
    }

    if (patch && typeof currentSource === 'string') {
      const applicable = currentSource.includes(patch.find)
      if (!applicable) {
        // the minted patch does not fit this source: force-novel lane
        // (a DIFFERENT signal kind ⇒ outside the minted rule's key)
        healFr = await org.fire({
          from: 'flux.compile', to: 'flux.heal', kind: 'heal-force',
          payload: { error_class: ec, reason: 'minted patch not applicable' },
        })
        note(healFr, 'flux.heal', 'heal-force')
        germ = parseGerm(healFr)
        patch = germ?.patch && typeof germ.patch.find === 'string' && typeof germ.patch.replace === 'string'
          ? { find: germ.patch.find, replace: germ.patch.replace } : null
        sealHeal('force-escalated')
      }
      if (patch && currentSource.includes(patch.find)) {
        currentSource = currentSource.replace(patch.find, patch.replace)
        repairs++
        // mint the germ-certified general patch under its error class
        if (healFr.mode === 'escalated' && germ?.generalizes === true) {
          const desc = org.mint('flux.heal',
            { when: { kind: 'heal', payload_equals: { error_class: ec } },
              respond: { patch, from_germ: true } },
            `signal:${healFr.signal_id}`, Date.now())
          mints.push(desc); opts.onMint?.(desc)
        }
        continue
      }
      if (typeof germ?.repaired_source === 'string' && germ.repaired_source.trim()) {
        currentSource = germ.repaired_source
        repairs++
        continue
      }
    }
    break // heal could not serve: report the compile failure honestly
  }

  if (!compileOut?.ok || !compileOut.bytecode_file) {
    return outcomeFor(new Error(String(compileOut?.error ?? 'compile failed and healing could not serve')))
  }

  // ── 4. actuation: run (tendency first; the VM through the seam) ──────────
  const bytecodeFile = compileOut.bytecode_file
  const bh = await readBytecodeHash(bytecodeFile)
  const maxCycles = typeof args.maxCycles === 'number' && args.maxCycles > 0 ? Math.trunc(args.maxCycles) : 1_000_000

  const runFr = await org.fire({
    from: 'flux.compile', to: 'flux.run', kind: 'run',
    payload: { bytecode_hash: bh, bytecode_file: bytecodeFile, max_cycles: maxCycles },
  })
  note(runFr, 'flux.run', 'run')

  let runOut: { ok: boolean; cycles?: number; r0?: number | null; error?: string | null; timedOut?: boolean } | null
  if (runFr.mode === 'table') {
    runOut = runFr.response as { ok: boolean; cycles: number; r0: number }
    sealRun('hit', runOut.cycles ?? 0)
  } else {
    runOut = parseSeamContent(runFr)
    if (runOut?.ok && typeof runOut.cycles === 'number') {
      const desc = org.mint('flux.run',
        { when: { kind: 'run', payload_equals: { bytecode_hash: bh } },
          respond: { ok: true, cycles: runOut.cycles, r0: runOut.r0 ?? null } },
        `signal:${runFr.signal_id}`, Date.now())
      mints.push(desc); opts.onMint?.(desc)
      sealRun('miss-mint', runOut.cycles)
    } else {
      sealRun('fail', 0)
    }
  }

  const fascia = readFascia(org, t0)

  return {
    ok: Boolean(runOut?.ok),
    cycles: runOut?.cycles ?? 0,
    result: runOut?.ok ? (runOut.r0 ?? null) : null,
    registers: null,
    error: runOut?.ok ? null : String(runOut?.error ?? 'run failed'),
    timedOut: Boolean(runOut?.timedOut),
    aborted: false,
    durationMs: Date.now() - t0,
    trace,
    serve: {
      perceive: trace.find(x => x.to === 'flux.perceive')?.mode ?? '(none)',
      compile: trace.filter(x => x.to === 'flux.compile').map(x => x.mode).join('>') || '(none)',
      heal: trace.filter(x => x.to === 'flux.heal').map(x => x.mode).join('>') || '(none)',
      run: trace.find(x => x.to === 'flux.run')?.mode ?? '(none)',
    },
    mints,
    repairs,
    fascia,
  }

  // ── ledger sealing + fascia (closures over the roster state) ──────────────

  function st(id: string): number[] {
    const led = org.ledgers.get(id)!
    const cur = led.replay(Date.now() + 1e9).state as number[]
    return [...cur]
  }
  function sealPerceive(kind: string) {
    const [req, rej] = st('flux.perceive')
    org.seal('flux.perceive', { kind: 'request', result: kind }, [req + 1, rej + (kind === 'reject' ? 1 : 0)], Date.now(), { caller: 'harness' })
  }
  function sealCompile(kind: string) {
    const [c, h2, f] = st('flux.compile')
    org.seal('flux.compile', { kind: 'compile', serve: kind },
      [c + 1, h2 + (kind === 'hit' ? 1 : 0), f + (kind === 'fail' ? 1 : 0)], Date.now(), { caller: 'flux.perceive' })
  }
  function sealHeal(kind: string) {
    const [h2, tb, es] = st('flux.heal')
    org.seal('flux.heal', { kind: 'heal', serve: kind },
      [h2 + 1, tb + (kind === 'table' ? 1 : 0), es + (kind.includes('escalat') ? 1 : 0)], Date.now(), { caller: 'flux.compile' })
  }
  function sealRun(kind: string, cycles: number) {
    const [e, ch, tot] = st('flux.run')
    // REAL forecast when this bytecode ran before: expected cycles = the
    // minted table's cycles for this hash ⇒ imbalance = the VM's determinism
    // meter (should stay ~0; a drift is a falsifiable event).
    const sheet = org.sheet('flux.run')
    const rules = (sheet.rules as Array<{ when?: { payload_equals?: Record<string, unknown> }; respond?: Record<string, unknown> }>) ?? []
    const prior = rules.find(r => r.when?.payload_equals?.bytecode_hash === bh)
    const expectedCycles = prior?.respond?.cycles
    const expected = typeof expectedCycles === 'number' ? [e + 1, ch + (kind === 'hit' ? 1 : 0), tot + expectedCycles] : undefined
    org.seal('flux.run', { kind: 'run', serve: kind }, [e + 1, ch + (kind === 'hit' ? 1 : 0), tot + cycles], Date.now(),      { caller: 'flux.compile', expected })
  }

  function readFascia(o: FluxOrganism, startedAt: number): FasciaRead | null {
    const w = Date.now() - startedAt + 2
    const read: CohesionRead | null = cohesion_at_boundary(
      o.ledgers, { b: startedAt, w }, o.corpusSd(), o.offsets(),
    )
    if (!read) return null
    const n = read.c_hat.length
    const vstar = new Array(n).fill(1 / Math.sqrt(n))  // registered prior beam (activity axis)
    const offs = [...o.offsets().values()]
    const fiber = new Array(n).fill(0)
    for (const o2 of offs) for (let i = 0; i < n; i++) fiber[i]! += (o2[i] ?? 0) / Math.max(offs.length, 1)
    const ann = annotate(read.c_hat, vstar, fiber)
    return {
      coh: read.coh, q: read.q, roster: read.roster, dropped: read.dropped, c_hat: read.c_hat,
      annotation: ann, corpus_sd: o.corpusSd(),
    }
  }

  function outcomeFor(err: Error): CellularOutcome {
    const fascia = readFascia(org, t0)
    return {
      ok: false, cycles: 0, result: null, registers: null,
      error: err.message, timedOut: false, aborted: false,
      durationMs: Date.now() - t0, trace,
      serve: {
        perceive: trace.find(x => x.to === 'flux.perceive')?.mode ?? '(none)',
        compile: trace.filter(x => x.to === 'flux.compile').map(x => x.mode).join('>') || '(none)',
        heal: trace.filter(x => x.to === 'flux.heal').map(x => x.mode).join('>') || '(none)',
        run: trace.find(x => x.to === 'flux.run')?.mode ?? '(none)',
      },
      mints, repairs, fascia,
    }
  }
}

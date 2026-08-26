/**
 * organism — the FLUX cellular organism. ONE DSH tool's worth of work
 * (flux_exec: polyglot compile+run), granularized into five cells on the
 * cell-cascade doctrine (../../../cell-cascade/src — firing.ts is used
 * VERBATIM, not forked) with quilt-style sealed ledgers beside each cell
 * (./quilt-ledger.ts).
 *
 * THE ROSTER (lineage: every cell created_from the germ — the zygote):
 *
 *   flux.germ     totipotent    the LLM seam: fires ONLY on heal escalation.
 *                               (provider 'openai-compatible'; env-keyed)
 *   flux.perceive sclerotic     sensory transduction: args-shape rules over
 *                               driver-transduced facts. Cost 0, forever.
 *   flux.compile  multipotent   tendency first: source_hash → bytecode (mint
 *                               table). Miss = its scoped expression, the
 *                               `flux compile` subprocess — logged through
 *                               the SAME ModelExchange contract as an LLM
 *                               call (provider 'flux-vm': the seam generalizes;
 *                               an LLM is one provider of expression, a
 *                               deterministic compiler is another).
 *   flux.heal     differentiated  error_class → patch rule table (SEMANTIC
 *                               key: generalizes across distinct sources —
 *                               the answer to "a hash cache wearing
 *                               vocabulary"). Miss ESCALATES to the germ via
 *                               firing.ts's flagship lineage path.
 *   flux.run      multipotent   bytecode_hash → outcome (mint table: the
 *                               organism learns its own determinism). Miss =
 *                               the `flux run` subprocess through the seam.
 *
 * MINTING: successful compile serves mint source_hash rules; successful run
 * serves mint bytecode_hash rules; germ repairs that self-certify
 * generality mint error_class patch rules into the heal cell. All three
 * canons persist as versioned JSON (cross-run distillation, the
 * arranger-voicings pattern) and reload at genesis.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fireSignal, growRuleIntoSheet, type FireStore, type SignalInsert, type CandidateInsert, type FireResult } from '../../../cell-cascade/src/firing.ts'
import { healthSnapshot, parseSheet, type CellRow, type MyelinRow, type SignalRow, type Rule } from '../../../cell-cascade/src/cascade.ts'
import { buildRequestBody, parseChatCompletion, estimateCost, chatUrl, type SheetModel, type ModelCall, type ModelExchange } from '../../../cell-cascade/src/bridge.ts'
export type { ModelCall, ModelExchange, SheetModel }
import { fluxCompile, fluxRun, type CellSpawnOptions } from './flux-cells-bridge.ts'
import { CellLedger, type Json } from './quilt-ledger.ts'

export const ORGANISM = 'flux'

export type SeamKind = 'llm' | 'flux-vm'

export interface OrganismEnv {
  /** openai-compatible endpoint for the germ (MODEL_BASE_URL pattern). */
  modelBaseUrl?: string
  modelKey?: string
  model?: string
  /** deepseek fallback for demos: base https://api.deepseek.com + key. */
  deepseekKey?: string
  fluxBin?: string
  pythonPath?: string
  scratchDir: string
}

// ── the roster's sheets ──────────────────────────────────────────────────────

const PERCEIVE_RULES: Rule[] = [
  { when: { kind: 'request', payload_equals: { shape: 'inline' } }, respond: { action: 'load_inline' } },
  { when: { kind: 'request', payload_equals: { shape: 'path' } }, respond: { action: 'load_path' } },
  { when: { kind: 'request', payload_equals: { shape: 'invalid:xor' } }, respond: { action: 'reject', reason: 'exactly one of source or path is required' } },
  { when: { kind: 'request', payload_equals: { shape: 'invalid:empty' } }, respond: { action: 'reject', reason: 'source must be non-empty markdown' } },
]

const GERM_PROMPT = [
  'You are the germ line of flux, an organism of cells that compiles and runs polyglot markdown scripts.',
  'A differentiated heal cell could not repair a FLUX markdown script from its committed rule table.',
  'FLUX markdown: fenced code blocks (```flux, ```python, ```c) compiled to bytecode for a register VM.',
  'Known grammar limits: MOVI immediates are 16-bit signed; register names r0..r63; python blocks are',
  'expression/assignment shaped (no def/class/return); arithmetic maps to IADD/ISUB/IMUL/IDIV.',
  'Answer on the heal cell\'s behalf with STRICT JSON, nothing else:',
  '{"patch":{"find":"<literal substring of the broken source>","replace":"<fixed substring>"},',
  ' "generalizes":true|false,"note":"<one line>"}',
  'generalizes=true ONLY if the patch would fix ANY source hitting the same error class.',
].join('\n')

const COMPILE_ROLE = 'compile markdown to FLUX bytecode (scoped expression: the flux compile subprocess)'
const RUN_ROLE = 'execute FLUX bytecode on the register VM (scoped expression: the flux run subprocess)'
const HEAL_ROLE = 'repair broken FLUX sources from error-class patch rules; escalate novel classes to the germ'

function sheetJson(s: Record<string, unknown>): string { return JSON.stringify(s) }

export interface Canon {
  version: number
  rules: Array<{ when: Rule['when']; respond: Record<string, unknown>; minted_at: number; evidence: string }>
}

/** In-memory FireStore: the whole organism, testable without D1 (the
 *  cell-cascade worker implements the same interface over D1). */
export class FluxOrganism implements FireStore {
  readonly cells = new Map<string, CellRow>()
  readonly myelin = new Map<string, MyelinRow>()
  readonly signals: SignalRow[] = []
  readonly candidates: CandidateInsert[] = []
  readonly distillations: Array<{ cell_id: string; from: string; to: string; evidence: string; verdict: string; at: number }> = []
  readonly ledgers = new Map<string, CellLedger>()
  readonly canons = new Map<string, Canon>()          // cell id → minted canon
  /** seam invocation counters — the serve-split's proof instruments */
  readonly seamCalls = { llm: 0, 'flux-vm': 0 }

  private signalSeq = 1
  private candidateSeq = 1

  private spawnOpts: CellSpawnOptions
  readonly env: OrganismEnv
  private llmOverride?: (cfg: SheetModel, req: { system: string; user: string }) => Promise<ModelCall>

  constructor(
    env: OrganismEnv,
    spawnOpts: CellSpawnOptions = {},
    /** test seam: replace the LLM (germ) entirely. */
    llmOverride?: (cfg: SheetModel, req: { system: string; user: string }) => Promise<ModelCall>,
  ) {
    this.env = env
    this.spawnOpts = spawnOpts
    this.llmOverride = llmOverride
    this.genesis()
  }

  private genesis() {
    const now = Date.now()
    const mk = (
      id: string, name: string, tier: CellRow['tier'], role: string,
      sheet: Record<string, unknown>, state: number[],
    ): CellRow => ({
      id, organism: ORGANISM, name, tier, role,
      sheet_json: sheetJson(sheet),
      cost_per_call: tier === 'totipotent' ? 1 : tier === 'multipotent' ? 0.4 : 0,
      latency_ms: tier === 'sclerotic' ? 1 : 300,
      plasticity: tier === 'totipotent' ? 1 : tier === 'multipotent' ? 0.6 : tier === 'differentiated' ? 0.3 : 0.05,
      status: 'active' as const,
      created_from: id === 'flux.germ' ? null : 'flux.germ',
      versions: 1, created_at: now,
    })

    this.cells.set('flux.germ', mk('flux.germ', 'the germ line', 'totipotent', 'novelty + repair seam (the only LLM tissue)', {
      model: {
        provider: 'openai-compatible',
        model: this.env.model ?? 'deepseek-chat',
        system_prompt: GERM_PROMPT,
        max_tokens: 1024, temperature: 0.2,
      },
    }, [0, 0]))

    this.cells.set('flux.perceive', mk('flux.perceive', 'perception', 'sclerotic', 'args-shape rules over transduced facts', {
      rules: PERCEIVE_RULES,
    }, [0, 0]))

    this.cells.set('flux.compile', mk('flux.compile', 'cognition', 'multipotent', COMPILE_ROLE, {
      rules: [],
      model: { provider: 'flux-vm', model: 'compile', system_prompt: COMPILE_ROLE },
    }, [0, 0, 0]))

    this.cells.set('flux.heal', mk('flux.heal', 'immunity', 'differentiated', HEAL_ROLE, {
      rules: [],
      model: { provider: 'openai-compatible', model: this.env.model ?? 'deepseek-chat', system_prompt: GERM_PROMPT },
    }, [0, 0, 0]))

    this.cells.set('flux.run', mk('flux.run', 'actuation', 'multipotent', RUN_ROLE, {
      rules: [],
      model: { provider: 'flux-vm', model: 'run', system_prompt: RUN_ROLE },
    }, [0, 0, 0]))

    const states: Record<string, number[]> = {
      'flux.germ': [0, 0],       // [repair_requests, repair_answers]
      'flux.perceive': [0, 0],   // [requests, rejects]
      'flux.compile': [0, 0, 0], // [compiles, cache_hits, failures]
      'flux.heal': [0, 0, 0],    // [heals, table_serves, escalations]
      'flux.run': [0, 0, 0],     // [executions, cache_hits, vm_cycles_total]
    }
    for (const [id, st] of Object.entries(states)) {
      this.ledgers.set(id, new CellLedger(id, st as Json))
      this.canons.set(id, { version: 0, rules: [] })
    }
  }

  // ── FireStore ──────────────────────────────────────────────────────────────

  async getCell(id: string): Promise<CellRow | null> { return this.cells.get(id) ?? null }
  async getMyelin(pathId: string) {
    const m = this.myelin.get(pathId)
    return m ? { fire_count: m.fire_count, error_count: m.error_count } : null
  }
  async upsertMyelin(m: Omit<MyelinRow, 'tier_promoted_to' | 'last_fired'> & { last_fired: number }) {
    this.myelin.set(m.path_id, { ...m, tier_promoted_to: null, last_fired: m.last_fired })
  }
  async markPromoted(_pathId: string, _tier: CellRow['tier']) { /* promotion ledger only */ }
  async insertSignal(s: SignalInsert): Promise<number> {
    const id = this.signalSeq++
    this.signals.push({
      id, from_cell: s.from_cell, to_cell: s.to_cell, kind: s.kind,
      payload: JSON.stringify(s.payload), ok: s.ok, mode: s.mode,
      model_log: s.model_log ? JSON.stringify(s.model_log) : null,
      escalated_from: s.escalated_from, at: s.at,
    })
    return id
  }
  async updateCellTier(cell: CellRow, toTier: CellRow['tier'], at: number) {
    const c = this.cells.get(cell.id)!
    c.tier = toTier
    void this.insertDistillation(cell.id, cell.tier, toTier, `tier@${at}`, 'auto', at)
  }
  async insertDistillation(cellId: string, from: string, to: string, evidence: string, verdict: string, at: number) {
    this.distillations.push({ cell_id: cellId, from, to, evidence, verdict, at })
  }
  async insertCandidate(c: CandidateInsert): Promise<number> {
    const id = this.candidateSeq++
    this.candidates.push({ ...c, signal_id: id })
    return id
  }

  /**
   * THE SEAM. One contract, two providers of expression:
   *   provider 'flux-vm'    → deterministic runtime subprocess (compile/run)
   *   provider 'openai-compatible' → the LLM (germ / heal fallback)
   * Both log a ModelExchange. This is the generalization the prototype
   * exists to demonstrate: the serve-split does not care whether the
   * expensive side of the seam thinks or compiles.
   */
  async callModel(cfg: SheetModel, req: { system: string; user: string }): Promise<ModelCall> {
    if (cfg.provider === 'flux-vm') return this.callFluxVm(cfg, req)
    return this.callLlm(cfg, req)
  }

  private async callFluxVm(cfg: SheetModel, req: { system: string; user: string }): Promise<ModelCall> {
    this.seamCalls['flux-vm']++
    const started = Date.now()
    let payload: Record<string, unknown> = {}
    try { payload = JSON.parse(req.user).payload as Record<string, unknown> } catch { /* leave empty */ }

    let ok = false
    let content = ''
    if (cfg.model === 'compile') {
      const r = await fluxCompile(String(payload.source_file ?? ''), String(payload.out_file ?? ''), {
        ...this.spawnOpts, fluxBin: this.env.fluxBin, pythonPath: this.env.pythonPath, signal: this.spawnOpts.signal,
      })
      ok = r.ok
      content = JSON.stringify({
        ok: r.ok, bytecode_file: r.bytecodeFile, stdout: r.stdout.slice(0, 400),
        error: r.ok ? null : (r.stderr.trim().split('\n').slice(0, 3).join('\n') || 'compile failed'),
        timedOut: r.timedOut,
      })
    } else {
      const r = await fluxRun(String(payload.bytecode_file ?? ''), Number(payload.max_cycles ?? 1_000_000), {
        ...this.spawnOpts, fluxBin: this.env.fluxBin, pythonPath: this.env.pythonPath, signal: this.spawnOpts.signal,
      })
      ok = r.ok && r.r0 !== null
      content = JSON.stringify({
        ok, cycles: r.cycles, r0: r.r0,
        error: r.timedOut ? 'vm exceeded wall clock' : r.parseError ?? (r.ok ? null : (r.stderr.trim().split('\n').slice(0, 3).join('\n') || 'run failed')),
        timedOut: r.timedOut,
      })
    }
    const log: ModelExchange = {
      provider: 'flux-vm', model: cfg.model, system_prompt: cfg.system_prompt,
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      latency_ms: Date.now() - started, cost_estimate_usd: 0, base_url: 'local://flux-vm',
    }
    return ok
      ? { ok: true, content, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, latency_ms: log.latency_ms, cost_estimate_usd: 0, log }
      : { ok: true, content, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, latency_ms: log.latency_ms, cost_estimate_usd: 0, log }
    // NOTE: a failed compile/run is still a SUCCESSFUL seam exchange (the
    // domain outcome travels in content; only infrastructure throws) — the
    // DSH defensive-patterns rule, holding inside the seam too.
  }

  private async callLlm(cfg: SheetModel, req: { system: string; user: string }): Promise<ModelCall> {
    this.seamCalls.llm++
    const started = Date.now()
    const log = (content: string, usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }, cost: number | null): ModelExchange => ({
      provider: cfg.provider, model: cfg.model, system_prompt: req.system.slice(0, 500),
      prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens,
      latency_ms: Date.now() - started, cost_estimate_usd: cost, base_url: this.env.modelBaseUrl ?? '(deepseek)',
    })

    if (this.llmOverride) return this.llmOverride(cfg, req)

    const base = this.env.modelBaseUrl
    const key = this.env.modelKey
    if (!base || !key) {
      const dsKey = this.env.deepseekKey
      if (!dsKey) {
        return { ok: false, kind: 'env-missing', error: 'no MODEL_BASE_URL/MODEL_KEY and no deepseek fallback', latency_ms: Date.now() - started }
      }
      // deepseek direct fallback (demo lane)
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dsKey}` },
        body: JSON.stringify(buildRequestBody(cfg, req.system, req.user)),
        signal: this.spawnOpts.signal,
      }).catch(e => ({ status: 0, text: async () => String(e) }) as unknown as Response)
      const text = await res.text().catch(() => '')
      const parsed = res.status === 200 ? parseChatCompletion(JSON.parse(text)) : null
      if (!parsed) return { ok: false, kind: res.status === 0 ? 'http' : 'bad-body', error: `deepseek ${res.status}: ${text.slice(0, 200)}`, latency_ms: Date.now() - started }
      return { ok: true, content: parsed.content, usage: parsed.usage, latency_ms: Date.now() - started, cost_estimate_usd: null, log: log(parsed.content, parsed.usage, null) }
    }

    const res = await fetch(chatUrl(base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(buildRequestBody(cfg, req.system, req.user)),
      signal: this.spawnOpts.signal,
    }).catch(e => ({ status: 0, text: async () => String(e) }) as unknown as Response)
    const text = await res.text().catch(() => '')
    const parsed = res.status === 200 ? parseChatCompletion(safeJson(text)) : null
    if (!parsed) return { ok: false, kind: res.status === 0 ? 'http' : 'bad-body', error: `${base} ${res.status}: ${text.slice(0, 200)}`, latency_ms: Date.now() - started }
    return { ok: true, content: parsed.content, usage: parsed.usage, latency_ms: Date.now() - started, cost_estimate_usd: null, log: log(parsed.content, parsed.usage, null) }
  }

  // ── sheets: read + mint ────────────────────────────────────────────────────

  sheet(id: string): Record<string, unknown> { return parseSheet(this.cells.get(id)!) }

  private setSheet(id: string, sheet: Record<string, unknown>) {
    const c = this.cells.get(id)!
    c.sheet_json = sheetJson(sheet)
    c.versions++
  }

  /** Mint one rule into a cell's sheet + the versioned canon (evidence-cited,
   *  reversible: the canon is append-only with version bump). */
  mint(cellId: string, rule: { when: Rule['when']; respond: Record<string, unknown> }, evidence: string, at: number): string {
    const sheet = this.sheet(cellId)
    this.setSheet(cellId, growRuleIntoSheet(sheet, rule))
    const canon = this.canons.get(cellId)!
    canon.rules.push({ ...rule, minted_at: at, evidence })
    canon.version++
    this.insertDistillation(cellId, 'multipotent', 'multipotent', evidence, `mint: ${JSON.stringify(rule.when)}`, at)
    return `${cellId} v${canon.version}: ${JSON.stringify(rule.when)}`
  }

  canonJson(cellId: string): string { return JSON.stringify(this.canons.get(cellId)!, null, 2) }

  /** Load a canon at genesis (cross-run distillation). */
  loadCanon(cellId: string, canon: Canon) {
    const sheet = this.sheet(cellId)
    let s = sheet
    for (const r of canon.rules) s = growRuleIntoSheet(s, { when: r.when, respond: r.respond })
    this.setSheet(cellId, s)
    this.canons.set(cellId, { ...canon })
  }

  // ── ledgers (the quilt side) ───────────────────────────────────────────────

  /** Seal one state edge on a cell's ledger. expected=null ⇒ persistence
   *  prior (quilt append_entry with None). */
  seal(
    cellId: string, input: Json, after: number[], at: number,
    opts: { origin?: 'push' | 'local' | 'mint'; caller?: string; expected?: number[] } = {},
  ) {
    const led = this.ledgers.get(cellId)!
    return led.record_with(input, after as Json, at, {
      origin: opts.origin ?? 'local', caller: opts.caller ?? 'driver', trace: [],
    }, (opts.expected ?? null) as Json | null)
  }

  /** The fascia reader's corpus_sd estimate: pooled sealed magnitude history. */
  corpusSd(): number {
    const mags: number[] = []
    for (const led of this.ledgers.values()) mags.push(...led.magnitude_history())
    if (mags.length === 0) return 1
    const mean = mags.reduce((a, b) => a + b, 0) / mags.length
    const sd = Math.sqrt(mags.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(mags.length, 1))
    return Math.max(sd, 1e-9)
  }

  /** Personality offsets for q: per-cell mean state (slow-clock fiber, v1). */
  offsets(): Map<string, number[]> {
    const out = new Map<string, number[]>()
    for (const [id, led] of this.ledgers) {
      const st = led.replay(Date.now()).state
      if (Array.isArray(st)) out.set(id, st.map(x => (typeof x === 'number' ? x : 0)))
    }
    return out
  }

  health() {
    return healthSnapshot(ORGANISM, [...this.cells.values()], [...this.myelin.values()], this.signals)
  }

  /** Convenience: fire one signal (delegates to cell-cascade VERBATIM). */
  fire(input: { from: string; to: string; kind: string; payload: Record<string, unknown> }, now = Date.now()): Promise<FireResult> {
    return fireSignal(this as unknown as FireStore, input, { now, threshold: 25 })
  }

  /** Everything the ledger-facing API needs for artifact dumps. */
  async signalLog(): Promise<unknown[]> {
    return this.signals.map(s => ({
      id: s.id, from: s.from_cell, to: s.to_cell, kind: s.kind, ok: s.ok, mode: s.mode, at: s.at,
      escalated_from: s.escalated_from,
    }))
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

export async function readBytecodeHash(file: string): Promise<string> {
  const buf = await readFile(file)
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

export function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16)
}

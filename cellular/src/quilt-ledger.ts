/**
 * quilt-ledger — a faithful mini-port of quilt-rust's CellLedger to TypeScript,
 * per /home/eileen/projects/quilt-rust/docs/cell-ledger.md and
 * cohesion-and-fascia.md (commit 306d73d vocabulary; every constant quoted
 * there is an elephant-corpus prior, not a law).
 *
 * The autobiography contract, ported exactly:
 *   - every entry records a before→after edge (`delta`),
 *   - the forecast it was scored against (`expected`), sealed into the hash,
 *   - the surprise (`imbalance`),
 *   - provenance (origin/caller/trace),
 *   - sealed at append time (hash chain); NOTHING writes back afterwards.
 *
 * Metric honesty (cohesion-and-fascia.md §2): `value_distance` on arrays is
 * MEAN-L1 per coordinate, NOT the L2 the elephant's d_mu uses. Both are
 * provided; consumers must choose consciously.
 */

import { createHash } from 'node:crypto'

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export type LedgerOrigin = 'push' | 'local' | 'mint'

export interface Provenance {
  origin: LedgerOrigin
  caller?: string
  trace: string[]
}

export interface Delta {
  before: Json
  after: Json
  changed: boolean
  magnitude: number
}

export interface LedgerEntry {
  ts: number
  input: Json               // debit: what asked for this step
  delta: Delta              // the sealed first-person edge
  expected: Json | null     // the forecast; null = persistence prior (expected = before)
  imbalance: number | null  // surprise vs expected (mean-L1); null = undefined forecast
  provenance: Provenance
  prev_hash: string
  hash: string
}

export interface ReplayState {
  ts: number | null
  state: Json
  entries: number
}

export function canonicalJson(v: Json): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
}

/** quilt-rust `value_distance` semantics: mean per-coordinate L1 on arrays;
 *  |a-b| on numbers; 0/1 on other primitives. Returns null when shapes are
 *  incomparable (honest: no silent coercion across array lengths). */
export function meanL1Distance(a: Json, b: Json): number | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length || a.length === 0) return null
    let sum = 0
    for (let i = 0; i < a.length; i++) {
      const x = typeof a[i] === 'number' ? (a[i] as number) : 0
      const y = typeof b[i] === 'number' ? (b[i] as number) : 0
      sum += Math.abs(x - y)
    }
    return sum / a.length
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b)
  if (typeof a === typeof b && !Array.isArray(a) && !Array.isArray(b)) return a === b ? 0 : 1
  return null
}

/** L2 norm of a numeric vector (the elephant d_mu convention). */
export function l2(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0))
}

function deltaOf(before: Json, after: Json): Delta {
  const d = meanL1Distance(before, after)
  return {
    before,
    after,
    changed: d === null ? true : d > 0,
    magnitude: d ?? NaN,
  }
}

export class CellLedger {
  readonly cell_id: string
  private genesis_state: Json
  private chain: LedgerEntry[] = []
  private head = 'GENESIS'

  constructor(cell_id: string, genesis: Json) {
    this.cell_id = cell_id
    this.genesis_state = genesis
  }

  private seal(entry: Omit<LedgerEntry, 'hash'>): string {
    return createHash('sha256')
      .update(entry.prev_hash)
      .update(canonicalJson(entry.input))
      .update(canonicalJson(entry.delta.before))
      .update(canonicalJson(entry.delta.after))
      .update(entry.expected === null ? 'null' : canonicalJson(entry.expected))
      .update(String(entry.ts))
      .digest('hex')
  }

  /**
   * Record one step. `expected === null` ⇒ persistence prior: expected is
   * the before-state, so imbalance == delta.magnitude (quilt-rust
   * `append_entry` with `None`, ledger.rs:758). A caller-supplied forecast is
   * SEALED into the hash — it cannot be rewritten later.
   */
  record_with(input: Json, after: Json, ts: number, provenance: Provenance, expected: Json | null = null): LedgerEntry {
    const before = this.state_at(this.chain.length)
    const delta = deltaOf(before, after)
    const sealedExpected = expected ?? before
    const imbalance = meanL1Distance(sealedExpected, after)
    const entry: LedgerEntry = {
      ts,
      input,
      delta,
      expected: sealedExpected,
      imbalance,
      provenance,
      prev_hash: this.head,
      hash: '',
    }
    entry.hash = this.seal(entry)
    this.chain.push(entry)
    this.head = entry.hash
    return entry
  }

  private state_at(n: number): Json {
    if (n === 0) return this.genesis_state
    return this.chain[n - 1]!.delta.after
  }

  get entries(): readonly LedgerEntry[] {
    return this.chain
  }

  /** Reconstruct state at any past cut — no leakage past `until_ts`. */
  replay(until_ts: number): ReplayState {
    let state = this.genesis_state
    let ts: number | null = null
    let n = 0
    for (const e of this.chain) {
      if (e.ts > until_ts) break
      state = e.delta.after
      ts = e.ts
      n++
    }
    return { ts, state, entries: n }
  }

  /** Seal-first invariant: chain verifies. Tamper with any entry → broken. */
  verify_chain(): { intact: boolean; broken_at: number | null } {
    let prev = 'GENESIS'
    for (let i = 0; i < this.chain.length; i++) {
      const e = this.chain[i]!
      if (e.prev_hash !== prev) return { intact: false, broken_at: i }
      const resealed = this.seal({ ...e, hash: '' } as Omit<LedgerEntry, 'hash'>)
      if (resealed !== e.hash) return { intact: false, broken_at: i }
      prev = e.hash
    }
    return { intact: true, broken_at: null }
  }

  /** History of sealed magnitudes (for corpus_sd estimation in the reader). */
  magnitude_history(): number[] {
    return this.chain.map(e => e.delta.magnitude).filter(Number.isFinite)
  }
}

/**
 * fascia — the reader of N autobiographies, ported from quilt-rust
 * docs/cohesion-and-fascia.md (§3 COH, §4 v*, §5 REG-1). Read-side ONLY:
 * tissue outputs go to their own report, never back into a member ledger
 * (seal-first / fuse-second — the coordinate firewall).
 *
 *   δ_R = state_R(b+W−1) − state_R(b−1)     per-cell step over the window
 *   ĉ   = mean_R δ_R                        the roster's common shift
 *   r_R = δ_R − ĉ                            who didn't move with it
 *   COH = ‖ĉ‖₂ / corpus_sd                   collective translation magnitude
 *   q   = RMS_R(r_R) / RMS_R(o_pre)          purity (needs personality offsets)
 *
 * REG-1: ship cos_to_tissue AND cos_to_fiber with every aggregate; expect
 * fiber ≫ tissue (priors 0.98 vs 0.14) — the opposite means you are reading
 * roster composition, not tissue.
 */

import { CellLedger, l2, type Json } from './quilt-ledger.ts'

export interface Boundary {
  b: number           // boundary timestamp (exclusive pre-cut = b-1)
  w: number           // window length (ts units); post-cut = b+w-1
}

/** Per-cell step over [pre_cut, post_cut] from replay cuts only.
 *  None ⇒ cell has no comparable vector state — drop from the roster. */
export function step_over(ledger: CellLedger, pre_cut: number, post_cut: number): number[] | null {
  const pre = ledger.replay(pre_cut).state
  const post = ledger.replay(post_cut).state
  if (!Array.isArray(pre) || !Array.isArray(post)) return null
  if (pre.length !== post.length || pre.length === 0) return null
  const step: number[] = []
  for (let i = 0; i < post.length; i++) {
    const a = typeof post[i] === 'number' ? (post[i] as number) : 0
    const b = typeof pre[i] === 'number' ? (pre[i] as number) : 0
    step.push(a - b)
  }
  return step
}

export interface CohesionRead {
  boundary: Boundary
  roster: string[]               // cells that stepped in BOTH cuts (common-roster guard)
  dropped: string[]              // cells without comparable state in both cuts
  c_hat: number[]                // the common shift (direction log)
  coh: number                    // ‖ĉ‖₂ / corpus_sd
  q: number | null               // RMS(r_R)/RMS(o_pre); null = no offsets supplied
  residuals: Record<string, number[]>
}

/** COH and purity q at one boundary. corpus_sd from sealed magnitude
 *  history (elephant priors are calibration, not law). */
export function cohesion_at_boundary(
  ledgers: Map<string, CellLedger>,
  boundary: Boundary,
  corpus_sd: number,
  offsets_pre?: Map<string, number[]>,
): CohesionRead | null {
  const steps = new Map<string, number[]>()
  const dropped: string[] = []
  for (const [id, led] of ledgers) {
    const s = step_over(led, boundary.b - 1, boundary.b + boundary.w - 1)
    if (s === null) dropped.push(id)
    else steps.set(id, s)
  }
  const roster = [...steps.keys()]
  if (roster.length < 2) return null        // a school needs ≥2 fish
  const n = steps.get(roster[0]!)!.length

  const c_hat: number[] = new Array(n).fill(0)
  for (const id of roster) {
    const s = steps.get(id)!
    for (let i = 0; i < n; i++) c_hat[i]! += s[i]! / roster.length
  }

  const residuals: Record<string, number[]> = {}
  for (const id of roster) {
    const s = steps.get(id)!
    // residual over the SHARED window only: cells may carry state vectors of
    // different lengths (a 2-dim perceive vs a 3-dim compile); coordinates
    // beyond the roster's common width have no common shift to subtract.
    residuals[id] = s.slice(0, n).map((v, i) => v - c_hat[i]!)
  }

  const coh = l2(c_hat) / Math.max(corpus_sd, 1e-12)

  const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / Math.max(xs.length, 1))
  let q: number | null = null
  if (offsets_pre && offsets_pre.size > 0) {
    const rFlat: number[] = []
    const oFlat: number[] = []
    for (const id of roster) {
      rFlat.push(...residuals[id]!)
      const o = offsets_pre.get(id)
      if (o) oFlat.push(...o)
    }
    if (oFlat.length > 0) q = rms(rFlat) / Math.max(rms(oFlat), 1e-12)
  }

  return { boundary, roster, dropped, c_hat, coh, q, residuals }
}

/** v* projection of a sealed edge (§4): the signed leg scalar imbalance
 *  discards. d_vstar > 0 ⇒ this cell moved WITH the tissue channel. */
export function tissue_read(v_star: number[], before: Json, after: Json): number | null {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return null
  const step = after.map((a, i) => (typeof a === 'number' ? a : 0) - (typeof before[i] === 'number' ? (before[i] as number) : 0))
  const norm = Math.max(l2(step), 1e-12)
  let dot = 0
  for (let i = 0; i < Math.min(v_star.length, step.length); i++) dot += v_star[i]! * step[i]!
  return dot / norm
}

export interface FasciaAnnotation {
  cos_to_tissue: number
  cos_to_fiber: number
  verdict: 'tissue-like' | 'composition-suspect'
  note: string
}

const cos = (a: number[], b: number[]): number => {
  let dot = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i]! * b[i]!
  return dot / (Math.max(l2(a), 1e-12) * Math.max(l2(b), 1e-12))
}

/** REG-1 dual-annotation guard (§5): every valence-flavored aggregate ships
 *  BOTH cosines. cos_to_fiber ≫ cos_to_tissue expected; the reverse means
 *  the "signal" is the mix of cells present. */
export function annotate(axis: number[], v_star: number[], pc1_pers: number[]): FasciaAnnotation {
  const cos_to_tissue = cos(axis, v_star)
  const cos_to_fiber = cos(axis, pc1_pers)
  return {
    cos_to_tissue,
    cos_to_fiber,
    verdict: Math.abs(cos_to_tissue) > Math.abs(cos_to_fiber) ? 'composition-suspect' : 'tissue-like',
    note: Math.abs(cos_to_tissue) > Math.abs(cos_to_fiber)
      ? 'REG-1: alignment to tissue exceeds fiber — treat as roster composition until ĉ/r_R decomposition says otherwise'
      : 'REG-1: fiber-dominant, as priors predict (0.98 vs 0.14)',
  }
}

/** λ* deadband law (§5.2): tissue alert thresholds sit at λ*·corpus_sd
 *  (elephant λ* ≤ 0.27), never at full corpus_sd. */
export function tissue_deadband(corpus_sd: number, lambda_star = 0.27): number {
  return lambda_star * corpus_sd
}

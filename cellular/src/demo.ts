/**
 * demo — one organism, one call, the whole account printed.
 * Offline-deterministic (scripted germ). For a live-germ demo set
 * DEEPSEEK_API_KEY (deepseek-chat answers the escalation for real).
 *
 *   npm run demo
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, chmod, writeFile } from 'node:fs/promises'
import { FluxOrganism, type ModelCall } from './organism.ts'
import { driveCellularFlux } from './driver.ts'

const RUNTIME_SRC = process.env.FLUX_RUNTIME_SRC ?? '/home/eileen/projects/flux-runtime/src'

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'flux-cells-demo-'))
  const fluxBin = join(scratch, 'flux')
  await writeFile(fluxBin, `#!/bin/sh\nexport PYTHONPATH="${RUNTIME_SRC}:$PYTHONPATH"\nexec python3 -m flux "$@"\n`)
  await chmod(fluxBin, 0o755)

  const liveKey = process.env.DEEPSEEK_API_KEY
  const scriptedGerm = async (): Promise<ModelCall> => ({
    ok: true,
    content: JSON.stringify({ patch: { find: 'FOOBAR', replace: 'MOVI' }, generalizes: true, note: 'scripted germ (set DEEPSEEK_API_KEY for a live one)' }),
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    latency_ms: 1, cost_estimate_usd: 0,
    log: { provider: 'scripted', model: 'germ', system_prompt: '(demo)', prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, latency_ms: 1, cost_estimate_usd: 0, base_url: 'demo://' },
  })

  const org = new FluxOrganism(
    { scratchDir: scratch, fluxBin, ...(liveKey ? { deepseekKey: liveKey } : {}) },
    { fluxRuntimeSrc: RUNTIME_SRC, timeoutMs: 15_000 },
    liveKey ? undefined : scriptedGerm,
  )

  console.log(`germ: ${liveKey ? 'LIVE deepseek-chat' : 'scripted (offline)'}`)
  console.log('\n── call 1: a broken source (unknown opcode FOOBAR) ──')
  const broken = await driveCellularFlux(org, { source: '```flux\nFOOBAR r0, 40\nIADD r0, r0, r0\n```\n' })
  report(broken)

  console.log('\n── call 2: the SAME error class in a different source (heal must serve from its minted table, zero germ calls) ──')
  const again = await driveCellularFlux(org, { source: '```flux\nFOOBAR r0, 15\nIADD r0, r0, r0\nIADD r0, r0, r0\n```\n' })
  report(again)

  console.log('\n── call 3: repeat of call 2 (compile+run tendencies serve; the seam stays cold) ──')
  const cached = await driveCellularFlux(org, { source: '```flux\nFOOBAR r0, 15\nIADD r0, r0, r0\nIADD r0, r0, r0\n```\n' })
  report(cached)

  console.log('\n── ledgers ──')
  for (const [id, led] of org.ledgers) {
    console.log(`${id.padEnd(14)} entries=${led.entries.length} chain=${led.verify_chain().intact ? 'intact' : 'BROKEN'}`)
  }
  console.log('\n── health ──')
  const h = org.health()
  console.log(`zero-cost serve: ${h.zero_cost_serve_pct}%  totipotent load: ${h.totipotent_load_pct}%`)
  console.log(`seam calls: ${JSON.stringify(org.seamCalls)}`)
}

function report(o: Awaited<ReturnType<typeof driveCellularFlux>>) {
  console.log(`ok=${o.ok} result=${JSON.stringify(o.result)} cycles=${o.cycles} repairs=${o.repairs} (${o.durationMs}ms)`)
  console.log(`serve: ${JSON.stringify(o.serve)}`)
  if (o.mints.length) console.log(`mints: ${o.mints.join(' | ')}`)
  if (o.fascia) console.log(`fascia: COH=${o.fascia.coh.toFixed(3)} q=${o.fascia.q?.toFixed(3) ?? '—'} roster=[${o.fascia.roster.join(',')}] ${o.fascia.annotation.verdict}`)
  if (o.error) console.log(`error: ${o.error.slice(0, 160)}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
void readFile

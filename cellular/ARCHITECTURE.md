# THE CELLULAR SEAM — DSH plugin lifecycle as one organism's development

*v0.1, 2026-08-26, branch `dsh-cellular-seam`. What the captain asked: DSH's
"everything is a plugin" enhanced with something deeper — a superinstance as
a cellular protocol underpinning the granularization of those plugins into
independent cells as building blocks with relationships.*

This document maps DSH's plugin abstraction onto the cellular vocabulary
(cell-cascade tissue tiers + quilt ledgers/fascia), states what the working
prototype (`src/`, `test/`, 20 green tests against the REAL flux runtime)
proved, and — honestly — where the two abstractions fight each other.

---

## 1. The mapping: plugin lifecycle → cellular development

DSH's plugin contract is a lifecycle: `apply(ctx)` → reactive services →
`dispose()` with revertible effects (the Cordis "spatiotemporal" bet —
temporal composability = clean unload). The cellular reading:

| DSH concept | Cellular reading | Status in prototype |
|---|---|---|
| Plugin **load / apply** | **Genesis** — the zygote exists, cells created_from the germ | `FluxOrganism.genesis()` |
| Plugin **config** | **Genome** — the sheet_json each cell is born with (rules, model binding, prompts). Config does not *configure* a cell; it *is* the cell's heritable sheet | `CellRow.sheet_json`, `loadCanon()` = inherited acquired traits |
| **One registered tool** | **One membrane entry** — the driver. The tool boundary does not move; what's behind it granularizes | `driver.ts` — `driveCellularFlux()` |
| Tool **implementations** | **Differentiated tissue** — the work splits into cells with distinct tiers and roles | 5 cells (below) |
| **dispose() / revertible effects** | **No write-back, ever** — quilt seal-first ledgers; the fascia is read-side only | `CellLedger` hash chain, `verify_chain()` |
| **Capability seams** (swap a provider, tools move with it) | **The serve-split seam** — one contract, many providers of *expression* (LLM, deterministic VM) | `callModel`: `'openai-compatible' | 'flux-vm'` |
| Plugin **dependency graph** (inject/coeffects) | **Lineage** (`created_from`) + signal edges — relationships are kinship and traffic, not imports | `created_from: 'flux.germ'`, `FireStore.myelin` |

### The roster (one DSH tool, `flux_exec`, granularized)

```
   tool call (the membrane — driver owns NO judgment)
      │
      ├─► flux.perceive   [sclerotic]     args-shape rules; cost 0 forever
      ├─► flux.compile    [multipotent]   source_hash tendency → the flux-vm
      │                                   seam (parse subprocess) → mint
      ├─► flux.heal       [differentiated] error_class patch table; miss
      │   └── escalate ──► flux.germ [totipotent]  the ONLY LLM tissue
      │                                    (novelty + repair; repairs that
      │                                    self-certify generality mint
      │                                    back into the heal table)
      └─► flux.run        [multipotent]   bytecode_hash tendency → the
                                          `flux run` subprocess → mint
```

Each cell carries: a **sheet** (genome: rules + model binding), a **ledger**
(autobiography: sealed before→after edges, forecasts, surprises), and
**myelin** (relationship traffic counters on signal edges). Successful work
**mints** evidence-cited rules into versioned canons that reload at genesis —
cross-run distillation, the acquired-trait lane DSH has no analog for.

## 2. Relationships in the native vocabulary

- **v\* / tissue axis** (`fascia.ts`): at each call boundary the driver reads
  COH = ‖ĉ‖₂/corpus_sd over the roster's sealed steps, residuals r_R per
  cell, and purity q. A cell that didn't move with the tissue shows up in
  its residual — a *falsifiable* health signal, not a metric dashboard.
- **REG-1 dual annotation**: every aggregate ships cos_to_tissue AND
  cos_to_fiber; tissue-dominance flags "you are reading roster composition,
  not tissue behavior." The prototype's third demo call tripped exactly this
  guard (see VERDICT).
- **Seal-first / fuse-second**: tissue outputs never write back into member
  ledgers. The coordinate firewall holds: compile's cache hit does not edit
  perceive's autobiography.
- **λ\* deadband**: alert thresholds at 0.27·corpus_sd, elephant priors as
  calibration not law.

## 3. What the prototype proved (all in `test/cellular.test.ts`, 20 tests)

1. **Real end-to-end**: inline markdown → parse subprocess → bytecode →
   `flux run` subprocess → R0, all five cells firing, every ledger chain
   intact (tamper test breaks it at the right entry).
2. **The organism learns its own determinism**: second identical call serves
   compile AND run from minted tables; the run ledger's sealed forecast
   (`expected` cycles) scores imbalance 0 — determinism is a *measurement*.
3. **The immune lineage works**: unknown opcode → heal miss → germ
   escalation (real LLM or test seam) → patch → compile ok → **patch minted
   keyed by error_class** → a *different* source in the same class serves
   from the table with **zero** germ calls (`seamCalls.llm` unchanged).
4. **The seam generalizes**: `provider: 'flux-vm'` puts a deterministic
   compiler and an LLM behind ONE exchange contract. The serve-split does
   not care whether the expensive side of the seam thinks or compiles.
5. **Canons persist**: a minted compile canon reloads into a fresh organism
   at genesis → first call already serves from table.

## 4. HONEST GAPS — where the plugin abstraction fights the cell abstraction

- **A cell is not unloadable.** DSH's crown jewel is revertible effects on
  dispose. A minted rule is *heritable acquired information* — you can
  archive a canon version but you cannot un-teach the organism without
  lying about its history. Cellular time is append-only; plugin time is
  transactional. The ledgers honor the cell; the *canon* has no undo.
- **One tool ≠ one organism boundary.** DSH plugins compose laterally
  (coeffects); organisms compose by lineage and traffic. Two cellularized
  tools share a germ only by convention — nothing in DSH's injector
  expresses "cell B is created_from cell A." The relationship vocabulary
  lives entirely on our side.
- **Genesis ≠ apply.** `apply()` is cheap and idempotent; genesis loads
  canons, which is *stateful across runs*. A DSH profile that mounts this
  organism twice gets two lineages and no shared canon — the distillation
  lane needs a home (file canon today; the quilt bridge-cell-ledger doc
  sketches the real one) that DSH's config layering does not provide.
- **The upstream `flux compile` CLI is broken** (empty modules for
  md/python, broken register allocation for C — verified 2026-08-26 against
  `flux-runtime @ da771e6`). The compile cell routes around it via the
  runtime's own parser (`scripts/flux-parse.py`). This is the cellular
  layer *working as designed* (scoped expression, honest failure) but it
  means the split compile/run lanes are only as real as the runtime's
  parse API.
- **Vector states are hand-shaped.** The fascia math wants δ_R over
  comparable vector states; our cells carry counters of different widths.
  We take the shared window and document it — but a real organism wants a
  declared state schema per tissue, which nothing in DSH or cell-cascade
  currently enforces.

## 5. Run it

```sh
cd cellular
npm install
npx tsc --noEmit     # typecheck
npx vitest run       # 20 tests; e2e uses the real flux runtime subprocesses
npm run demo         # the three-call account: broken→healed→cached
```

Flux runtime checkout expected at `/home/eileen/projects/flux-runtime/src`
(override with `FLUX_RUNTIME_SRC`), same convention as the embassy harness.

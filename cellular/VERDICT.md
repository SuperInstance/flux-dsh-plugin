# VERDICT — does the cellular layer deepen DSH, or rename it?

*2026-08-26, branch `dsh-cellular-seam`. Evidence: 20 green tests
(`cellular/test/cellular.test.ts`) against the REAL flux runtime via real
subprocesses, plus the three-call demo (`npm run demo`).*

## The one-sentence verdict

**Genuine deepening — but the depth is in three specific mechanisms, not a
wholesale transformation; the rest of the plugin surface would indeed be a
rename.**

## What the prototype actually proved (not asserted)

1. **Minting is real learning, not caching.** A compile keyed by
   `source_hash` would be a hash cache wearing vocabulary — that criticism
   was aimed at this exact design, and it holds for the compile/run tables.
   The answer the prototype *demonstrates* is the **heal cell keyed by
   `error_class`** (semantic normalization: digits, registers, strings
   stripped). Test: source A (`NOPE r0, 10`) breaks, the germ patches it,
   the patch mints under its error class; source B (`NOPE r0, 6` + different
   body) — never seen, different hash — **serves from the heal table with
   zero LLM calls** (`seamCalls.llm` asserted unchanged). A cache cannot do
   that; a rule generalized by a self-certifying germ can. That is the one
   moment a plugin becomes tissue.

2. **The seam generalizes beyond LLMs.** `provider: 'flux-vm'` runs a
   deterministic parser/VM behind the same ModelExchange contract as
   deepseek. Both lanes logged 7 vm-seam calls and 1 llm call in the demo.
   The serve-split ("tendency first, expression second, mint on success")
   is provider-agnostic — proved, not claimed.

3. **Falsifiable self-account.** Every cell seals before→after edges with
   sealed forecasts; the repeat-run test asserts `imbalance === 0` against
   the table's predicted cycle count — determinism measured, not assumed.
   Tamper any entry and `verify_chain()` names the index. DSH's session log
   records *events*; the quilt ledger records *a first-person autobiography
   with sealed predictions*. Different object.

4. **The fascia reads the organism and catches the prototype itself.** On
   the demo's third (fully-cached) call, the REG-1 guard flipped to
   `composition-suspect` — COH was reading roster composition, not tissue
   behavior. The reader worked well enough to critique its own demo. That
   is the relationship layer doing its job.

## Where it would be a rename

- Mounting a stateless DSH plugin (format a string, call an API once) as
  "one sclerotic cell with one rule" adds vocabulary and zero capability.
  The cellular layer pays only where **misses are expensive** (LLM,
  subprocess, compile) and **misses repeat with structure** (error classes,
  hashes) — i.e., where minting and escalation have something to distill.
- The perception/compile/run split per se is just function decomposition.
  What makes it cellular is the tiers + lineage + ledgers around it; without
  those three, you have refactoring.

## Honest costs

- The upstream `flux compile` CLI is broken (empty modules for md/python,
  broken codegen for C — verified); the compile cell routes around it via
  the runtime's own parser. The lane is real, but it leans on an API the
  runtime team may move.
- No dispose/un-teach: minted canons are append-only heritable state; DSH's
  revertible-effects crown jewel has no cellular equivalent (see
  ARCHITECTURE §4).

## Recommendation

Proceed, selectively: cellularize the plugins whose misses are expensive
and structured (executors, compilers, repair loops, anything with an LLM in
it). Leave stateless adapters as plugins. The two layers compose — the
organism still mounts as ONE DSH tool — and that composition, not
replacement, is the finding.

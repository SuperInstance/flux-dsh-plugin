# A/B PLAN — plugin harness vs direct FLUX calls

**Status:** schema stub + runner shipped; 20 seed entries produced; **no live judgment** — that belongs to saddle's ledger over a longer run.

## Question

Does routing FLUX calls through a plugin harness (DSH's `defineTool`/Cordis contract) measurably change cost or fidelity versus calling the FLUX CLI directly — where cost means per-call latency AND iteration friction, and fidelity means identical outcomes for identical tasks?

## Arms

| Arm | Path | What it isolates |
|---|---|---|
| `direct` | `python3 -m flux run-md <file> --json` | FLUX as an agent calls it today |
| `dsh-plugin` | `flux_exec` through `apply()` → `defineTool` → bridge → same CLI | everything the harness adds: arg validation, scratch handling, canonical value, projections |

## Protocol

- Runner: `./ab/runner.sh [rounds]` — appends JSONL entries to `ab/out/ledger.jsonl`.
- Entry schema: `ab/schema/ledger-entry.schema.json` (stub; saddle may extend `env`/`notes`).
- Tasks: fixed corpus in `ab/arm-driver.mjs` (factorial, sum, arithmetic, real parse-failure, garbage no-op) — outcomes must AGREE between arms; disagreement is a bug in the bridge, not a judgment.
- Seed data (2 rounds × 5 tasks × 2 arms): outcomes agreed 10/10; medians 64–76ms direct vs 66–73ms plugin; measured in-harness overhead avg 0.6ms. Python startup dominates; per-call latency is NOT the interesting axis at this scale.

## What saddle should judge later (deferred, per instruction)

1. **Iteration cost**, not call cost: schema edits, presenter rework, and contract churn per DSH RC (see `PIN.md` warning) — logged via `notes` when they bite.
2. **Fidelity over time**: any task where arms disagree on `ok`/`result`.
3. **Lifecycle tax**: unload/reload behavior under live sessions (does dispose reach quiescence? does replay still render?).
4. **Distribution value** (the steelman): ecosystem reach gained by existing as a DSH plugin, if DSH survives to 1.0.

## Non-goals

No migration of anything, no winner declaration, no integration into nightcycle. The ledger accumulates; the verdict can only be earned.

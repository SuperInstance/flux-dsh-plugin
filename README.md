# flux-dsh-plugin

**Mount FLUX (SuperInstance's polyglot runtime) as ONE DeepSeek Harness plugin. An embassy, not a migration.**

One Cordis plugin (`name: 'flux-exec'`, `inject: ['tools']`) registering one tool:

```
flux_exec(source XOR path, maxCycles?, timeoutMs?)
  → { ok, cycles, result, registers, error, timedOut, aborted, durationMs }
```

FLUX stays where it lives (own repo, own process); the tool compiles + runs FLUX-ese scripts via `flux run-md --json`, honors harness cancellation (`exec.signal`), kills in-flight children on plugin unload (process-group, SIGTERM→SIGKILL), and cleans its scratch dir through a `ctx.effect` disposer.

## Why this exists

`dsh-assessment` (2026-08-23) ruled DSH a SIDESTEP for migration but prescribed one cheap experiment: mount FLUX as a single plugin and harvest the seams. Findings: [`docs/SEAM-REPORT.md`](docs/SEAM-REPORT.md) (the harvest), [`docs/A-B-PLAN.md`](docs/A-B-PLAN.md) (ledger plan), [`docs/PIN.md`](docs/PIN.md) (exact source versions).

## Layout

```
plugin/          the DSH plugin (TypeScript; deps: published @deepseek-ai/dsh-tools)
  src/index.ts       Cordis plugin + defineTool(flux_exec)
  src/flux-bridge.ts subprocess bridge: spawn, scrub env, kill tree, quiesce
  test/              26 tests incl. real-FLUX e2e + lifecycle/revertible-effect asserts
ab/               A/B runner + saddle ledger schema stub (no live judgment)
docs/             SEAM-REPORT, A-B-PLAN, PIN, pinned evidence excerpts
```

## Run

```sh
cd plugin && npm install && npx tsc --noEmit && npx vitest run   # 26 tests
cd .. && ./ab/runner.sh 3                                        # append ledger entries
```

Tests drive the real FLUX runtime via a `python3 -m flux` wrapper (override with `FLUX_RUNTIME_SRC`).

## Mounting in a real DSH profile (when one exists locally)

Add to a `cordis.patch.yml` row (per DSH `docs/architecture.md` § profiles):

```yaml
- id: flux
  name: 'flux-dsh-plugin'
  config:
    fluxBin: flux            # or a wrapper for a source checkout
    defaultTimeoutMs: 10000
```

⚠ DSH is pre-1.0 with promised breaking changes; this plugin is pinned to `dsh-v0.1.1-rc.2`. Re-read the pinned docs (see `docs/PIN.md`) before bumping.

# SEAM REPORT — mounting FLUX on DeepSeek Harness

**Date:** 2026-08-23 · **Author:** embassy subagent · **Scope:** one plugin, one capability, one weekend.
**Pins:** DSH `dsh-v0.1.1-rc.2` (commit `b150a55`), `@deepseek-ai/dsh-tools@0.1.1-rc.2` from npm, FLUX from `/home/eileen/projects/flux-runtime` (see `PIN.md`).
**Method:** built `flux_exec` against the *published* contract package, typechecked and tested against it (26 tests), ran the real FLUX runtime end-to-end through both the direct CLI and the plugin path. Everything below came off the pinned tarball or the installed npm package — not from memory, not from blogs.

---

## 0. What actually mounted

One Cordis plugin (`plugin/src/index.ts`, ~230 lines) registering exactly one tool:

```
name: flux-exec          inject: ['tools']          apply(ctx, config)
tool:  flux_exec(source XOR path, maxCycles?, timeoutMs?) →
       { ok, cycles, result, registers, error, timedOut, aborted, durationMs }
```

- Compiles + runs FLUX-ese / assembly / markdown through `flux run-md --json` as a subprocess, honoring `exec.signal`, with plugin-level kill-on-unload of in-flight children (process-group kill: SIGTERM→SIGKILL escalation) and lazy scratch-dir cleanup registered as a `ctx.effect` disposer.
- VM failure (`movi r999, 5` → parse error) is a **successful domain outcome** with `error` set; only invalid args / spawn failures throw — exactly the contract's isError rule.
- Pure `render` / `presentationMeta` / `presentCall` / `presentResult` (terminal card), soft-validating on replay.
- Validated end-to-end against the **real published `defineTool`**: real schema compilation, real inference, real lifecycle assertions. 26/26 tests green; A/B runner produces saddle ledger entries with both arms agreeing on outcomes.

The embassy is intact: FLUX did not move. It still runs from its own repo; the plugin is a diplomatic phone line.

---

## 1. What DSH's plugin contract gets right — the steal list

Ranked by how much saddle should want it.

### 1.1 One canonical value, projections everywhere (STEAL THIS)
The single best idea in the contract: `execute()` returns **one canonical JSON value** validated against a declared schema; *everything else is a pure projection of it* — `render` (model-facing prose), `presentationMeta` (replayable UI card data), Code Mode callers get the value directly, and session-log replay re-derives the UI card from `(args, persisted meta)` without re-running anything. The hard rule "presenters are pure functions of args + result — NO I/O, NO clock, NO session state" is *enforceable by discipline and testable by replay*.

**Why saddle should care:** saddle's ledger judges model outcomes; pincher reacts in <50ms. Both consume tool results. A canonical-value + pure-projection seam would let saddle record one frozen value and re-render any view (ledger card, terminal, summary) forever after, from the log, with zero re-execution. This is the "model-visible means logged" invariant done right.

### 1.2 Registration is an effect; disposal is the unit of cleanup (STEAL THE SEMANTICS)
Every registration (`ctx.tools.register`, prompt sections, listeners) goes through `ctx.effect()`; unload/hot-reload unwinds them in order. There is no "unregister" API to forget — you *cannot* leak a registration, because it borrows the plugin fiber's lifetime. Compare: most harnesses (OpenClaw included) make teardown a manual discipline.

### 1.3 Args validated for you, cross-field checks stay yours (STEAL THE SPLIT)
`defineTool` compiles a small schema DSL (`string/number/integer/boolean/null/array/object/json/oneOf`, per-property `required: true`) into enforced JSON Schema and validates model-generated arguments *before* `execute` runs; the docs are explicit that the DSL does NOT express non-empty strings, positive numbers, or XOR fields — those stay hand-checked in the tool. The split is honest: structural validation centralized, semantic validation local. My `source XOR path` check is 12 lines and could not be simpler.

### 1.4 Orthogonal outcome reporting (STEAL THE RULE, VERBATIM)
From `defensive-patterns.md`: a process can time out AND exit 0; report `timedOut`, `signal`, `exitCode` independently, never nested in each other's branches. My `FluxRunOutcome` carries all of them flat, and it immediately paid off in tests: the SIGTERM-orphan bug (below) was *visible* precisely because the facts weren't folded into each other.

### 1.5 Dispatch modes are part of the event contract (STEAL THE TYPING)
Every typed event declares `emit | waterfall | parallel | serial` as part of its public contract — await-ness, ordering, and return-value-ness are checkable against dispatch sites, not folklore. Waterfall middleware (`(...args, next)`) with short-circuit for decisions is the same shape as Koa/saddle's own reflex chain — but pinning the mode on the declaration is the upgrade.

### 1.6 Capability seams as three mandatory roles
A seam = Service Definition + Provider + Consumer; "one role alone is not a seam." This prevents the classic failure where an interface exists but nothing consumes it through the seam (provider forks). Cheap rule, big architectural payoff — and it's why swapping one provider (fs → remote sandbox) legitimately moves Bash/PTY/LSP together.

### 1.7 Dead-agent guards, inject-not-wake, monotonic guards
Small jewels: `agent.inject()` appends durable context the NEXT request sees but is explicitly *not a wake-up* (idle agents stay idle — async state is not synchronous state); `ctx.tools.guard()` is a *monotonic* deny that later listeners cannot undo (permission can only tighten); `concludeTurn()` is monotonic too. Policy direction is a type. Steal the "monotonic policy" idea for pincher's gate chain.

---

## 2. What's worse — the do-not-steal list

### 2.1 The contract is HEAVY for small tools
One tool required me to internalize: `DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec>` with const generics, `InferArgs`/`InferValue`, `NoInfer`, soft-validation wrappers, render-intent unions (`generic|terminal|diff|search|read|web` cards), purity rules, and five lifecycle-sensitive hooks (`execute`, `finalizeContent`, `presentCall`, `presentResult`, `presentationMeta`). The `flux_exec` core is ~80 lines; contract-faithful presentation doubled it. For an ecosystem betting on "188k stars ⇒ thousands of plugin authors," this is a real tax. tool-bash — their own reference — pulls **12 peer packages**.

### 2.2 The schema DSL is a fourth schema language
Not JSON Schema, not Zod, not schemastery — its own subset with sharp edges I hit personally: union types must be `oneOf: [...]` (a type-*array* silently... no, loudly — but only at typecheck); requiredness is a per-property annotation (`required: true`), NOT a `required: [...]` list (JSON-Schema muscle memory produces all-optional outputs); object openness must be declared (`additionalProperties: boolean` mandatory). Every author pays the translation cost, and LLM agents writing tools will get this wrong constantly.

### 2.3 `latest` lies on npm (ecosystem footgun)
`@deepseek-ai/dsh-tools@latest` is `0.0.1-rc.1`; the current contract is only under the `next` dist-tag. Any plugin author following normal npm instincts gets a *different, older contract* than the docs describe. Pre-1.0 chaos, honestly labeled by DSH ("THERE WILL BE COMPATIBILITY-BREAKING CHANGES"), but it bit me within ten minutes.

### 2.4 Everything-in-process is an assumption, not a law
The whole design assumes the plugin is TypeScript in the same process as the harness ("A typed same-process contribution is not a serialization boundary"). My FLUX is Python — the honest mount is a subprocess bridge, which the contract accommodates but does not *serve*: no streaming stdio tool story (tool-bash's is bespoke through `ctx.jobs`), no host-language story beyond JS/TS. "Polyglot" in DSH's pitch remains aspirational; mounting an actually-polyglot runtime meant building my own bridge, my own env-scrubbing, my own process-group kills.

### 2.5 Pre-1.0 churn as a dependency
Four RCs in ten days; `peerDependencies` of `dsh-tools` pin nine sibling packages at exact RC versions. A plugin author's build breaks when ANY of ten packages cuts a new RC. Saddle would inherit this entire surface as a liability.

---

## 3. Cordis revertible-effects, in practice, when a plugin unloads

The paper calls it "temporal composability: fully reverting a plugin's side effects when it unloads." Here is what that actually means after building on it:

**What genuinely reverts, cleanly:**
- Tool registration, prompt sections, event listeners, config rows — anything registered through `ctx.effect`/`ctx.on`. Unload unwinds them in reverse order. This is real, mechanical, and I verified the shape in lifecycle tests: dispose the fiber, the tool vanishes from the registry, hot-swap (dispose + re-register) is the sanctioned upgrade path.
- Plugin-owned state with declared owners: my scratch dir dies with the disposer.

**What does NOT revert — and the docs are admirably honest about it:**
- **External side effects.** A subprocess FLUX ran, files a tool wrote, API calls made — Cordis can unregister the *tool*, but the *world* keeps what it produced. Revertibility is a property of the plugin tree, not of the universe. The honest mount must own its own blast-radius: my disposer kills in-flight children, but a completed execution's effects are permanent.
- **In-flight executions.** "Dispose must reach quiescence, not just request it" is a *defensive pattern* (i.e., a shipped bug class), not a framework guarantee. Live evidence from this very build: killing `sh -c "sleep 30"` with SIGTERM leaves the orphaned `sleep` holding the stdio pipe; the close event — and therefore quiescence — never arrives until you kill the **process group**. DSH's own answer is a dedicated `dsh-subprocess-local` package for managed groups; a plugin author who skips that lesson ships an unload that hangs or leaks. (My bridge: `detached: true` + `process.kill(-pid)` + SIGKILL escalation.)
- **The model's memory.** Tool results already logged to the session survive the plugin's unload; the model can still *talk about* flux_exec results after the tool is gone. Reverting a plugin does not revert the conversation — replay soft-validates presenters so an unloaded plugin's old cards still render (graceful), which is the pragmatic admission that full reversion is impossible.

**Net judgment:** revertible effects are excellent **dependency and registration hygiene** (the best I've used), marketed as **transactional execution** (which it is not). Saddle should steal the hygiene, and should not use the word "spatiotemporal" for either.

---

## 4. Honest friction log (what it cost to actually build this)

1. **npm `latest` ≠ `next`** (2.2.3 above): ERESOLVE within 10 minutes; fixed by reading the registry, not the docs.
2. **Schema DSL translation**: three typecheck rounds (type-array vs `oneOf`; `required` map vs per-property annotation; `{}`-typed `json` root needing an explicit `JsonValue` cast at the execute boundary).
3. **Presentation card vocabulary is large**: `kind` on a generic call card must be one of exactly `read|edit|delete|move|search|execute|fetch|other` — discoverable only by reading `presentation.ts` or failing typecheck.
4. **My own mock was wrong** (embarrassing, instructive): I implemented `ctx.effect(fn)` as "store fn, run it on dispose" — but Cordis semantics are "run fn on activation, fn RETURNS the disposer." My first scratch-cleanup test passed vacuously. The contract's *shape* (activation returns disposer) is load-bearing and non-obvious; a mock that gets it wrong silently tests nothing. Fixed; test now proves real disposal.
5. **SIGTERM orphan pipe-holding** (3 above): the single best bug of the weekend — turned a theoretical defensive pattern into a process-group kill requirement.
6. **FLUX-side bugs found through the seam** (not DSH's fault, recorded for SuperInstance): the open-interpreter's markdown fence parser mangles Python `return` tokens (`'ETURN'` literal in parse errors); assembly input silently compiles every opcode to `ISUB`; arbitrary garbage "succeeds" as a no-op (`ISUB R0,R0,R0; HALT` → success, result 0); `MOVI` is 16-bit signed so `factorial of 5000000` can't even parse. The `flux_exec` tool description I shipped leans on FLUX-ese natural language, which is the path that actually works.
7. **The published testkit lags a full RC generation**: `@deepseek-ai/dsh-agent-loop-testkit@0.0.1-rc.1` peers on 0.0.1-era packages — a 0.1.1-rc.2 plugin cannot exercise the REAL dispatch pipeline (pre-execute → execute → post-execute → result) without vendoring the whole monorepo. Core contract packages are current on npm; the testing story is not. My mock-context harness plus the real `defineTool` compilation is the best available middle ground, and its own bug (friction #4) shows exactly why pipeline-grade testing matters.
8. **No ambiguity ever required the prescribed Qwen3.6 consult** — and this subagent env has no DeepInfra key anyway (main-agent tooling). Recorded rather than papered over: the plugin was written against primary sources only.
7. **One capability is the right scope**: mounting all of FLUX (A2A opcodes, tiles, evolution tiers) would mean fighting the contract's presentation vocabulary for features the harness has no UI for. One tool, one canonical value, one card: the contract fits that exactly.

---

## 5. The A/B (ledger, not verdict)

`ab/runner.sh` produced 20 entries (`ab/out/ledger.jsonl`, schema in `ab/schema/ledger-entry.schema.json`): 5 tasks × 2 arms × 2 rounds, both arms agreeing on every outcome (factorial→120, parse-fail→false, both arms). First honest numbers:

- Direct CLI median: 64–76ms (Python interpreter startup dominates everything).
- Plugin-path median: 66–73ms — indistinguishable.
- Measured in-harness overhead (validation + scratch + projection, excluding child): **avg 0.6ms, max 1ms**.

So the plugin seam costs ~nothing at this scale; the question saddle's ledger must answer over a longer run is the *iteration* axis (schema changes, presenter rework, contract churn per RC), not per-call latency. Entries are stubbed for that; judgment deferred as instructed.

---

## 6. Verdict for saddle

**Steal (in priority order):**
1. Canonical-value + pure-projection result seam (1.1) — directly upgrades saddle ledger replay and pincher rendering.
2. Effect-scoped registration with activation-returns-disposer semantics (1.2) — including for saddle's frozen/nightcycle registrations.
3. Orthogonal outcome fields as a hard rule (1.4) — one-line change to the ledger entry schema, pays forever.
4. Dispatch-mode typing on events (1.5) and the monotonic policy direction (1.7).
5. The three-role seam definition rule (1.6) as a design-review checklist item.

**Do not steal:** the schema DSL (use JSON Schema or Zod as-is), the card render-intent union at its current size, the nine-package peer graph, and any dependency on DSH's RC cadence.

**Do not migrate:** confirmed by construction. The one thing DSH's ecosystem could give the fleet — distribution to 188k stargazers — is available *through this plugin* without moving anything. The embassy is the correct size for the relationship.

**If the pitch returns:** the falsifiable version is now cheap to run — extend `ab/runner.sh` rounds, point saddle's ledger at `ledger.jsonl`, judge on iteration cost. No re-architecture required, on either side.

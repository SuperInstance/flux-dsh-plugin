# Source Pins — flux-dsh-plugin

Every contract fact in this repo was read from these exact versions, fetched
**2026-08-23 (~15:10 AKDT)**. Nothing here was written from memory or blogs.

| Artifact | Pinned version | Where |
|---|---|---|
| DSH repo | tag `dsh-v0.1.1-rc.2` @ commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | tarball in `/tmp/dsh-study/dsh-src` (session-local) |
| `@deepseek-ai/dsh-tools` (npm) | `0.1.1-rc.2` (dist-tag `next`; `latest` is older `0.0.1-rc.1` — **do not use latest**) | registry.npmjs.org, verified 2026-08-23 |
| `@deepseek-ai/cordis` (npm) | published (vendored in DSH repo under `vendor/`) | registry.npmjs.org, verified 2026-08-23 |
| Key docs read | `docs/cookbook/adding-a-tool.md`, `docs/cookbook/extension-cookbook.md`, `docs/cordis-primer.md`, `docs/architecture.md`, `docs/defensive-patterns.md`, `docs/capability-seams.md`, `docs/testing.md` | from the pinned tarball; excerpts in `evidence/` |
| Reference tool impl | `packages/shell/tool-bash` (in pinned tarball) | read in full for layout + lifecycle patterns |
| FLUX runtime | local `flux-runtime` repo (Python impl, 2,037 tests); CLI `flux run-md <file> --json` → `{success,result,cycles,halted,registers,bytecode,disassembly,error}` via `src/flux/cli.py` `_cmd_run_md` | `/home/eileen/projects/flux-runtime` |

## Re-fetch procedure (if this outlives the weekend)

```sh
curl -sL https://api.github.com/repos/deepseek-ai/deepseek-harness/tarball/refs/tags/dsh-v0.1.1-rc.2 | tar xz
npm view @deepseek-ai/dsh-tools versions        # pin exactly, do NOT trust `latest`
```

DSH is pre-1.0 with **promised breaking changes** ("THERE WILL BE
COMPATIBILITY-BREAKING CHANGES", README). If `dsh-tools` publishes a new RC,
re-read `docs/cookbook/adding-a-tool.md` from the new tag before assuming this
plugin still typechecks. That is the cost of building on a 10-day-old preview,
stated up front.

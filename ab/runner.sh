#!/usr/bin/env bash
# A/B runner — embassy edition.
#
# Arm A (direct):     flux CLI invoked per task, no harness.
# Arm B (dsh-plugin): the SAME task through the flux_exec tool mounted on a
#                     minimal Cordis context (apply + defineTool contract).
#
# Produces ab/out/ledger.jsonl entries matching ab/schema/ledger-entry.schema.json.
# NO judgment here — saddle's ledger accumulates entries; the verdict comes later.
#
# Usage: ./ab/runner.sh [rounds=3]

set -euo pipefail
ROUNDS="${1:-3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/ab/out"
LEDGER="$OUT_DIR/ledger.jsonl"
FLUX_SRC="${FLUX_RUNTIME_SRC:-/home/eileen/projects/flux-runtime/src}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"

mkdir -p "$OUT_DIR"

node --experimental-strip-types --no-warnings "$ROOT/ab/arm-driver.mjs" \
  --rounds "$ROUNDS" --ledger "$LEDGER" --run-id "$RUN_ID" --flux-src "$FLUX_SRC"

echo "runId=$RUN_ID entries appended to $LEDGER"
echo "validate: python3 -c 'import json,sys;[json.loads(l) for l in open(sys.argv[1])]' $LEDGER && echo ledger-ok"

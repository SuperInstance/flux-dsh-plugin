#!/usr/bin/env python3
"""flux-parse — the compile cell's scoped expression.

Why this exists (HONEST GAP, see cellular/ARCHITECTURE.md §gaps): the
`flux compile` CLI subcommand of the pinned runtime (flux-runtime @
da771e6) emits an EMPTY module for md/python inputs (FluxCompiler.compile_md
→ compile_python returns header-only bytecode — verified 2026-08-26: 20
bytes, no code section) and broken register allocation for C. The proven
compile path is the OpenFluxInterpreter parser (the same engine behind
`flux run-md`, including the four SEAM-REPORT parser fixes).

This script exposes that parser as a parse-only subprocess: markdown in,
RAW bytecode file out. `flux run` accepts raw (header-less) bytecode
files as-is (cli._extract_code_section returns non-FLUX bytes unchanged),
so compile → run round-trips through two scoped expressions.

Usage: python3 flux-parse.py <in.md> <out.flux>
  stdout: "OK <nbytes>"           exit 0
  stderr: "ERROR <message>"       exit 1
"""
import os
import sys

sys.path.insert(0, os.environ.get("FLUX_RUNTIME_SRC", "/home/eileen/projects/flux-runtime/src"))

from flux.open_interpreter import OpenFluxInterpreter  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        print("ERROR usage: flux-parse.py <in.md> <out.flux>", file=sys.stderr)
        return 1
    src_path, out_path = sys.argv[1], sys.argv[2]
    try:
        source = open(src_path, encoding="utf-8").read()
    except OSError as exc:
        print(f"ERROR cannot read {src_path}: {exc}", file=sys.stderr)
        return 1
    try:
        bytecode = OpenFluxInterpreter()._parse_to_bytecode(source)
    except ValueError as exc:
        print(f"ERROR parse: {exc}", file=sys.stderr)
        return 1
    with open(out_path, "wb") as f:
        f.write(bytecode)
    print(f"OK {len(bytecode)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

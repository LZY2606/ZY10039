#!/bin/sh
# Unified release-shape verification for the UCAST workspace.
#
# Run from the repository root:
#   sh tools/verify.sh
#
# Prerequisite (once, not part of the demo):
#   pnpm install --frozen-lockfile
#
# Stages per package, in dependency topological order:
#   typecheck -> lint -> test -> build -> pack audit -> consumer ESM/CJS smoke
#
# The run is fully offline by default; nothing is published to any registry.
# Artifacts:
#   .verify/summary.json    machine-readable package-level summary
#   .verify/tarballs/       packed tarballs used for the consumer installs
#   .verify/logs/           raw stdout/stderr of every stage
#   .verify/consumers/      temporary consumer projects (removed on success)
#
# Escapes (not needed in CI):
#   UCAST_VERIFY_NETWORK=1    allow network access during pnpm operations
#   UCAST_VERIFY_KEEP_CONSUMERS=1  keep temporary consumer projects on disk
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

cd "$REPO_ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "verify: pnpm not found on PATH" >&2
  exit 127
fi
if ! command -v node >/dev/null 2>&1; then
  echo "verify: node not found on PATH" >&2
  exit 127
fi
if [ ! -d node_modules ]; then
  echo "verify: node_modules missing; run 'pnpm install --frozen-lockfile' first" >&2
  exit 2
fi

exec node tools/verify/verify.mjs

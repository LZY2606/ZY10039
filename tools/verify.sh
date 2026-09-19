#!/bin/sh
# Unified release-form verification entry point for the UCAST workspace.
#
# Usage (from repository root):
#   sh tools/verify.sh              full verify: graph -> typecheck/lint/test/build -> pack/audit -> offline consumer
#   sh tools/verify.sh --replay     offline replay: reinstall the already-built tarballs into the consumer
#   sh tools/verify.sh --keep       keep .verify contents instead of recreating them (full run only)
#
# This script never publishes to a registry and never downloads anything while
# verifying: all package artifacts come from local builds and all installs use
# local tarballs + the pnpm store populated by `pnpm install --frozen-lockfile`.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "verify: node is required but was not found in PATH" >&2
  exit 127
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "verify: pnpm is required but was not found in PATH" >&2
  exit 127
fi
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "verify: dependencies are not installed." >&2
  echo "verify: run 'pnpm install --frozen-lockfile' once (that step is outside replay/offline boundaries)." >&2
  exit 65
fi

VERIFY_ROOT="$REPO_ROOT" node "$SCRIPT_DIR/verify/verify.mjs" "$@"

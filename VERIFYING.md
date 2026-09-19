# Verifying the workspace in release form

`tools/verify.sh` is the single entry point that proves the whole UCAST
workspace is consumable *as it would be published*. It discovers the workspace
from `pnpm-workspace.yaml` (the package set is never hard-coded), executes the
package stages in dependency order, packs every package with `pnpm pack`
(nothing is ever published), audits the tarballs, and installs those tarballs
into a throwaway consumer project whose ESM and CommonJS entry points are then
probed.

## Prerequisites

One preparation step is required, and it is intentionally *not* part of
verification:

```sh
pnpm install --frozen-lockfile
```

It populates the pnpm content-addressable store and the root `node_modules`.
After that step every verification operation runs offline.

```sh
sh tools/verify.sh              # full verify (graph -> stages -> pack/audit -> consumer)
sh tools/verify.sh --replay     # offline replay: reinstall existing tarballs and re-probe
sh tools/verify.sh --keep       # keep the .verify workspace instead of recreating it
```

Run the command from the repository root (the script relocates itself, so it
also works from other directories). Exit code `0` means success; a failing
package stage exits with the **original failing command's exit code**, while
preflight problems (cycles, missing workspace dependencies, broken exports)
exit with code `65` before any build runs.

## Dependency graph and topological execution

The graph is built from each package's `dependencies` entries that use the
`workspace:` protocol. With the current packages it resolves to:

```
@ucast/core
  ├── @ucast/js ──────────────┐
  ├── @ucast/mongo ───────────┤
  │                           ├── @ucast/mongo2js
  └── @ucast/sql              │
      (./mikro-orm, ./objection, ./sequelize, ./typeorm subpaths)
```

Topological order:

```
@ucast/core -> @ucast/js -> @ucast/mongo -> @ucast/mongo2js -> @ucast/sql
```

The order is an *input* to the stages, not a fixed list: adding a package under
`packages/*` and a `workspace:*` edge is picked up automatically. For each
package in topological order the verifier runs:

1. `typecheck` — `tsc --noEmit`
2. `lint` — the package's `lint` script
3. `test` — the package's `test` script
4. `build` — the package's `build` script (`NODE_ENV=production`)

A package resolves its internal dependencies through their built `dist/`
(declared via their `exports` map), so every dependency must have passed all
four stages before a dependent starts; a failure skips the remaining packages
instead of producing cascading type errors. Results for completed packages are
still recorded and printed.

### Preflight diagnostics

Before running anything, the verifier checks:

- **Dependency cycles** — every cycle is printed as an edge path
  (`DEPENDENCY_CYCLE`).
- **Missing workspace dependencies** — a `workspace:*` specifier with no
  matching workspace package (`MISSING_WORKSPACE_DEP`).
- **Exports without a backing source** — every `exports` target
  (`types`/`import`/`require`) is mapped back to its source entry
  (`dist/<format>/x.*` -> `src/x.ts`); a missing source entry fails as
  `EXPORTS_NO_SOURCE`. After the build, the same targets are checked against
  the actual tarball contents.

## Packing and tarball audit

Each package is packed with `pnpm pack`, which also performs the publish-time
rewrite of `workspace:*` ranges into concrete versions (e.g. `@ucast/core`
`workspace:*` -> `2.0.0`). Tarballs land in `.verify/tarballs/`. Every tarball
is unpacked and audited so that:

- it contains no `spec/`, `coverage/`, `.nyc_output/`, `*.spec.*` files,
  tsbuildinfo files, or temporary tool configuration;
- every sourcemap `sources`/`sourcesContent` entry is relative — no absolute
  machine paths (`/Users/...`, `/home/...`, the workspace root) leak into
  published maps;
- every file referenced by the package `exports` map is actually present.

The verifier never calls `pnpm publish` or any registry-writing command.

## Offline boundary and temporary consumer

The consumer project is generated at `.verify/consumer/` and is isolated from
the UCAST workspace with its own empty `pnpm-workspace.yaml`. Its
`pnpm-lock.yaml` is synthesized from the root lockfile:

- every `@ucast/*` dependency is a `file:../tarballs/<name>-<version>.tgz`
  specifier (including transitive `@ucast/*` edges, which are rewritten to the
  same local tarballs);
- the integration peers needed to import optional export subpaths
  (`@ucast/sql`'s `typeorm`/`objection`/`sequelize`/`@mikro-orm/core` entries)
  are discovered from the packed tarballs' own `peerDependencies` (plus the
  SQLite drivers the locked ORM snapshots require) and copied verbatim from the
  root lockfile, so the exact same artifacts the workspace uses get installed
  with no package names hard-coded in the verifier;
- installation is `pnpm install --frozen-lockfile --offline`. There is no
  registry resolution and no fallback download; a missing store entry fails the
  stage instead of silently fetching anything.

`--replay` repeats only this boundary: it reinstalls the existing tarballs
offline and re-runs the probes, which is useful for reproducing a consumer-side
issue without rebuilding.

## ESM and CommonJS export probes

For every package and every export subpath two probe scripts are generated and
executed against the installed consumer:

- an ESM dynamic `import('<pkg>[ /<subpath>]')`;
- a CommonJS `require('<pkg>[ /<subpath>]')`.

A case passes only when the specifier both resolves and loads to a module
namespace/object. With the current packages that is 9 export subpaths and 18
runtime cases (the four `@ucast/sql` integration subpaths are included). In
addition a single TypeScript `--noEmit` compile imports every specifier with
`import type`, exercising each package's `types` export condition against the
installed tarballs (9 declaration resolutions, reported per package).

## Outputs and CI

- Console output shows the topological order, the per-package stages, every
  pack/audit result, and every ESM/CJS probe.
- `.verify/summary.json` is a machine-readable per-package summary
  (stages, pack audit, consumer probes) and is written even when a stage fails,
  so CI can persist it via `if: always()`. CI itself only invokes
  `sh tools/verify.sh`.
- All generated state lives under `.verify/` (ignored by git). Repeated runs do
  not modify `package.json` files, `pnpm-lock.yaml`, or anything outside
  `dist/` and `.verify/`. Every verifier subprocess inherits
  `npm_config_frozen_lockfile=true`, so even adding a new package under
  `packages/*` can never make verification silently rewrite the lockfile, and
  the consumer's `pnpm-workspace.yaml` resets `minimumReleaseAge: 0` so no
  registry metadata is fetched for the release-age supply-chain policy.

The Node tooling under `tools/verify/` is itself linted with
`npx eslint -c tools/verify/eslint.config.mjs tools/verify` (Node globals); it
is excluded from the browser/mocha-flavoured root ESLint configuration.

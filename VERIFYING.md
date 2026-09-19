# Verifying the workspace

`sh tools/verify.sh` is the single entry point that proves the workspace is
consumable in its **published shape** — built artifacts inside real tarballs,
installed into throwaway projects and loaded through both module systems.

CI (`.github/workflows/main.yml`) calls only this entry point and uploads
`.verify/summary.json` plus the per-stage logs as an artifact, even when a
stage fails.

## One-time preparation

```sh
pnpm install --frozen-lockfile
```

This step is intentionally **not** part of the verification demo: it populates
the local pnpm content-addressable store and `node_modules/.pnpm` virtual
store that the offline replay relies on.

## Running

```sh
sh tools/verify.sh
```

The command must be started from the repository root (the script relocates
itself, but running it from anywhere inside the repo works too). It prints the
dependency graph, a topological order, one banner per package and stage, and a
final package-level summary. Exit code is `0` on success; on failure it is the
original failing command's exit code (or `2` for pre-build diagnostics, `3`
for worktree guard violations). Nothing is swallowed: full stdout/stderr of
every stage is streamed to the terminal and saved under `.verify/logs/`.

## Dependency graph

Workspace packages are discovered from `pnpm-workspace.yaml` (not hard-coded).
Edges come from every `workspace:` specifier in `dependencies`,
`devDependencies`, and `peerDependencies`.

Today the graph is:

```
@ucast/core                     (no workspace dependencies)
@ucast/js          -> @ucast/core
@ucast/mongo       -> @ucast/core
@ucast/sql         -> @ucast/core
@ucast/mongo2js    -> @ucast/core, @ucast/js, @ucast/mongo
```

Topological order used by the demo:

```
@ucast/core -> @ucast/js -> @ucast/mongo -> @ucast/mongo2js -> @ucast/sql
```

Ties are broken alphabetically, so adding, removing, or renaming packages
never requires touching the verifier.

Before any build starts the verifier fails fast with explicit diagnostics for:

- **dependency cycles** — the full cycle path is printed;
- **missing workspace dependencies** — a `workspace:` specifier that does not
  resolve to a discovered workspace package;
- **broken `exports`** — every `types`/`import`/`require` target is mapped
  back to its expected source file (`./dist/<esm|cjs|types>/<x>.<ext>` ->
  `src/<x>.ts`) and checked for existence; legacy `main`/`module`/`typings`
  layout is checked the same way.

## Stages (per package, in topological order)

```
typecheck -> lint -> test -> build -> pack audit -> consumer smoke
```

- `typecheck` runs `tsc --noEmit` against the package's own tsconfig.
- `lint` and `test` are the package's existing scripts.
- `build` is the package's existing build script. After it finishes, every
  `exports` target is re-checked against the files that were actually emitted.
- `pack audit` runs `pnpm pack` into `.verify/tarballs/` and rejects the
  tarball if:
  - any `exports`/`main`/`module`/`typings` target is missing from it;
  - it contains `spec/`, `*.spec.*`, `coverage/`, `.nyc_output/`, logs,
    tsconfig files, mocha caches, or other temporary configuration;
  - a source map exposes an **absolute path** (anything absolute, the repo
    root, a home directory, or a Windows drive prefix) or references a spec
    source.
- `consumer smoke` is described below.

## Offline boundary

After the one-time frozen install, the run is offline by default:

- all package commands run as-is (tests are hermetic; the SQL e2e specs use
  embedded SQLite via `better-sqlite3`/`sqlite3`, no external service is
  required);
- every consumer install uses `pnpm install --offline`;
- workspace package names are pinned to local tarball paths through
  `pnpm.overrides` in a generated, per-consumer `pnpm-workspace.yaml`, so
  pnpm never asks a registry for `@ucast/*` metadata;
- each consumer reuses the workspace virtual store: `node_modules/.pnpm` is
  symlinked to the workspace's `.pnpm` (which keeps transitive versions
  identical to the lockfile and prevents offline version floating), while a
  separate `--virtual-store-dir` makes sure pnpm's extraneous-package cleanup
  can never mutate the workspace store;
- peer packages needed to load optional subpaths (`objection`, `sequelize`,
  `typeorm`, `@mikro-orm/core` for `@ucast/sql`) are pinned to the exact
  versions already installed in the workspace, discovered by resolving the
  package from the package being verified.

There is no publish step anywhere. `pnpm pack` only writes tarballs to
`.verify/tarballs/`. Set `UCAST_VERIFY_NETWORK=1` only if you deliberately
want to opt out of the offline boundary; CI never sets it.

## Temporary consumer verification

For each package, a fresh private project is created under
`.verify/consumers/<package>/`:

1. its own dependency is the locally packed tarball;
2. transitive `@ucast/*` deps resolve to tarballs of the packages already
   built earlier in topological order;
3. required peers are installed at their workspace-pinned versions;
4. `probe.cjs` and `probe.mjs` load **every** key of the package's `exports`
   (`.` plus each subpath, e.g. `@ucast/sql/objection`) via `require` and
   dynamic `import`, asserting the namespace is non-empty and recording up to
   eight exported names per subpath.

Consumer directories are removed on success and retained on failure for
inspection (`UCAST_VERIFY_KEEP_CONSUMERS=1` keeps them always).

## Idempotency and worktree guard

Repeated runs do not modify `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
or any other controlled file. The verifier snapshots `git status` before the
pipeline and fails with exit code `3` if a new change appears anywhere outside
`.verify/` (package `dist/` directories are ignored build output). All
verification state lives under `.verify/`, which is git-ignored:

```
.verify/summary.json     machine-readable package-level summary
.verify/tarballs/        packed tarballs consumed by the smoke projects
.verify/logs/            raw command output, one file per package/stage
.verify/consumers/       temporary consumer projects
```

## Example output

```
── Dependency graph ────────────────────────────────────────────────────
  @ucast/core → ∅
  @ucast/js → @ucast/core
  @ucast/mongo → @ucast/core
  @ucast/mongo2js → @ucast/core, @ucast/js, @ucast/mongo
  @ucast/sql → @ucast/core
topological order: @ucast/core  →  @ucast/js  →  @ucast/mongo  →  @ucast/mongo2js  →  @ucast/sql

── @ucast/sql  [5/5] ───────────────────────────────────────────────────
▶ Typecheck: pnpm exec tsc --noEmit -p tsconfig.json
✓ Typecheck (…)
✓ Lint (…)
✓ Test (…)
✓ Build (…)
✓ Pack audit (…)
✓ pack audit: 35 files, clean source maps
✓ exports probe cjs @ucast/sql → Query, allInterpreters, and, …
✓ exports probe cjs @ucast/sql/mikro-orm → createInterpreter, getRelationMetadata, interpret
✓ exports probe esm @ucast/sql/sequelize → createInterpreter, getRelationMetadata, interpret
…
── Verification passed ─────────────────────────────────────────────────
all 5 package(s): typecheck, lint, test, build, pack audit, ESM+CJS consumers
```

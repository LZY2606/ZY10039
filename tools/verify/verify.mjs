import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { loadYaml } from './lib-yaml.mjs';
import { graphReport, readJson } from './graph.mjs';
import { synthesizeConsumerLock } from './consumer.mjs';

const root = resolve(process.env.VERIFY_ROOT ?? process.cwd());
const workDir = join(root, '.verify');
const tarballDir = join(workDir, 'tarballs');
const consumerDir = join(workDir, 'consumer');
const probesDir = join(consumerDir, 'probes');
const summaryPath = join(workDir, 'summary.json');

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const replay = argv.includes('--replay');
const PREFLIGHT_EXIT = 65;

const paint = process.stdout.isTTY && process.env.NO_COLOR == null;
const c = (code, s) => (paint ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = s => c(2, s);
const red = s => c(31, s);
const green = s => c(32, s);
const bold = s => c(1, s);
const yellow = s => c(33, s);

const log = msg => console.log(msg);
const section = name => log(`\n${bold(`▶ ${name}`)}`);

const STAGES = ['typecheck', 'lint', 'test', 'build'];
const results = new Map();
let firstFailure = null;

function ensureResult(name) {
  if (!results.has(name)) results.set(name, { name, stages: {}, pack: null, consumer: null });
  return results.get(name);
}
function fail(name, stage, code) {
  if (!firstFailure) firstFailure = { pkg: name, stage, code };
}
function runProcess(bin, args, opts = {}) {
  const env = {
    ...process.env,
    // Never touch the root lockfile or registry during verification.
    npm_config_frozen_lockfile: 'true',
    npm_config_prefer_offline: 'true',
    ...(opts.env ?? {}),
  };
  const res = spawnSync(bin, args, {
    cwd: opts.cwd ?? root,
    encoding: 'utf8',
    env,
  });
  return {
    code: res.status ?? (res.error ? 127 : 1),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? String(res.error?.message ?? ''),
  };
}
function tail(text, n = 50) {
  return text.split('\n').filter(l => l.length).slice(-n).join('\n');
}

// ---------- preflight ----------
const yaml = await loadYaml(root);
const report = graphReport(root, yaml);
const byName = report.graph.byName;

section('Preflight: dependency graph + exports');
log(`Discovered ${report.packages.length} workspace package(s) from pnpm-workspace.yaml`);
log(`Topological order: ${bold(report.order.join(' -> '))}`);
for (const entry of report.packages) {
  const deps = report.graph.adj.get(entry.name) ?? [];
  log(`  ${dim(entry.relDir.padEnd(18))} ${entry.name}${deps.length ? `  <- ${deps.join(', ')}` : '  (root of graph)'}`);
}
const subpathsOf = p => new Set(p.targets.map(t => t.subpath)).size;
log(`Exports probes planned: ${report.probes.reduce((n, p) => n + subpathsOf(p), 0)} subpath(s), ${report.probes.reduce((n, p) => n + p.targets.length, 0)} condition target(s)`);

const preflightErrors = [];
for (const m of report.graph.missing) {
  preflightErrors.push(`MISSING_WORKSPACE_DEP: ${m.pkg} depends on "${m.missing}" (workspace:*) but no workspace package has that name`);
}
for (const cycle of report.cycles) {
  preflightErrors.push(`DEPENDENCY_CYCLE: ${cycle.join(' -> ')}`);
}
for (const p of report.exportProblems) {
  preflightErrors.push(`${p.code}: ${p.message}`);
}
if (preflightErrors.length) {
  log(red('\nPreflight failed before any build started:'));
  for (const e of preflightErrors) log(`  x ${e}`);
  process.exit(PREFLIGHT_EXIT);
}
log(green('Preflight OK (graph acyclic, workspace deps resolvable, export sources present)'));

// ---------- stages ----------
const STAGE_COMMANDS = {
  typecheck: ['pnpm', 'exec', 'tsc', '--noEmit'],
  lint: ['pnpm', 'run', '--silent', 'lint'],
  test: ['pnpm', 'run', '--silent', 'test'],
  build: ['pnpm', 'run', '--silent', 'build'],
};

function runPackageStage(entry, stage) {
  const r = ensureResult(entry.name);
  const cmd = STAGE_COMMANDS[stage];
  process.stdout.write(`  - ${dim(`${entry.name} :: ${stage.padEnd(10)}`)}`);
  const res = runProcess(cmd[0], cmd.slice(1), {
    cwd: entry.dir,
    env: stage === 'build' ? { NODE_ENV: 'production' } : {},
  });
  if (res.code === 0) {
    console.log(green(' PASS'));
    r.stages[stage] = { status: 'pass', code: 0 };
    return true;
  }
  console.log(red(` FAIL (exit ${res.code})`));
  r.stages[stage] = { status: 'fail', code: res.code, log: tail(`${res.stdout}\n${res.stderr}`) };
  log(`      ${dim(`$ ${cmd.join(' ')}  (in ${entry.relDir})`)}`);
  log(tail(`${res.stdout}\n${res.stderr}`, 30).split('\n').map(l => `      ${l}`).join('\n'));
  fail(entry.name, stage, res.code);
  return false;
}

if (!replay) {
  if (!keep) {
    rmSync(workDir, { recursive: true, force: true });
  }
  mkdirSync(tarballDir, { recursive: true });

  // Stages follow the dependency graph: for each package in topological order
  // we run typecheck -> lint -> test -> build. A package consumes its
  // dependencies through the built dist/ referenced by their exports map, so
  // every dependency must have completed all four stages first.
  section('Stages: typecheck -> lint -> test -> build (topological order)');
  for (const name of report.order) {
    const entry = byName.get(name);
    const r = ensureResult(name);
    const blockedDeps = (report.graph.adj.get(name) ?? [])
      .filter(dep => results.get(dep)?.stages.build?.status !== 'pass');
    if (blockedDeps.length || firstFailure) {
      for (const stage of STAGES) r.stages[stage] = { status: 'skip', code: null };
      log(`  ${yellow('skip')} ${dim(name)} (upstream package did not verify: ${blockedDeps.join(', ') || firstFailure?.pkg})`);
      continue;
    }
    log(`  ${bold(`[${name}]`)} ${dim('(in ' + entry.relDir + ')')}`);
    for (const stage of STAGES) {
      if (!runPackageStage(entry, stage)) break;
    }
    if (r.stages.build?.status !== 'pass' && !firstFailure) {
      const failedStage = STAGES.find(stage => r.stages[stage]?.status === 'fail');
      if (failedStage) fail(name, failedStage, r.stages[failedStage].code);
    }
  }
} else {
  section('Replay: reusing tarballs, running offline consumer install + probes');
  if (!existsSync(join(consumerDir, 'pnpm-lock.yaml'))) {
    log(red('Replay requested but .verify/consumer/pnpm-lock.yaml does not exist. Run a full verify first.'));
    process.exit(PREFLIGHT_EXIT);
  }
}

const anyStageFailed = STAGES.some(stage =>
  report.order.some(n => results.get(n)?.stages[stage]?.status === 'fail'));


// ---------- pack + audit ----------
const FORBIDDEN_PATTERNS = [
  [/(^|\/)spec\//, 'spec/ directory'],
  [/(^|\/)coverage\//, 'coverage/ directory'],
  [/(^|\/)\.nyc_output\//, '.nyc_output/ directory'],
  [/\.spec\.[cm]?[jt]s$/, 'spec file'],
  [/\.tsbuildinfo$/, 'tsbuildinfo'],
  [/(^|\/)(mocharc|\.mocharc)/, 'temporary test configuration'],
  [/(^|\/)eslint\.config\./, 'eslint configuration'],
  [/(^|\/)tsconfig/, 'tsconfig file'],
];

function auditTarball(entry, tarPath) {
  const listed = runProcess('tar', ['-tzf', tarPath]).stdout.split('\n').filter(Boolean);
  const violations = [];
  for (const line of listed) {
    const inside = line.replace(/^package\//, '');
    for (const [pattern, label] of FORBIDDEN_PATTERNS) {
      if (pattern.test(inside)) violations.push(`${label} shipped in tarball: ${inside}`);
    }
  }
  const extractDir = join(workDir, 'audit', entry.name.replace(/^@/, '').replace('/', '__'));
  mkdirSync(extractDir, { recursive: true });
  const unpack = runProcess('tar', ['-xzf', tarPath, '-C', extractDir]);
  if (unpack.code !== 0) violations.push(`tarball could not be extracted: ${tail(unpack.stderr, 5)}`);
  for (const mapRel of listed.filter(l => l.endsWith('.map'))) {
    const abs = join(extractDir, mapRel);
    if (!existsSync(abs)) continue;
    let map;
    try {
      map = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      violations.push(`invalid JSON sourcemap: ${mapRel}`);
      continue;
    }
    for (const src of map.sources ?? []) {
      if (/^([/\\]|[A-Za-z]:[\\/])/.test(src) || src.startsWith(workDir)) {
        violations.push(`absolute path in sourcemap ${mapRel}: ${src}`);
      }
    }
    for (const content of map.sourcesContent ?? []) {
      if (typeof content === 'string' && /\/(Users|home|private)\//.test(content)) {
        violations.push(`absolute path embedded in sourcemap sourcesContent: ${mapRel}`);
      }
    }
  }
  const planned = report.probes.find(p => p.name === entry.name);
  for (const t of planned.targets) {
    const inside = `package/${t.target.replace(/^\.\//, '')}`;
    if (!listed.includes(inside)) {
      violations.push(`exports "${t.subpath}" [${t.condition ?? 'default'}] -> ${t.target} missing from tarball`);
    }
  }
  return { violations, fileCount: listed.length, listed };
}

const packed = [];
function runPackStage() {
  section('Stage: pack (pnpm pack; nothing is published) + tarball audit');
  for (const name of report.order) {
    const entry = byName.get(name);
    const r = ensureResult(name);
    if (firstFailure) {
      r.pack = { status: 'skip', code: null };
      continue;
    }
    if (r.stages.build?.status !== 'pass') {
      log(`  - ${dim(`${name} :: pack       `)} ${yellow('SKIP (build did not pass)')}`);
      r.pack = { status: 'skip', code: null };
      continue;
    }
    process.stdout.write(`  - ${dim(`${name} :: pack       `)}`);
    const pack = runProcess('pnpm', ['pack', '--pack-destination', tarballDir], { cwd: entry.dir });
    const expected = `${name.replace('@', '').replace('/', '-')}-${entry.version}.tgz`;
    const tarPath = join(tarballDir, expected);
    if (pack.code !== 0 || !existsSync(tarPath)) {
      console.log(red(` FAIL (exit ${pack.code})`));
      log(tail(`${pack.stdout}\n${pack.stderr}`, 30));
      r.pack = { status: 'fail', code: pack.code };
      fail(name, 'pack', pack.code);
      break;
    }
    const { violations, fileCount } = auditTarball(entry, tarPath);
    if (violations.length) {
      console.log(red(` FAIL (${violations.length} audit finding(s))`));
      for (const v of violations) log(`      x ${v}`);
      r.pack = { status: 'fail', code: 1, violations, fileCount };
      fail(name, 'pack', 1);
      break;
    }
    console.log(green(` PASS (${fileCount} files, exports & sourcemaps audited)`));
    r.pack = { status: 'pass', code: 0, fileCount, tarball: relative(root, tarPath) };
    packed.push({
      name,
      version: entry.version,
      path: tarPath,
      dependencies: Object.entries(entry.pkg.dependencies ?? {})
        .filter(([, spec]) => String(spec).startsWith('workspace:'))
        .map(([dep]) => dep),
    });
  }
}
if (!replay && !firstFailure && !anyStageFailed) runPackStage();

// ---------- consumer project ----------
// Native SQLite drivers are not peer dependencies of any package, but the
// locked ORM snapshots reference them; they are added on top of the peers
// discovered from the packed tarballs so the frozen offline install graph is
// complete.
const CONSUMER_EXTRA_DEPS = ['better-sqlite3', 'sqlite3', 'knex', 'reflect-metadata', '@mikro-orm/sqlite'];

function thirdPartyFor(tarballsMeta) {
  const names = new Set(CONSUMER_EXTRA_DEPS);
  for (const meta of tarballsMeta) {
    for (const [name, { optional = false } = {}] of Object.entries(meta.peerDependenciesMeta ?? {})) {
      if (optional) names.add(name);
    }
    for (const name of Object.keys(meta.peerDependencies ?? {})) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function discoverProbes() {
  // One probe per package per module system per export subpath.
  const probes = [];
  for (const name of report.order) {
    const planned = report.probes.find(p => p.name === name);
    for (const subpath of [...new Set(planned.targets.map(t => t.subpath))]) {
      probes.push({ name, subpath });
    }
  }
  return probes;
}

function generateConsumer() {
  section('Stage: create temporary release consumer');
  mkdirSync(consumerDir, { recursive: true });
  const tarballs = report.order
    .filter(n => results.get(n)?.pack?.status === 'pass')
    .map(name => {
      const entry = byName.get(name);
      return {
        name,
        version: entry.version,
        path: join(tarballDir, `${name.replace('@', '').replace('/', '-')}-${entry.version}.tgz`),
        dependencies: Object.entries(entry.pkg.dependencies ?? {})
          .filter(([, spec]) => String(spec).startsWith('workspace:'))
          .map(([dep]) => dep),
      };
    });
  if (tarballs.length !== report.order.length) {
    throw new Error('Internal error: not all packages were packed before consumer generation');
  }
  const tarballsMeta = tarballs.map(t => readJson(join(byName.get(t.name).dir, 'package.json')));
  const thirdParty = thirdPartyFor(tarballsMeta);
  log(`  optional integration peers installed from store: ${dim(thirdParty.join(', '))}`);
  const rootLock = yaml.parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const { lockfile } = synthesizeConsumerLock({
    rootLock,
    consumerDir,
    tarballs,
    thirdParty,
  });
  const dependencies = Object.fromEntries(
    Object.entries(lockfile.importers['.'].dependencies).map(([name, entry]) => [name, entry.specifier]),
  );
  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'ucast-release-consumer',
    private: true,
    version: '0.0.0',
    dependencies,
  }, null, 2) + '\n');
  // Isolate the consumer from the enclosing UCAST pnpm workspace, otherwise
  // pnpm treats it as an unrelated directory of the outer workspace and skips
  // linking its dependencies entirely. Mirror the workspace build-script
  // allow-list so the SQLite native bindings used by the ORM integration
  // subpaths can be rebuilt strictly from the local store.
  const rootWs = yaml.parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
  const consumerWs = {
    packages: [],
    // The release-age supply-chain policy requires live registry metadata and is
    // meaningless for local file: tarballs; drop it so the install is truly
    // offline. Build-script approvals are kept so native SQLite bindings can be
    // rebuilt from the store.
    minimumReleaseAge: 0,
  };
  if (rootWs.allowBuilds) consumerWs.allowBuilds = rootWs.allowBuilds;
  if (rootWs.onlyBuiltDependencies) consumerWs.onlyBuiltDependencies = rootWs.onlyBuiltDependencies;
  writeFileSync(join(consumerDir, 'pnpm-workspace.yaml'), yaml.stringify(consumerWs));
  writeFileSync(join(consumerDir, 'pnpm-lock.yaml'), yaml.stringify(lockfile));
  log(`  consumer project: ${dim(relative(root, consumerDir))} (${tarballs.length} tarballs pinned via file: specifiers)`);
  return tarballs;
}

function installConsumer() {
  section('Stage: install tarballs into consumer (offline, frozen synthesized lockfile)');
  const args = ['install', '--frozen-lockfile', '--offline'];
  const res = runProcess('pnpm', args, { cwd: consumerDir });
  if (res.code !== 0) {
    log(red(`  pnpm ${args.join(' ')} failed with exit ${res.code}`));
    log(tail(`${res.stdout}\n${res.stderr}`, 60).split('\n').map(l => `    ${l}`).join('\n'));
    for (const name of report.order) {
      ensureResult(name).consumer = { status: 'fail', code: res.code, phase: 'install' };
    }
    fail('@ucast/release-consumer', 'consumer-install', res.code);
    return false;
  }
  log(green('  Offline install succeeded (frozen synthesized lockfile, no registry access)'));
  return true;
}

function probeSpec() {
  // module -> template given { specifier }
  return {
    esm: spec => `import(${JSON.stringify(spec)}).then(m => {\n`
      + `  if (!m || (typeof m !== 'object' && typeof m !== 'function')) throw new Error('no module namespace');\n`
      + `  console.log('esm-ok', ${JSON.stringify(spec)});\n`
      + `}).catch(err => { console.error(err); process.exit(1); });\n`,
    cjs: spec => `const m = require(${JSON.stringify(spec)});\n`
      + `if (!m || (typeof m !== 'object' && typeof m !== 'function')) throw new Error('no exports');\n`
      + `console.log('cjs-ok', ${JSON.stringify(spec)});\n`,
  };
}

function runProbes() {
  section('Stage: ESM + CommonJS exports probes (against installed tarballs)');
  rmSync(probesDir, { recursive: true, force: true });
  mkdirSync(probesDir, { recursive: true });
  const templates = probeSpec();
  const probes = discoverProbes();
  const caseNames = [];
  for (const { name, subpath } of probes) {
    const suffix = subpath === '.' ? '' : '/' + subpath.replace(/^\.\//, '');
    const specifier = name + suffix;
    for (const kind of ['esm', 'cjs']) {
      const safe = `${kind}-${name.replace('@', '').replace('/', '__')}-${(subpath === '.' ? 'root' : subpath.replace(/^\.\//, '').replace(/\//g, '__'))}`;
      const ext = kind === 'esm' ? 'mjs' : 'cjs';
      const file = join(probesDir, `${safe}.${ext}`);
      writeFileSync(file, templates[kind](specifier));
      caseNames.push({ name, subpath, kind, file, specifier });
    }
  }
  log(`  ${caseNames.length} runtime probe case(s) + 1 declaration-resolution compile across ${probes.length} export subpath(s)`);

  // TypeScript probe: one noEmit compile that imports every specifier, forcing
  // resolution of each package's "types" export condition from the tarball.
  const typeEntry = probes.map(({ name, subpath }) => {
    const suffix = subpath === '.' ? '' : '/' + subpath.replace(/^\.\//, '');
    return `import type * as _${name.replace(/[^a-zA-Z0-9]/g, '')}${suffix.replace(/[^a-zA-Z0-9]/g, '_')} from ${JSON.stringify(name + suffix)};`;
  }).join('\n') + '\nexport {};\n';
  const typeFile = join(probesDir, 'type-imports.ts');
  writeFileSync(typeFile, typeEntry);
  writeFileSync(join(probesDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    files: ['type-imports.ts'],
  }, null, 2) + '\n');
  const byPkg = new Map(report.order.map(n => [n, { esm: null, cjs: null, cases: [] }]));
  for (const item of caseNames) {
    const res = runProcess(process.execPath, [item.file], { cwd: probesDir });
    const label = `${item.name}${item.subpath === '.' ? '' : '/' + item.subpath.replace(/^\.\//, '')} [${item.kind.toUpperCase()}]`;
    const ok = res.code === 0;
    process.stdout.write(`  - ${dim(label.padEnd(42))}`);
    if (ok) {
      console.log(green(' RESOLVES + LOADS'));
    } else {
      console.log(red(` FAIL (exit ${res.code})`));
      log(tail(`${res.stdout}\n${res.stderr}`, 15).split('\n').map(l => `      ${l}`).join('\n'));
    }
    const agg = byPkg.get(item.name);
    agg.cases.push({ subpath: item.subpath, kind: item.kind, status: ok ? 'pass' : 'fail', code: res.code });
    if (!ok && agg[item.kind] !== 'fail') agg[item.kind] = 'fail';
    if (ok && agg[item.kind] == null) agg[item.kind] = 'pass';
  }
  process.stdout.write(`  - ${dim('TypeScript declarations [types]'.padEnd(42))}`);
  const tscBin = join(root, 'node_modules/typescript/bin/tsc');
  const typeRes = existsSync(tscBin)
    ? runProcess(process.execPath, [tscBin, '-p', join(probesDir, 'tsconfig.json')], { cwd: consumerDir })
    : { code: 127, stdout: '', stderr: 'workspace typescript is not installed' };
  const typeProbeByPkg = new Map();
  if (typeRes.code === 0) {
    console.log(green(' RESOLVES'));
    for (const { name } of probes) typeProbeByPkg.set(name, 'pass');
  } else {
    console.log(red(` FAIL (exit ${typeRes.code})`));
    log(tail(`${typeRes.stdout}\n${typeRes.stderr}`, 20).split('\n').map(l => `      ${l}`).join('\n'));
    for (const { name } of probes) typeProbeByPkg.set(name, 'fail');
  }

  for (const [name, agg] of byPkg) {
    const typeStatus = typeProbeByPkg.get(name) ?? 'skip';
    agg.cases.push({ subpath: '*', kind: 'types', status: typeStatus, code: typeRes.code });
    const overall = agg.cases.every(c => c.status === 'pass') ? 'pass' : 'fail';
    const r = ensureResult(name);
    r.consumer = {
      status: overall,
      esm: agg.esm ?? 'skip',
      cjs: agg.cjs ?? 'skip',
      types: typeStatus,
      cases: agg.cases,
    };
    if (overall === 'fail') fail(name, 'consumer-probe', 1);
  }
}

if (!replay) {
  if (!firstFailure && !anyStageFailed && packed.length === report.order.length) {
    generateConsumer();
    if (installConsumer()) runProbes();
  } else {
    section('Consumer stage skipped (earlier stage failed)');
    for (const name of report.order) {
      ensureResult(name).consumer = { status: 'skip', esm: 'skip', cjs: 'skip', types: 'skip', cases: [] };
    }
  }
} else if (installConsumer()) {
  runProbes();
}

// ---------- summary ----------
function writeSummary() {
  const packages = report.order.map(name => {
    const r = ensureResult(name);
    return {
      name,
      directory: byName.get(name).relDir,
      stages: r.stages,
      pack: r.pack ? { status: r.pack.status, fileCount: r.pack.fileCount ?? null, tarball: r.pack.tarball ?? null, violations: r.pack.violations ?? [] } : null,
      consumer: r.consumer,
    };
  });
  const summary = {
    mode: replay ? 'offline-replay' : 'full',
    offline: true,
    topologicalOrder: report.order,
    exportProbes: report.probes.map(p => ({
      name: p.name,
      subpaths: [...new Set(p.targets.map(t => t.subpath))],
      conditions: [...new Set(p.targets.map(t => t.condition))].filter(Boolean),
    })),
    packages,
    firstFailure,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(workDir, { recursive: true });
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

function printSummaryTable() {
  section('Per-package results');
  const cols = ['package', ...STAGES, 'pack', 'esm', 'cjs', 'types'];
  log(dim(cols.map((h, i) => h.padEnd(i === 0 ? 16 : 10)).join('')));
  const mark = status => {
    if (status === 'pass') return green('pass'.padEnd(10));
    if (status === 'fail') return red('fail'.padEnd(10));
    return dim('skip'.padEnd(10));
  };
  for (const name of report.order) {
    const r = ensureResult(name);
    const cells = [name.padEnd(16)];
    for (const stage of STAGES) cells.push(mark(r.stages[stage]?.status));
    cells.push(mark(r.pack?.status));
    cells.push(mark(r.consumer?.esm === 'pass' ? 'pass' : (r.consumer?.esm === 'fail' ? 'fail' : 'skip')));
    cells.push(mark(r.consumer?.cjs === 'pass' ? 'pass' : (r.consumer?.cjs === 'fail' ? 'fail' : 'skip')));
    cells.push(mark(r.consumer?.types === 'pass' ? 'pass' : (r.consumer?.types === 'fail' ? 'fail' : 'skip')));
    log(cells.join(''));
  }
}

function stageTotals() {
  const totals = {};
  for (const stage of [...STAGES, 'pack', 'esm', 'cjs', 'types']) {
    let pass = 0; let fail = 0; let skip = 0;
    for (const name of report.order) {
      const r = ensureResult(name);
      let status;
      if (stage === 'esm' || stage === 'cjs' || stage === 'types') status = r.consumer?.[stage];
      else if (stage === 'pack') status = r.pack?.status;
      else status = r.stages[stage]?.status;
      if (status === 'pass') pass += 1;
      else if (status === 'fail') fail += 1;
      else skip += 1;
    }
    totals[stage] = { pass, fail, skip };
  }
  return totals;
}

writeSummary();
printSummaryTable();
const totals = stageTotals();
section('Stage summary');
for (const [stage, t] of Object.entries(totals)) {
  const parts = [`${t.pass} passed`, t.fail ? `${t.fail} failed` : null, t.skip ? `${t.skip} skipped` : null].filter(Boolean);
  log(`  ${stage.padEnd(10)} ${t.fail ? red(parts.join(', ')) : green(parts.join(', '))}`);
}
log(`\nPackage-level summary: ${dim(relative(root, summaryPath))}`);

if (firstFailure) {
  log(red(`\nVERIFY FAILED: ${firstFailure.pkg} :: ${firstFailure.stage} (preserved exit code ${firstFailure.code})`));
  process.exit(firstFailure.code);
}
log(green('\nVERIFY PASSED: all packages verified in published form, fully offline'));

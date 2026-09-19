#!/usr/bin/env node
// Unified workspace verification entry point.
//
// Pipeline (per package, in dependency topological order):
//   typecheck -> lint -> test -> build -> pack-audit -> consumer ESM/CJS smoke
//
// Everything after `pnpm install --frozen-lockfile` runs offline by default.
// This script never publishes anything to a registry.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORK_DIR = join(ROOT, '.verify');
const TARBALL_DIR = join(WORK_DIR, 'tarballs');
const CONSUMER_DIR = join(WORK_DIR, 'consumers');
const LOG_DIR = join(WORK_DIR, 'logs');
const SUMMARY_PATH = join(WORK_DIR, 'summary.json');
const OFFLINE = process.env.UCAST_VERIFY_NETWORK !== '1';

const STAGES = ['typecheck', 'lint', 'test', 'build', 'pack', 'consumer'];
const STAGE_TITLES = {
  typecheck: 'Typecheck',
  lint: 'Lint',
  test: 'Test',
  build: 'Build',
  pack: 'Pack audit',
  consumer: 'Consumer smoke',
};

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[36m',
};
const useColor = process.stdout.isTTY && process.env.NO_COLOR == null;
const paint = (color, text) => (useColor ? `${ANSI[color]}${text}${ANSI.reset}` : text);

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

function banner(title) {
  log('');
  log(paint('blue', `── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`));
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (options.tee !== false) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.tee !== false) process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      resolvePromise({ code: 127, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on('close', (code, signal) => {
      resolvePromise({ code: code ?? (signal ? 128 : 0), signal, stdout, stderr });
    });
  });
}

async function runLogged(label, command, args, options = {}) {
  const safeLabel = label.replace(/[^a-z0-9.-]+/gi, '_');
  const logPath = join(LOG_DIR, `${safeLabel}.log`);
  const startedAt = Date.now();
  const result = await runProcess(command, args, options);
  const durationMs = Date.now() - startedAt;
  const logBody = [
    `$ ${command} ${args.join(' ')}`,
    `cwd: ${options.cwd || ROOT}`,
    `exit: ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}`,
    `duration_ms: ${durationMs}`,
    '--- stdout ---',
    result.stdout,
    '--- stderr ---',
    result.stderr,
  ].join('\n');
  writeFileSync(logPath, `${logBody}\n`);
  return { ...result, durationMs, logPath };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --- workspace discovery -------------------------------------------------

function parseWorkspaceGlobs() {
  const yamlPath = join(ROOT, 'pnpm-workspace.yaml');
  if (!existsSync(yamlPath)) {
    throw new VerifyError('pnpm-workspace.yaml not found at repository root');
  }
  const yaml = readFileSync(yamlPath, 'utf8');
  const lines = yaml.split('\n');
  const globs = [];
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = line.match(/^\s+-\s+['"]?([^'"]+)['"]?\s*$/);
      if (item) {
        globs.push(item[1]);
      } else if (/^\S/.test(line)) {
        inPackages = false;
      }
    }
  }
  if (!globs.length) {
    throw new VerifyError('no `packages` globs found in pnpm-workspace.yaml');
  }
  return globs;
}

// Minimal globber: supports a trailing `/*` (one level) and literal paths.
function expandGlob(globPattern) {
  if (globPattern.includes('*')) {
    const prefix = globPattern.replace(/\*.*$/, '');
    const base = join(ROOT, prefix);
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(prefix, entry.name));
  }
  return [globPattern];
}

function discoverPackages() {
  const packages = new Map();
  const errors = [];
  for (const pattern of parseWorkspaceGlobs()) {
    for (const relativeDir of expandGlob(pattern)) {
      const directory = join(ROOT, relativeDir);
      const manifestPath = join(directory, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = readJson(manifestPath);
      if (!manifest.name) {
        errors.push(`${relative(directory)}: package.json has no "name"`);
        continue;
      }
      if (packages.has(manifest.name)) {
        errors.push(`duplicate workspace package name "${manifest.name}"`);
        continue;
      }
      packages.set(manifest.name, {
        name: manifest.name,
        dir: directory,
        relDir: relative(ROOT, directory),
        manifest,
      });
    }
  }
  return { packages, errors };
}

class VerifyError extends Error {}

function workspaceDependencies(manifest, knownNames) {
  const deps = [];
  const missing = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const section = manifest[field] || {};
    for (const [name, spec] of Object.entries(section)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        if (knownNames.has(name)) {
          deps.push({ name, field });
        } else {
          missing.push({ name, field, spec });
        }
      }
    }
  }
  return { deps, missing };
}

// Deterministic topological sort (Kahn) plus cycle diagnostics.
function topologicalOrder(packages) {
  const names = [...packages.keys()].sort();
  const edges = new Map(names.map((name) => [name, new Set()]));
  const indegree = new Map(names.map((name) => [name, 0]));
  const missing = [];

  for (const name of names) {
    const { manifest } = packages.get(name);
    const result = workspaceDependencies(manifest, new Set(names));
    for (const dep of result.deps) {
      if (!edges.get(dep.name).has(name)) {
        edges.get(dep.name).add(name);
        indegree.set(name, indegree.get(name) + 1);
      }
    }
    for (const item of result.missing) {
      missing.push({ package: name, ...item });
    }
  }

  const ready = names.filter((name) => indegree.get(name) === 0).sort();
  const order = [];
  while (ready.length) {
    const name = ready.shift();
    order.push(name);
    for (const dependent of [...edges.get(name)].sort()) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) ready.push(dependent);
    }
    ready.sort();
  }

  const cycles = [];
  if (order.length !== names.length) {
    const remaining = new Set(names.filter((name) => !order.includes(name)));
    const stack = [];
    const onStack = new Set();
    const visiting = new Set();
    const adjacency = new Map(names.map((name) => [name, []]));
    for (const name of names) {
      const result = workspaceDependencies(packages.get(name).manifest, new Set(names));
      adjacency.set(name, result.deps.map((dep) => dep.name));
    }
    function visit(node) {
      visiting.add(node);
      stack.push(node);
      onStack.add(node);
      for (const next of adjacency.get(node)) {
        if (!remaining.has(next) || onStack.has(next)) {
          if (onStack.has(next)) {
            const start = stack.indexOf(next);
            cycles.push([...stack.slice(start), next]);
          }
          continue;
        }
        if (!visiting.has(next)) visit(next);
      }
      stack.pop();
      onStack.delete(node);
    }
    for (const node of remaining) {
      if (!visiting.has(node)) visit(node);
    }
  }

  return { order, cycles, missing };
}

// --- exports pre-build diagnostics --------------------------------------

// Flatten an `exports` manifest into a list of { key, condition, target }.
function flattenExports(exportsField, key = '.', condition = '.') {
  if (typeof exportsField === 'string') {
    return [{ key, condition, target: exportsField }];
  }
  if (Array.isArray(exportsField)) {
    return exportsField.flatMap((entry) => flattenExports(entry, key, condition));
  }
  if (exportsField && typeof exportsField === 'object') {
    const result = [];
    for (const [subKey, value] of Object.entries(exportsField)) {
      if (subKey.startsWith('.')) {
        result.push(...flattenExports(value, subKey, '.'));
      } else {
        result.push(...flattenExports(value, key, condition === '.' ? subKey : `${condition}/${subKey}`));
      }
    }
    return result;
  }
  return [];
}

// Resolve an exports target to the source file that must produce it.
// dist/(esm|cjs|types)/<x>.<ext>  <=>  src/<x>.ts
function sourceForTarget(target) {
  const match = target.match(/^\.\/dist\/(esm|cjs|types)\/(.+)$/);
  if (!match) return null;
  let rest = match[2];
  rest = rest.replace(/\.(mjs|js|d\.ts|d\.mts|d\.cts)$/, '.ts');
  return join('src', rest);
}

function diagnosePackage(pkg) {
  const problems = [];
  const { manifest } = pkg;

  if (!manifest.exports) {
    problems.push('package.json has no "exports" field');
  } else {
    const flat = flattenExports(manifest.exports);
    if (!flat.length) problems.push('"exports" field resolves to no targets');
    for (const entry of flat) {
      if (!entry.target.startsWith('./')) {
        problems.push(`exports "${entry.key}" ${entry.condition} target is not relative: ${entry.target}`);
        continue;
      }
      const source = sourceForTarget(entry.target);
      if (source == null) {
        problems.push(`exports "${entry.key}" ${entry.condition} points outside ./dist: ${entry.target}`);
        continue;
      }
      if (!existsSync(join(pkg.dir, source))) {
        problems.push(
          `exports "${entry.key}" ${entry.condition} -> ${entry.target}, expected source ${source} not found`,
        );
      }
    }
    for (const subKey of Object.keys(manifest.exports)) {
      if (subKey === '.') continue;
      if (!subKey.startsWith('./')) {
        problems.push(`exports key must start with "./": ${subKey}`);
      }
    }
  }

  const legacyFields = [
    ['main', /^(\.\/)?dist\/cjs\/.+\.js$/],
    ['module', /^(\.\/)?dist\/esm\/.+\.mjs$/],
    ['typings', /^(\.\/)?dist\/types\/.+\.d\.ts$/],
  ];
  for (const [field, pattern] of legacyFields) {
    const value = manifest[field];
    if (value == null) {
      if (field !== 'module') problems.push(`package.json has no "${field}" field`);
    } else if (!pattern.test(value)) {
      problems.push(`package.json "${field}" has unexpected layout: ${value}`);
    }
  }
  return problems;
}

// --- tarball inspection --------------------------------------------------

async function listTarball(tarballPath) {
  const result = await runProcess('tar', ['-tzf', tarballPath], { tee: false });
  if (result.code !== 0) {
    throw new VerifyError(`tar -tzf failed for ${tarballPath}\n${result.stderr}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

const FORBIDDEN_TARBALL_PATTERNS = [
  /(^|\/)spec(\/|$)/,
  /\.spec\.[jt]sx?$/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)\.nyc_output(\/|$)/,
  /\.(lcov|log)$/,
  /(^|\/)\.(eslintcache|npmrc|pnpmrc)$/,
  /tsconfig.*\.json$/,
  /(^|\/)\.mocha/,
  /\.tsbuildinfo$/,
];

function auditTarball(pkg, entries) {
  const problems = [];
  const files = entries
    .filter((entry) => !entry.endsWith('/'))
    .map((entry) => entry.replace(/^package\//, ''));

  for (const file of files) {
    for (const pattern of FORBIDDEN_TARBALL_PATTERNS) {
      if (pattern.test(file)) {
        problems.push(`forbidden file in tarball: ${file}`);
        break;
      }
    }
  }

  const fileSet = new Set(files);
  for (const entry of flattenExports(pkg.manifest.exports)) {
    const inside = entry.target.replace(/^\.\//, '');
    if (!fileSet.has(inside)) {
      problems.push(`exports target missing from tarball: ${entry.target} (${entry.key} ${entry.condition})`);
    }
  }
  for (const field of ['main', 'module', 'typings']) {
    const value = pkg.manifest[field];
    if (value && !fileSet.has(value.replace(/^\.\//, ''))) {
      problems.push(`${field} target missing from tarball: ${value}`);
    }
  }

  const mapProblems = [];
  for (const file of files.filter((name) => name.endsWith('.map'))) {
    mapProblems.push(...auditSourceMap(pkg, file));
  }
  return { problems, mapProblems };
}

function auditSourceMap(pkg, mapFile) {
  const problems = [];
  let map;
  try {
    const absolute = join(pkg.dir, 'dist', mapFile.replace(/^dist\//, ''));
    map = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    return [`source map unreadable inside package dist: ${mapFile}`];
  }
  for (const source of map.sources || []) {
    if (isAbsolute(source) || source.includes(ROOT) || source.includes('/home/') || /^[A-Za-z]:[\\/]/.test(source)) {
      problems.push(`source map ${mapFile} exposes absolute path: ${source}`);
    }
    if (/(^|\/)spec(\/|$)|\.spec\.[jt]sx?$/.test(source)) {
      problems.push(`source map ${mapFile} references spec source: ${source}`);
    }
  }
  return problems;
}

// --- consumer smoke tests ------------------------------------------------

// Peer deps needed to actually load every exported subpath. Specs are pinned
// to the exact versions already installed in the workspace's pnpm store (so
// offline resolution cannot float to an uncached newer version).
function consumerPeerDeps(pkg) {
  const peers = pkg.manifest.peerDependencies || {};
  const requireFromPackage = createRequire(pathToFileURL(join(pkg.dir, 'package.json')));
  const result = {};
  for (const name of Object.keys(peers)) {
    try {
      const installedPath = requireFromPackage.resolve(`${name}/package.json`);
      result[name] = readJson(installedPath).version;
    } catch {
      // Optional peer that is not installed; its subpaths cannot be probed
      // here, and the package is responsible for guarding the import.
    }
  }
  return result;
}

const PROBE_CJS = `const { createRequire } = require('node:module');
const report = require('node:fs').createWriteStream(process.env.PROBE_REPORT, { flags: 'a' });
const requireFromHere = createRequire(__filename);
async function main() {
  const subpaths = JSON.parse(process.env.PROBE_SUBPATHS).map((value) => (value === '.' ? '' : value));
  for (const sub of subpaths) {
    const spec = process.env.PROBE_PKG + sub;
    const loaded = requireFromHere(spec);
    const keys = Object.keys(loaded);
    if (!keys.length) throw new Error('cjs require returned empty namespace: ' + spec);
    report.write(JSON.stringify({ format: 'cjs', subpath: sub, exportKeys: keys.slice(0, 8) }) + '\\n');
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
`;

const PROBE_MJS = `import { createWriteStream } from 'node:fs';
const report = createWriteStream(process.env.PROBE_REPORT, { flags: 'a' });
const subpaths = JSON.parse(process.env.PROBE_SUBPATHS).map((value) => (value === '.' ? '' : value));
for (const sub of subpaths) {
    const spec = process.env.PROBE_PKG + sub;
  const loaded = await import(spec);
  const keys = Object.keys(loaded);
  if (!keys.length) throw new Error('esm import returned empty namespace: ' + spec);
  report.write(JSON.stringify({ format: 'esm', subpath: sub, exportKeys: keys.slice(0, 8) }) + '\\n');
}
`;

async function runConsumerSmoke(pkg, tarballByPackage) {
  const consumerRoot = join(CONSUMER_DIR, pkg.name.replace(/^@/, '').replace('/', '-'));
  rmSync(consumerRoot, { recursive: true, force: true });
  mkdirSync(consumerRoot, { recursive: true });

  const dependencies = {
    [pkg.name]: tarballByPackage.get(pkg.name),
    ...consumerPeerDeps(pkg),
  };
  // Pin every workspace package name (including transitive deps referenced
  // inside packed manifests) to a local tarball path, so resolution never
  // asks a registry for @ucast/* metadata in offline mode.
  const manifest = {
    name: `verify-consumer-${pkg.name.replace('@', '').replace('/', '-')}`,
    version: '0.0.0',
    private: true,
    dependencies,
  };
  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // pnpm v11 reads overrides from pnpm-workspace.yaml only. This file also
  // turns the consumer directory into its own workspace root, so pnpm never
  // walks up into the repository workspace.
  const overrideLines = ['packages:', '  - "."', 'overrides:'];
  for (const [name, tarballPath] of tarballByPackage.entries()) {
    overrideLines.push(`  "${name}": "${tarballPath}"`);
  }
  writeFileSync(join(consumerRoot, 'pnpm-workspace.yaml'), `${overrideLines.join('\n')}\n`);
  // Offline replay strategy:
  //   1. symlink the workspace's populated virtual store into node_modules,
  //      so every transitive dependency already exists at its lockfile
  //      version (no version floating to uncached newer tarballs);
  //   2. point pnpm at a *separate* virtual store dir, so its extraneous
  //      package cleanup never touches the workspace's own .pnpm directory.
  const virtualStoreTarget = join(ROOT, 'node_modules', '.pnpm');
  const virtualStoreLink = join(consumerRoot, 'node_modules', '.pnpm');
  mkdirSync(dirname(virtualStoreLink), { recursive: true });
  if (existsSync(virtualStoreTarget)) {
    symlinkSync(virtualStoreTarget, virtualStoreLink, 'dir');
  } else {
    throw new VerifyError(`workspace virtual store missing: ${virtualStoreTarget}`);
  }

  const ownVirtualStore = join(consumerRoot, 'virtual-store');
  const installArgs = [
    'install',
    '--offline',
    '--config.confirmModulesPurge=false',
    '--config.lockfile=false',
    // Node used to run verification may not satisfy a peer's `engines`
    // range (e.g. a very new Node); the packages still load and the smoke
    // test is about export shape, not engine gating.
    '--config.engine-strict=false',
    `--virtual-store-dir=${ownVirtualStore}`,
  ];
  const install = await runLogged(
    `05-consumer-install-${pkg.name.replace('/', '-')}`,
    'pnpm',
    installArgs,
    { cwd: consumerRoot },
  );
  if (install.code !== 0) {
    return { code: install.code, results: [], installLog: install.logPath };
  }

  const subpaths = ['.', ...Object.keys(pkg.manifest.exports || {}).filter((key) => key !== '.')]
    .map((key) => (key.startsWith('.') ? key.slice(1) || '.' : key));
  const reportPath = join(consumerRoot, 'probe-report.jsonl');
  writeFileSync(reportPath, '');
  writeFileSync(join(consumerRoot, 'probe.cjs'), PROBE_CJS);
  writeFileSync(join(consumerRoot, 'probe.mjs'), PROBE_MJS);

  const probeEnv = {
    PROBE_PKG: pkg.name,
    PROBE_SUBPATHS: JSON.stringify(subpaths),
    PROBE_REPORT: reportPath,
  };
  const results = [];
  let lastFailure = null;
  for (const format of ['cjs', 'esm']) {
    const probe = await runLogged(
      `06-consumer-probe-${format}-${pkg.name.replace('/', '-')}`,
      'node',
      [`probe.${format === 'esm' ? 'mjs' : 'cjs'}`],
      { cwd: consumerRoot, env: probeEnv },
    );
    if (probe.code !== 0) lastFailure = { format, code: probe.code };
  }
  if (!lastFailure) {
    for (const line of readFileSync(reportPath, 'utf8').trim().split('\n').filter(Boolean)) {
      results.push(JSON.parse(line));
    }
  }
  // Remove successful consumer projects to keep runs self-contained; failed
  // ones are preserved for inspection unless the opt-out is set.
  if (process.env.UCAST_VERIFY_KEEP_CONSUMERS !== '1' && !lastFailure) {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
  return { code: lastFailure ? lastFailure.code : 0, results };
}

// --- worktree guard ------------------------------------------------------

async function gitStatusLines() {
  const result = await runProcess('git', ['status', '--porcelain', '-uall', '--untracked-files=all'], { tee: false });
  if (result.code !== 0) return null;
  return result.stdout.split('\n').filter(Boolean);
}

// --- main pipeline -------------------------------------------------------

function printDiagnostics(diagnosticList) {
  for (const item of diagnosticList) {
    log(paint('red', `  ✗ ${item}`));
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  mkdirSync(join(WORK_DIR, 'logs'), { recursive: true });
  mkdirSync(TARBALL_DIR, { recursive: true });
  mkdirSync(CONSUMER_DIR, { recursive: true });

  banner('Verify environment');
  const pnpmCheck = await runProcess('pnpm', ['--version'], { tee: false });
  if (pnpmCheck.code !== 0) {
    log(paint('red', 'pnpm not found on PATH. Run `pnpm install --frozen-lockfile` first.'));
    process.exit(127);
  }
  log(`node ${process.version} | pnpm ${pnpmCheck.stdout.trim()} | ${OFFLINE ? 'offline' : 'network allowed'}`);
  log(`work tree: ${ROOT}`);

  const { packages, errors: discoveryErrors } = discoverPackages();
  const { order, cycles, missing } = topologicalOrder(packages);

  banner('Dependency graph');
  for (const name of [...packages.keys()].sort()) {
    const { deps } = workspaceDependencies(packages.get(name).manifest, new Set(packages.keys()));
    const edge = deps.length ? deps.map((dep) => dep.name).join(', ') : '∅';
    log(`  ${name} → ${edge}`);
  }
  log('');
  log(paint('magenta', `topological order: ${order.join('  →  ')}`));

  const diagnostics = [...discoveryErrors];
  for (const { package: owner, name, field } of missing) {
    diagnostics.push(`${owner} declares missing workspace dependency "${name}" in ${field} (no such workspace package)`);
  }
  for (const cycle of cycles) {
    diagnostics.push(`dependency cycle detected: ${cycle.join(' -> ')}`);
  }
  for (const name of order) {
    for (const problem of diagnosePackage(packages.get(name))) {
      diagnostics.push(`${name}: ${problem}`);
    }
  }

  if (diagnostics.length) {
    banner('Pre-build diagnostics FAILED');
    printDiagnostics(diagnostics);
    log('');
    log(paint('red', `aborting before build with ${diagnostics.length} diagnostic(s)`));
    process.exit(2);
  }
  log(paint('green', 'pre-build diagnostics passed (graph, workspace deps, exports targets)'));

  const baselineStatus = await gitStatusLines();
  const statusBefore = new Set(baselineStatus || []);

  const packageResults = [];
  const tarballByPackage = new Map();
  let failedStage = null;
  let failedCode = 0;

  const recordFailure = (stage, code) => {
    if (!failedStage) {
      failedStage = stage;
      failedCode = code;
    }
  };

  for (const name of order) {
    const pkg = packages.get(name);
    const entry = {
      package: name,
      directory: pkg.relDir,
      stages: {},
      tarball: null,
      exportsProbes: [],
    };
    packageResults.push(entry);
    banner(`${name}  [${order.indexOf(name) + 1}/${order.length}]`);

    const stage = async (stageName, command, args, extraOptions = {}) => {
      log(paint('dim', `▶ ${STAGE_TITLES[stageName]}: ${command} ${args.join(' ')}`));
      const result = await runLogged(
        `${String(order.indexOf(name) + 1).padStart(2, '0')}-${stageName}-${name.replace('/', '-')}`,
        command,
        args,
        { cwd: pkg.dir, ...extraOptions },
      );
      entry.stages[stageName] = {
        ok: result.code === 0,
        exitCode: result.code,
        durationMs: result.durationMs,
        log: relative(ROOT, result.logPath),
      };
      if (result.code !== 0) {
        log(paint('red', `✗ ${STAGE_TITLES[stageName]} failed (exit ${result.code}), log: ${relative(ROOT, result.logPath)}`));
      } else {
        log(paint('green', `✓ ${STAGE_TITLES[stageName]} (${result.durationMs} ms)`));
      }
      return result;
    };

    const typecheck = await stage('typecheck', 'pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.json']);
    if (typecheck.code !== 0) { recordFailure('typecheck', typecheck.code); break; }

    const lint = await stage('lint', 'pnpm', ['run', 'lint']);
    if (lint.code !== 0) { recordFailure('lint', lint.code); break; }

    const test = await stage('test', 'pnpm', ['run', 'test']);
    if (test.code !== 0) { recordFailure('test', test.code); break; }

    const build = await stage('build', 'pnpm', ['run', 'build']);
    if (build.code !== 0) { recordFailure('build', build.code); break; }

    // Re-validate exports against the real emitted files before packing.
    const postBuildProblems = [];
    for (const target of flattenExports(pkg.manifest.exports)) {
      const absolute = join(pkg.dir, target.target.replace(/^\.\//, ''));
      if (!existsSync(absolute)) {
        postBuildProblems.push(`built file missing: ${target.target} (${target.key} ${target.condition})`);
      }
    }
    if (postBuildProblems.length) {
      entry.stages.pack = {
        ok: false,
        exitCode: 2,
        durationMs: 0,
        log: null,
        problems: postBuildProblems,
      };
      printDiagnostics(postBuildProblems.map((problem) => `${name}: ${problem}`));
      recordFailure('pack', 2);
      break;
    }

    const pack = await stage('pack', 'pnpm', ['pack', '--pack-destination', TARBALL_DIR]);
    if (pack.code !== 0) { recordFailure('pack', pack.code); break; }
    const packLines = pack.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const packedDetail = packLines[packLines.length - 1] || '';
    const tarballPath = isAbsolute(packedDetail)
      ? packedDetail
      : join(TARBALL_DIR, packedDetail);
    tarballByPackage.set(name, tarballPath);
    entry.tarball = relative(ROOT, tarballPath);

    const tarEntries = await listTarball(tarballPath);
    const { problems: auditProblems, mapProblems } = auditTarball(pkg, tarEntries);
    const allAuditProblems = [...auditProblems, ...mapProblems];
    if (allAuditProblems.length) {
      entry.stages.pack = {
        ...entry.stages.pack,
        ok: false,
        audit: allAuditProblems,
      };
      printDiagnostics(allAuditProblems.map((problem) => `${name}: ${problem}`));
      recordFailure('pack', 2);
      break;
    }
    log(paint('green', `✓ pack audit: ${tarEntries.filter((item) => !item.endsWith('/')).length} files, clean source maps`));

    const smoke = await runConsumerSmoke(pkg, tarballByPackage);
    entry.stages.consumer = {
      ok: smoke.code === 0,
      exitCode: smoke.code,
      log: smoke.installLog ? relative(ROOT, smoke.installLog) : null,
    };
    entry.exportsProbes = smoke.results;
    if (smoke.code !== 0) {
      log(paint('red', `✗ consumer smoke failed (exit ${smoke.code})`));
      recordFailure('consumer', smoke.code);
      break;
    }
    for (const result of smoke.results) {
      log(paint('green', `✓ exports probe ${result.format} ${result.subpath} → keys: ${result.exportKeys.join(', ')}`));
    }
  }

  // --- summary + worktree guard ----------------------------------------

  const statusAfter = new Set((await gitStatusLines()) || []);
  const unexpectedFiles = [...statusAfter].filter((line) => {
    if (statusBefore.has(line)) return false;
    const path = line.slice(3).split(' -> ').pop();
    return path !== '.verify' && !path.startsWith('.verify/');
  });

  const finishedAt = new Date().toISOString();
  const summary = {
    startedAt,
    finishedAt,
    offline: OFFLINE,
    node: process.version,
    topologicalOrder: order,
    packages: packageResults,
    failedStage,
    exitCode: failedCode,
    worktreeChanges: unexpectedFiles,
  };
  writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);

  banner('Package summary');
  for (const result of packageResults) {
    const parts = STAGES.map((stageName) => {
      const stageResult = result.stages[stageName];
      if (!stageResult) return paint('yellow', `${stageName}=-`);
      return stageResult.ok
        ? paint('green', `${stageName}=ok`)
        : paint('red', `${stageName}=FAIL(${stageResult.exitCode})`);
    });
    log(`  ${result.package.padEnd(16)} ${parts.join('  ')}`);
    for (const probe of result.exportsProbes) {
      log(paint('dim', `    ${probe.format.padEnd(3)} ${result.package}${probe.subpath} → ${probe.exportKeys.join(', ')}`));
    }
  }
  log('');
  log(`summary written to ${paint('magenta', relative(ROOT, SUMMARY_PATH))}`);
  log(`logs: ${paint('magenta', relative(ROOT, LOG_DIR))}/  tarballs: ${paint('magenta', relative(ROOT, TARBALL_DIR))}/`);

  if (unexpectedFiles.length) {
    banner('Worktree guard FAILED');
    for (const line of unexpectedFiles) log(paint('red', `  ${line}`));
    log(paint('red', 'verification changed files outside .verify/ and dist/'));
    if (!failedStage) {
      failedStage = 'worktree';
      failedCode = 3;
    }
  }

  if (failedStage) {
    banner('Verification FAILED');
    log(paint('red', `failed stage: ${failedStage} (exit ${failedCode})`));
    log(paint('dim', 'completed package results were still printed above and saved to the summary'));
    process.exit(failedCode || 1);
  }
  banner('Verification passed');
  log(paint('green', `all ${order.length} package(s): typecheck, lint, test, build, pack audit, ESM+CJS consumers`));
  process.exit(0);
}

main().catch((error) => {
  log(paint('red', `verify crashed: ${error.stack || error.message}`));
  process.exit(1);
});

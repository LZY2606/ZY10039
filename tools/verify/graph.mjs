import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function expandGlobs(root, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/+$/, '');
    if (clean.endsWith('/*')) {
      const base = join(root, clean.slice(0, -2));
      if (existsSync(base)) {
        for (const entry of readdirSync(base)) {
          const full = join(base, entry);
          if (statSync(full).isDirectory() && existsSync(join(full, 'package.json'))) {
            dirs.push(full);
          }
        }
      }
    } else {
      const full = join(root, clean);
      if (existsSync(join(full, 'package.json'))) dirs.push(full);
    }
  }
  return [...new Set(dirs)].sort();
}

export function discoverWorkspace(root) {
  const workspaceFile = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceFile)) {
    throw new Error(`Missing pnpm-workspace.yaml at ${root}`);
  }
  const yamlText = readFileSync(workspaceFile, 'utf8');
  // Simple extraction of the `packages:` list so graph discovery has no external deps
  // beyond what the rest of the toolchain already requires.
  return { workspaceFile, yamlText };
}

export function loadWorkspacePackages(root, yaml) {
  const { yamlText } = discoverWorkspace(root);
  const config = yaml.parse(yamlText);
  const globs = Array.isArray(config.packages) ? config.packages : [];
  const packages = [];
  for (const dir of expandGlobs(root, globs)) {
    const pkg = readJson(join(dir, 'package.json'));
    packages.push({
      name: pkg.name,
      version: pkg.version,
      dir,
      relDir: relative(root, dir),
      pkg,
    });
  }
  return packages;
}

const WORKSPACE_SPEC = /^workspace:/;

export function internalDependencies(pkgEntry) {
  const deps = pkgEntry.pkg.dependencies ?? {};
  return Object.entries(deps)
    .filter(([, spec]) => WORKSPACE_SPEC.test(String(spec)))
    .map(([name]) => name);
}

export function buildGraph(packages) {
  const byName = new Map(packages.map(p => [p.name, p]));
  const missing = [];
  const adj = new Map();
  for (const entry of packages) {
    const deps = internalDependencies(entry);
    const local = [];
    for (const dep of deps) {
      if (!byName.has(dep)) {
        missing.push({ pkg: entry.name, missing: dep });
      } else {
        local.push(dep);
      }
    }
    adj.set(entry.name, local);
  }
  return { byName, adj, missing };
}

export function topologicalSort(graph) {
  const { byName, adj } = graph;
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...byName.keys()].map(n => [n, WHITE]));
  const order = [];
  const cycles = [];

  function visit(name, stack) {
    const state = color.get(name);
    if (state === BLACK) return;
    if (state === GRAY) {
      const start = stack.indexOf(name);
      cycles.push([...stack.slice(start), name]);
      return;
    }
    color.set(name, GRAY);
    stack.push(name);
    for (const dep of adj.get(name) ?? []) {
      visit(dep, stack);
    }
    stack.pop();
    color.set(name, BLACK);
    order.push(name);
  }

  for (const name of [...byName.keys()].sort()) {
    if (color.get(name) === WHITE) visit(name, []);
  }
  return { order, cycles };
}

export function exportTargets(pkgEntry) {
  const exports = pkgEntry.pkg.exports;
  const targets = [];
  function walk(subpath, condition, value) {
    if (typeof value === 'string') {
      targets.push({ subpath, condition, target: value });
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith('.')) {
          walk(key, null, child);
        } else {
          walk(subpath, key, child);
        }
      }
    }
  }
  if (typeof exports === 'string') {
    targets.push({ subpath: '.', condition: null, target: exports });
  } else if (exports && typeof exports === 'object') {
    for (const [key, value] of Object.entries(exports)) walk(key, null, value);
  }
  return targets;
}

function candidateSourcesForTarget(targetRel) {
  // dist/cjs/index.js      -> src/index.ts
  // dist/esm/lib/x.mjs     -> src/lib/x.ts
  // dist/types/index.d.ts  -> src/index.ts
  const noPrefix = targetRel.replace(/^\.\//, '');
  let src = noPrefix
    .replace(/^dist\/(?:cjs|esm|types)\//, 'src/')
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.(mjs|c?js)$/, '.ts');
  return [src];
}

export function preflightExports(packages) {
  const problems = [];
  const probes = [];
  for (const entry of packages) {
    const exports = entry.pkg.exports;
    if (!exports) {
      problems.push({
        pkg: entry.name,
        code: 'EXPORTS_MISSING',
        message: `package ${entry.name} declares no "exports" map`,
      });
      continue;
    }
    const targets = exportTargets(entry);
    const entryTargets = [];
    for (const t of targets) {
      const sources = candidateSourcesForTarget(t.target);
      const sourceExists = sources.some(s => existsSync(resolve(entry.dir, s)));
      if (!sourceExists) {
        problems.push({
          pkg: entry.name,
          code: 'EXPORTS_NO_SOURCE',
          message: `${entry.name} export ${t.subpath} points at ${t.target} but no matching source entry was found (checked ${sources.join(', ')})`,
          target: t.target,
          subpath: t.subpath,
        });
      }
      entryTargets.push({ ...t, sources, sourceExists });
    }
    probes.push({ name: entry.name, dir: entry.relDir, targets: entryTargets });
  }
  return { problems, probes };
}

export function graphReport(root, yaml) {
  const packages = loadWorkspacePackages(root, yaml);
  if (packages.length === 0) {
    throw new Error('No workspace packages discovered from pnpm-workspace.yaml `packages` globs.');
  }
  const graph = buildGraph(packages);
  const { order, cycles } = topologicalSort(graph);
  const { problems: exportProblems, probes } = preflightExports(packages);
  return { packages, graph, order, cycles, exportProblems, probes };
}

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function fromPnpmDir(root) {
  const pnpmDir = join(root, 'node_modules/.pnpm');
  if (!existsSync(pnpmDir)) return null;
  const entries = readdirSync(pnpmDir);
  const yamlDir = entries.find(d => /^yaml@\d+/.test(d));
  if (yamlDir) {
    const entry = join(pnpmDir, yamlDir, 'node_modules/yaml/dist/index.js');
    if (existsSync(entry)) {
      const mod = await import(entry);
      return { parse: s => mod.parse(s), stringify: o => mod.stringify(o) };
    }
  }
  const jsYamlDir = entries.find(d => /^js-yaml@\d+/.test(d));
  if (jsYamlDir) {
    const entry = join(pnpmDir, jsYamlDir, 'node_modules/js-yaml');
    if (existsSync(join(entry, 'package.json'))) {
      const mod = require(entry);
      return { parse: s => mod.load(s), stringify: o => mod.dump(o, { lineWidth: -1, noRefs: true }) };
    }
  }
  return null;
}

export async function loadYaml(root) {
  const local = await fromPnpmDir(root).catch(() => null);
  if (local) return local;
  throw new Error(
    'No YAML parser found in the workspace. Run `pnpm install --frozen-lockfile` first.',
  );
}

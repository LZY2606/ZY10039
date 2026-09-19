import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';

function sha512(file) {
  const hash = createHash('sha512').update(readFileSync(file));
  return `sha512-${hash.digest('base64')}`;
}

// Build a lockfile for a throwaway consumer that installs every produced
// tarball via file: specifiers. Third-party entries (optional ORM peers of
// @ucast/sql) are copied verbatim from the root lockfile's sql importer, so
// their peer-suffixed snapshots always resolve strictly from the local store.
export function synthesizeConsumerLock({ rootLock, consumerDir, tarballs, thirdParty }) {
  const packages = { ...(rootLock.packages ?? {}) };
  const snapshots = { ...(rootLock.snapshots ?? {}) };
  const importerDeps = {};

  const tarballByPkg = new Map();
  for (const t of tarballs) {
    const relTarball = relative(consumerDir, t.path).split('\\').join('/');
    const lockId = `file:${relTarball}`;
    tarballByPkg.set(t.name, { lockId });
    packages[`${t.name}@${lockId}`] = {
      resolution: { integrity: sha512(t.path), tarball: lockId },
      version: t.version,
    };
    snapshots[`${t.name}@${lockId}`] = t.dependencies?.length
      ? {
          dependencies: Object.fromEntries(
            t.dependencies.map(dep => {
              const target = tarballByPkg.get(dep);
              if (!target) throw new Error(`Tarball ${t.name} depends on ${dep} but it was not packed`);
              return [dep, target.lockId];
            }),
          ),
        }
      : {};
  }

  for (const t of tarballs) {
    importerDeps[t.name] = {
      specifier: tarballByPkg.get(t.name).lockId,
      version: tarballByPkg.get(t.name).lockId,
    };
  }

  // Locate third-party packages (integration peers of the packed libraries) in
  // any workspace importer and reuse its exact locked resolution, so the
  // consumer installs strictly artifacts already present in the store.
  const importers = rootLock.importers ?? {};
  const findLocked = (name) => {
    for (const importer of Object.values(importers)) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const entry = importer?.[section]?.[name];
        if (entry) return entry;
      }
    }
    return null;
  };
  for (const name of thirdParty) {
    const entry = findLocked(name);
    if (!entry) {
      throw new Error(
        `Offline consumer needs "${name}" but it is not present in any pnpm-lock.yaml importer; `
        + 'add it to the workspace lockfile via pnpm install --frozen-lockfile first.',
      );
    }
    importerDeps[name] = { specifier: entry.specifier, version: entry.version };
  }

  return {
    lockfile: {
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
      importers: { '.': { dependencies: importerDeps } },
      packages,
      snapshots,
    },
    tarballByPkg,
  };
}

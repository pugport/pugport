import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const realManifest = JSON.parse(readFileSync(join(root, 'docs/NPM-LICENSE-SUPPLEMENTS.json'), 'utf8'));
const realLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-npm-licenses-'));
  const component = realManifest.components[0];
  for (const part of ['scripts', 'docs']) mkdirSync(join(directory, part), { recursive: true });
  cpSync(join(root, 'scripts/audit-dependency-licenses.mjs'), join(directory, 'scripts/audit-dependency-licenses.mjs'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.0' }));
  const packagePath = component.packagePaths[0];
  const packageEntry = realLock.packages[packagePath];
  const packages = { [packagePath]: packageEntry };
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages }));
  writeFileSync(
    join(directory, 'docs/NPM-LICENSE-SUPPLEMENTS.json'),
    JSON.stringify({ components: [component], unresolved: [] }),
  );
  mkdirSync(join(directory, packagePath), { recursive: true });
  writeFileSync(
    join(directory, packagePath, 'package.json'),
    JSON.stringify({ name: component.name, version: component.version, license: component.declaredLicense }),
  );
  for (const file of [...component.licenseFiles, component.attributionFile, ...component.evidence]) {
    mkdirSync(dirname(join(directory, file.path)), { recursive: true });
    cpSync(join(root, file.path), join(directory, file.path));
  }
  return { directory, component, packages, packagePath };
}
function run(directory: string, checkOnly = true) {
  return spawnSync(
    process.execPath,
    [join(directory, 'scripts/audit-dependency-licenses.mjs'), ...(checkOnly ? ['--check'] : [])],
    {
      encoding: 'utf8',
    },
  );
}
test('license audit checks actual package identity and full-text supplement hashes', () => {
  const { directory } = fixture();
  try {
    const result = run(directory, false);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(directory, 'docs/DEPENDENCY-LICENSES.json'), 'utf8'));
    assert.equal(report.installedProductionMissingTextCount, 0);
    assert.match(report.packages[0].supplementBasis, /README/);
    const before = readFileSync(join(directory, 'docs/DEPENDENCY-LICENSES.json'), 'utf8');
    assert.equal(run(directory).status, 0);
    assert.equal(readFileSync(join(directory, 'docs/DEPENDENCY-LICENSES.json'), 'utf8'), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('license audit rejects edited license text instead of treating a path as proof', () => {
  const { directory, component } = fixture();
  try {
    writeFileSync(join(directory, component.licenseFiles[0].path), 'MIT');
    const result = run(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Supplement checksum mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('third-party notices retain the Pi MIT heading', () => {
  assert.match(readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /^## Pi 1\.6\.0 MIT license text$/m);
});

test('license audit rejects changed package integrity and unreviewed production gaps', () => {
  const { directory, packages, packagePath } = fixture();
  try {
    writeFileSync(
      join(directory, 'package-lock.json'),
      JSON.stringify({ packages: { [packagePath]: { ...packages[packagePath], integrity: 'sha512-changed' } } }),
    );
    assert.match(run(directory).stderr, /does not match locked package identity/);
    writeFileSync(
      join(directory, 'package-lock.json'),
      JSON.stringify({ packages: { ...packages, 'node_modules/new-package': { version: '1.0.0', license: 'MIT' } } }),
    );
    mkdirSync(join(directory, 'node_modules/new-package'), { recursive: true });
    writeFileSync(
      join(directory, 'node_modules/new-package/package.json'),
      JSON.stringify({ name: 'new-package', version: '1.0.0', license: 'MIT' }),
    );
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /production 1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

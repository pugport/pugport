// Reproducible metadata inventory, not a substitute for reviewing actual licenses.
// Reads package metadata only; never loads dependency code or account directories.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const rootLicense = /^(?:licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i;
const supplementManifestPath = 'docs/NPM-LICENSE-SUPPLEMENTS.json';
const supplementManifest = JSON.parse(readFileSync(join(root, supplementManifestPath), 'utf8'));
const supplements = new Map();
for (const component of supplementManifest.components) {
  for (const file of [...component.licenseFiles, component.attributionFile, ...component.evidence]) {
    if (!/^licenses\/npm\/[a-z0-9._/-]+$/i.test(file.path) || file.path.split('/').includes('..'))
      throw new Error('Invalid supplemental license path');
    const bytes = readFileSync(join(root, file.path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== file.sha256) throw new Error(`Supplement checksum mismatch: ${file.path}`);
  }
  supplements.set(`${component.name}@${component.version}`, component);
}
const piPackages = new Set(
  ['pi-coding-agent', 'pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-mcp', 'pi-schema', 'pi-telemetry', 'pi-tui'].map(
    (name) => `@earendil-works/${name}`,
  ),
);
const supplemental = (name, item) => {
  if (name.startsWith('@koromix/koffi-') && item.version === '3.3.3' && item.license === 'MIT')
    return ['licenses/koffi-MIT.txt'];
  const component = supplements.get(`${name}@${item.version}`);
  if (component) {
    if (item.license !== component.declaredLicense || item.integrity !== component.packageIntegrity)
      throw new Error(`Supplement does not match locked package identity: ${name}`);
    return [...component.licenseFiles.map((file) => file.path), component.attributionFile.path];
  }
  return piPackages.has(name) && item.version === '1.6.0' && item.license === 'MIT'
    ? ['licenses/Pi-MIT.txt']
    : name === 'standardwebhooks' && item.version === '1.3.0' && item.license === 'MIT'
      ? ['licenses/StandardWebhooks-MIT.txt']
      : name.startsWith('@aws-sdk/') && item.license === 'Apache-2.0'
        ? ['licenses/AWS-SDK-JS-Apache-2.0.txt']
        : (name === 'esbuild' || name.startsWith('@esbuild/')) && item.version === '0.28.2' && item.license === 'MIT'
          ? ['licenses/esbuild-MIT.txt']
          : (name === 'onnxruntime-node' || name === 'onnxruntime-common') &&
              item.version === '1.30.0' &&
              item.license === 'MIT'
            ? ['licenses/onnxruntime-MIT.txt']
            : [];
};
const packages = Object.entries(lock.packages)
  .filter(([path]) => path)
  .map(([path, item]) => {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const directory = join(root, path);
    const present = existsSync(directory);
    const installedMetadata =
      present && existsSync(join(directory, 'package.json'))
        ? JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        : undefined;
    const supplementalFiles = supplemental(name, item);
    for (const file of supplementalFiles)
      if (!existsSync(join(root, file.split('#')[0]))) throw new Error(`Supplemental license file is missing: ${file}`);
    if (present && installedMetadata?.version !== item.version)
      throw new Error(`Installed dependency differs from lock: ${name}`);
    const licenseFiles = present
      ? readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && rootLicense.test(entry.name))
          .map((entry) => `${path}/${entry.name}`)
          .sort()
      : [];
    return {
      name,
      version: item.version,
      path,
      declaredLicense: item.license ?? null,
      developmentOnly: item.dev === true,
      optional: item.optional === true,
      packagePage: `https://www.npmjs.com/package/${name}/v/${item.version}`,
      installedAtAudit: present,
      licenseFiles,
      supplementalLicenseFiles: supplementalFiles,
      ...(supplements.has(`${name}@${item.version}`)
        ? {
            supplementManifest: supplementManifestPath,
            supplementBasis: supplements.get(`${name}@${item.version}`).basis,
          }
        : {}),
      review: !present
        ? 'not-installed-on-audit-host'
        : licenseFiles.length || supplementalFiles.length
          ? 'text-located-not-full-compliance-certification'
          : 'license-text-not-located',
    };
  })
  .sort((a, b) => a.path.localeCompare(b.path));
const licenseCounts = {};
for (const item of packages)
  licenseCounts[item.declaredLicense ?? 'UNKNOWN'] = (licenseCounts[item.declaredLicense ?? 'UNKNOWN'] ?? 0) + 1;
const report = {
  schemaVersion: 1,
  project: pkg.name,
  projectVersion: pkg.version,
  scope:
    'package-lock.json metadata and installed package-root license files; excludes full bundled-binary dependency analysis',
  source: 'package-lock.json',
  packagePathCount: packages.length,
  developmentOnlyCount: packages.filter((item) => item.developmentOnly).length,
  declaredLicenseCounts: licenseCounts,
  packages,
  supplementalManifest: supplementManifestPath,
  installedProductionMissingTextCount: packages.filter(
    (item) => item.installedAtAudit && !item.developmentOnly && item.review === 'license-text-not-located',
  ).length,
  installedDevelopmentMissingTextCount: packages.filter(
    (item) => item.installedAtAudit && item.developmentOnly && item.review === 'license-text-not-located',
  ).length,
};
const checkOnly = process.argv.includes('--check');
// Verification must not replace another platform's audited inventory with host-specific installation state.
if (!checkOnly) writeFileSync(join(root, 'docs', 'DEPENDENCY-LICENSES.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `${checkOnly ? 'Checked' : 'Wrote'} public dependency license metadata for ${packages.length} package paths; no account files were read.`,
);
console.log(
  `Installed package-root text gaps: production ${report.installedProductionMissingTextCount}, development ${report.installedDevelopmentMissingTextCount}; fixed supplements verified against local SHA-256 and package-lock integrity.`,
);
if (checkOnly && (report.installedProductionMissingTextCount || supplementManifest.unresolved.length))
  process.exitCode = 1;

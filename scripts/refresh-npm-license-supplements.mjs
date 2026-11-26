// Public upstream files only. Never loads package code, credentials, or account state.
// Fixed release commits and npm integrity bind these supplements to reviewed versions.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Public source unavailable: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
function tarEntry(archive, wanted) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .replace(/\0.*$/s, '');
    if (!name) break;
    const length = parseInt(
      tar
        .subarray(offset + 124, offset + 136)
        .toString()
        .replace(/\0.*$/s, '')
        .trim(),
      8,
    );
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid npm tar entry length');
    if (name === wanted) return tar.subarray(offset + 512, offset + 512 + length);
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  throw new Error(`Missing npm tar entry: ${wanted}`);
}
async function save(path, bytes, sourceUrl, extra = {}) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
  return { path, sha256: hash(bytes), sourceUrl, ...extra };
}
const raw = (repository, commit, path) => `https://raw.githubusercontent.com/${repository}/${commit}/${path}`;
const standardMit = 'https://raw.githubusercontent.com/spdx/license-list-data/v3.26.0/text/MIT.txt';
const standardBsd = 'https://raw.githubusercontent.com/spdx/license-list-data/v3.26.0/text/BSD-2-Clause.txt';
const specs = [
  {
    name: 'data-uri-to-buffer',
    version: '4.0.1',
    directory: 'data-uri-to-buffer-4.0.1',
    upstreamCommit: '85cd8c854aefbf1bb636789d80364cfac8ea1583',
    basis:
      'Exact npm tarball README contains the complete MIT license and Copyright (c) 2014 Nathan Rajlich. License section is extracted byte-for-byte; no replacement author or year is supplied.',
    mode: 'readme-license',
    evidenceUrls: [raw('TooTallNate/node-data-uri-to-buffer', '85cd8c854aefbf1bb636789d80364cfac8ea1583', 'README.md')],
  },
  {
    name: 'proxy-agent-negotiate',
    version: '1.1.0',
    directory: 'proxy-agent-negotiate-1.1.0',
    upstreamCommit: 'b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16',
    basis:
      'Exact npm tarball package.json explicitly declares MIT and author Nathan Rajlich. Its release source has no LICENSE or README. The unmodified SPDX MIT text is a distribution supplement to that explicit declaration, not an invented upstream LICENSE. Template placeholders are not assertions of copyright ownership or dates.',
    mode: 'standard',
    standardUrl: standardMit,
    evidenceUrls: [
      raw('TooTallNate/proxy-agents', 'b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16', 'packages/negotiate/package.json'),
    ],
    attestationUrl: 'https://registry.npmjs.org/-/npm/v1/attestations/proxy-agent-negotiate@1.1.0',
  },
  {
    name: '@electron-internal/extract-zip',
    version: '1.0.5',
    directory: 'electron-extract-zip-1.0.5',
    upstreamCommit: 'b83e459fd04c53b0a1c8438a6792df8f64be47fc',
    basis:
      'Exact npm package and release README explicitly declare BSD-2-Clause but omit its full text and copyright notice. The unchanged SPDX BSD-2-Clause text accompanies that declaration. The immediately subsequent upstream commit adds an MIT license and changes license metadata only; that actual upstream text is also retained as evidence, without silently relabeling this locked release as MIT.',
    mode: 'standard',
    standardUrl: standardBsd,
    evidenceUrls: [
      raw('electron/extract-zip', 'b83e459fd04c53b0a1c8438a6792df8f64be47fc', 'README.md'),
      raw('electron/extract-zip', '3c33b76429ebd9bf724bcfc32d3e8fae7eeb3e82', 'LICENSE'),
      'https://api.github.com/repos/electron/extract-zip/commits/3c33b76429ebd9bf724bcfc32d3e8fae7eeb3e82',
    ],
  },
  {
    name: 'err-code',
    version: '2.0.3',
    directory: 'err-code-2.0.3',
    upstreamCommit: '92511d41a6a926c94c9d11493404867b1e92a77a',
    basis:
      'Exact npm tarball package.json declares MIT and author IndigoUnited; its README explicitly releases the package under MIT with an OSI link. The unmodified SPDX MIT text supplements that declaration. No copyright year or nonexistent upstream LICENSE has been invented.',
    mode: 'standard',
    standardUrl: standardMit,
    evidenceUrls: [raw('IndigoUnited/js-err-code', '92511d41a6a926c94c9d11493404867b1e92a77a', 'README.md')],
  },
  {
    name: '@rolldown/binding-win32-x64-msvc',
    version: '1.2.19',
    directory: 'rolldown-binding-1.2.19',
    upstreamCommit: 'b9c75ddc8bd50f2c1a4c7be0b548bdab5cba85ab',
    basis:
      'npm release provenance identifies this source commit. Its full original MIT license and original THIRD-PARTY-LICENSE are retained unchanged. This is a development-only native binding, excluded from PugPort Windows runtime packaging.',
    mode: 'upstream',
    licenseUrls: [
      raw('rolldown/rolldown', 'b9c75ddc8bd50f2c1a4c7be0b548bdab5cba85ab', 'LICENSE'),
      raw('rolldown/rolldown', 'b9c75ddc8bd50f2c1a4c7be0b548bdab5cba85ab', 'THIRD-PARTY-LICENSE'),
    ],
    attestationUrl: 'https://registry.npmjs.org/-/npm/v1/attestations/@rolldown%2fbinding-win32-x64-msvc@1.2.19',
  },
];
const manifestPath = join(root, 'docs/NPM-LICENSE-SUPPLEMENTS.json');
const previous = await readFile(manifestPath, 'utf8')
  .then((bytes) => JSON.parse(bytes))
  .catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
if (previous && (!Array.isArray(previous.components) || !Array.isArray(previous.unresolved)))
  throw new Error('Existing npm license supplement manifest is incomplete');
const refreshedKeys = new Set(specs.map((spec) => `${spec.name}@${spec.version}`));
const retained = (previous?.components ?? []).filter(
  (component) => !refreshedKeys.has(`${component.name}@${component.version}`),
);
// Other reviewed versions, including Sherpa, have their own fixed-source evidence.
// Validate them before refreshing anything, then preserve their records and bytes.
for (const component of retained) {
  if (!Array.isArray(component.packagePaths) || !component.packagePaths.length)
    throw new Error(`Retained supplement has no locked package paths: ${component.name}`);
  for (const path of component.packagePaths) {
    const item = lock.packages[path];
    if (
      !path.endsWith(`/${component.name}`) ||
      item?.version !== component.version ||
      item.license !== component.declaredLicense ||
      item.integrity !== component.packageIntegrity
    )
      throw new Error(`Retained supplement does not match locked package: ${component.name}`);
  }
  for (const file of [...component.licenseFiles, component.attributionFile, ...component.evidence]) {
    if (!/^licenses\/npm\/[a-z0-9._/-]+$/i.test(file.path) || file.path.split('/').includes('..'))
      throw new Error('Invalid retained supplemental license path');
    if (hash(await readFile(join(root, file.path))) !== file.sha256)
      throw new Error(`Retained supplement checksum mismatch: ${file.path}`);
  }
}
const components = [];
for (const spec of specs) {
  const entries = Object.entries(lock.packages).filter(
    ([path, item]) => path.endsWith(`/${spec.name}`) && item.version === spec.version,
  );
  if (!entries.length) throw new Error(`Reviewed dependency missing from lock: ${spec.name}@${spec.version}`);
  const item = entries[0][1];
  if (entries.some(([, other]) => other.integrity !== item.integrity)) throw new Error('Conflicting package integrity');
  const archive = await download(item.resolved);
  if (`sha512-${hash(archive, 'sha512', 'base64')}` !== item.integrity)
    throw new Error(`Lock integrity mismatch: ${spec.name}`);
  const prefix = `licenses/npm/${spec.directory}`;
  const licenseFiles = [],
    evidence = [];
  const packageBytes = tarEntry(archive, 'package/package.json');
  const packageJson = JSON.parse(packageBytes);
  if (packageJson.name !== spec.name || packageJson.version !== spec.version || packageJson.license !== item.license)
    throw new Error('Package identity/license mismatch');
  evidence.push(
    await save(`${prefix}/upstream-package.json`, packageBytes, item.resolved, {
      archiveEntry: 'package/package.json',
    }),
  );
  if (spec.mode === 'readme-license') {
    const readme = tarEntry(archive, 'package/README.md');
    const text = readme.toString('utf8');
    const start = text.indexOf('(The MIT License)');
    const end = text.indexOf('\n[rfc]:', start);
    if (start < 0 || end < 0) throw new Error('Expected full MIT section missing');
    const section = Buffer.from(text.slice(start, end));
    if (
      !section.includes(Buffer.from('Copyright (c) 2014 Nathan Rajlich')) ||
      !section.includes(Buffer.from('SOFTWARE OR THE USE OR OTHER DEALINGS'))
    )
      throw new Error('License section changed');
    evidence.push(
      await save(`${prefix}/upstream-README.md`, readme, item.resolved, { archiveEntry: 'package/README.md' }),
    );
    licenseFiles.push(
      await save(`${prefix}/LICENSE.txt`, section, item.resolved, {
        archiveEntry: 'package/README.md',
        extraction: 'From (The MIT License) through the full disclaimer; byte-for-byte substring.',
      }),
    );
  } else if (spec.mode === 'standard') {
    licenseFiles.push(
      await save(`${prefix}/${item.license}-standard.txt`, await download(spec.standardUrl), spec.standardUrl, {
        origin:
          'Unmodified SPDX standard text; see upstream-package.json and ATTRIBUTION.md for the specific package grant.',
      }),
    );
  } else {
    for (const url of spec.licenseUrls)
      licenseFiles.push(await save(`${prefix}/${url.split('/').at(-1)}.txt`, await download(url), url));
  }
  for (const [index, url] of (spec.evidenceUrls ?? []).entries()) {
    evidence.push(
      await save(
        `${prefix}/source-${index + 1}-${url.includes('/commits/') ? 'commit.json' : url.split('/').at(-1)}`,
        await download(url),
        url,
      ),
    );
  }
  if (spec.attestationUrl) {
    const bytes = await download(spec.attestationUrl);
    const json = JSON.parse(bytes);
    const attestation = json.attestations.find((entry) => entry.predicateType === 'https://slsa.dev/provenance/v1');
    const payload = Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64');
    if (!payload.includes(Buffer.from(spec.upstreamCommit))) throw new Error('Unexpected published source commit');
    evidence.push(
      await save(`${prefix}/npm-provenance-statement.json`, payload, spec.attestationUrl, {
        extraction:
          'Decoded SLSA dsseEnvelope.payload; provenance source recorded, no claim of independent signature verification.',
      }),
    );
  }
  const attribution = `# ${spec.name} ${spec.version}\n\nDeclared license: ${item.license}.\n\n${spec.basis}\n\n${packageJson.author ? `Upstream author metadata (not a newly invented copyright notice): ${typeof packageJson.author === 'string' ? packageJson.author : JSON.stringify(packageJson.author)}.\n\n` : ''}Source revision: ${spec.upstreamCommit}.\n\nThe original package metadata is preserved in upstream-package.json. Full terms are in ${licenseFiles.map((file) => file.path.split('/').at(-1)).join(', ')}. SPDX template placeholders, if present, are intentionally preserved; they are not missing project configuration fields.\n\nThis supplement records the existing grant and supplied attribution; PugPort does not relicense the dependency or claim its authorship.\n`;
  const attributionFile = await save(`${prefix}/ATTRIBUTION.md`, Buffer.from(attribution), item.resolved, {
    origin: 'PugPort distribution attribution note; source license text is kept in separate files.',
  });
  components.push({
    name: spec.name,
    version: spec.version,
    declaredLicense: item.license,
    developmentOnly: item.dev === true,
    packagePaths: entries.map(([path]) => path),
    packageIntegrity: item.integrity,
    tarballUrl: item.resolved,
    tarballSha256: hash(archive),
    upstreamCommit: spec.upstreamCommit,
    basis: spec.basis,
    licenseFiles,
    attributionFile,
    evidence,
  });
}
await writeFile(
  manifestPath,
  `${JSON.stringify({ ...previous, schemaVersion: 1, scope: previous?.scope ?? 'Reviewed npm package/version omissions. Exact package grants plus original or explicitly identified standard license terms; no certification of all bundled native dependencies.', components: [...components, ...retained], unresolved: previous?.unresolved ?? [] }, null, 2)}\n`,
);
console.log(
  `Refreshed ${components.length} fixed-version npm license supplements from public sources; package tarballs match package-lock.json SHA-512. Retained ${retained.length} verified supplements unchanged.`,
);

// Software bill of materials for a release: the production dependency tree as CycloneDX JSON (npm's own generator),
// written next to the ZIP as release/tablight-<version>.sbom.cdx.json. npm names the root after the folder it runs in;
// the package's own name and version replace it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const raw = execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--sbom-type', 'application', '--omit', 'dev'], {
  encoding: 'utf8',
  maxBuffer: 64 << 20,
});
const bom = JSON.parse(raw);
if (bom.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components)) throw new Error('npm sbom did not return a CycloneDX document');
bom.metadata.component = { ...bom.metadata.component, name: pkg.name, version: pkg.version, 'bom-ref': `${pkg.name}@${pkg.version}` };
mkdirSync('release', { recursive: true });
const out = `release/${pkg.name}-${pkg.version}.sbom.cdx.json`;
writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`sbom: ${out} (${bom.components.length} components)`);

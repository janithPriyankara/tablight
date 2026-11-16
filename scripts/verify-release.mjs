// Release gate (stub; extended in Task 16): manifest permissions/CSP + model hashes in dist/.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_FILES, MODEL_ID } from './model-manifest.mjs';
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const errors = [];
const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
const perms = JSON.stringify([...manifest.permissions].sort());
if (perms !== JSON.stringify(['alarms', 'favicon', 'offscreen', 'storage', 'tabs', 'unlimitedStorage'])) {
  errors.push(`unexpected permissions: ${perms}`);
}
if (JSON.stringify(manifest.optional_permissions) !== '["tabGroups"]') errors.push('unexpected optional_permissions');
for (const k of ['host_permissions', 'content_scripts']) if (k in manifest) errors.push(`${k} must not be present`);
if (manifest.incognito !== 'not_allowed') errors.push('incognito must be not_allowed');
if (manifest.content_security_policy?.extension_pages !== CSP) errors.push('CSP mismatch');
for (const [file, expected] of Object.entries(MODEL_FILES)) {
  try {
    const actual = createHash('sha256').update(await readFile(join(dist, 'models', ...MODEL_ID.split('/'), file))).digest('hex');
    if (actual !== expected) errors.push(`model hash mismatch: ${file}`);
  } catch {
    errors.push(`model file missing from dist: ${file}`);
  }
}
if (errors.length) {
  console.error(errors.map((e) => `FAIL ${e}`).join('\n'));
  process.exit(1);
}
console.log('verify-release: OK');

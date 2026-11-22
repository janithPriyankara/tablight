// Prints the head's labels and each label's seed descriptions (src/classify/seeds.ts) as JSON, for finetune.py.
//
//   node scripts/finetune/labels.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { STARTER_GROUPS } = (await runnerImport(join(root, 'src/classify/seeds.ts'))).module;
process.stdout.write(JSON.stringify(STARTER_GROUPS.map((g) => ({ id: g.id, name: g.name, seeds: g.seeds }))));

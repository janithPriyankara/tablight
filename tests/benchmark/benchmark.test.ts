// The sealed accuracy benchmark. Scored once, at the end of the accuracy plan: skipped unless BENCHMARK=1.
// Prints aggregates only; never log rows. An `other` tab left Unsorted counts as right in overall and recall
// (not in precision, which is over grouped tabs); an `other` tab put in a group is wrong.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSessionSim, type SessionRow } from '../quality/sessions-sim';
type Row = SessionRow & { also?: string[] };
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
describe.skipIf(!process.env.BENCHMARK)('sealed benchmark', () => {
  it('reports strict and lenient precision, coverage and overall accuracy', async () => {
    const rows: Row[] = JSON.parse(await readFile(resolve(import.meta.dirname, 'benchmark.json'), 'utf8'));
    const { simulate } = await loadSessionSim();
    const byKey = new Map(rows.map((r) => [r, r] as const));
    for (const [name, neighbours] of [['with neighbours', 'shipped'], ['without neighbours', null]] as const) {
      let grouped = 0, strict = 0, lenient = 0, otherKept = 0; // otherKept: `other` tabs correctly left Unsorted
      const perLabel = new Map<string, { n: number; right: number }>();
      await simulate(rows, {
        neighbours, userShare: 0, seeds: [1],
        record: (row, groupId) => {
          const r = byKey.get(row as Row)!;
          const l = perLabel.get(r.group) ?? { n: 0, right: 0 };
          l.n++;
          perLabel.set(r.group, l);
          if (groupId === null) {
            if (r.group === 'other') { otherKept++; l.right++; }
            return;
          }
          grouped++;
          if (groupId === r.group) { strict++; l.right++; lenient++; }
          else if (r.also?.includes(groupId)) lenient++;
        },
      });
      const total = rows.length;
      console.log(
        `[benchmark ${name}] total ${total}, grouped ${grouped}: coverage ${pct(grouped, total)}\n` +
          `  strict:  precision ${pct(strict, grouped)}, overall ${pct(strict + otherKept, total)}\n` +
          `  lenient: precision ${pct(lenient, grouped)}, overall ${pct(lenient + otherKept, total)}\n` +
          `  strict recall per label: ${[...perLabel].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ${v.right}/${v.n}`).join(', ')}`,
      );
      expect(grouped).toBeGreaterThan(0);
    }
  }, 600_000);
});

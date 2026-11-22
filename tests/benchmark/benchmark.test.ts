// v1 (benchmark.json beside this file) was scored once on 2026-11-20 and stays as the record; see docs/accuracy.md.
// This test scores v2 (v2/benchmark.json).
// The sealed accuracy benchmark. Scored once, at the end of the accuracy plan: skipped unless BENCHMARK=1.
// Prints aggregates only; never log rows. Headline = precision and coverage over non-`other` tabs (score.ts);
// `other` tabs are reported apart and never count as right. Every person has every group (allGroups), so a tab can
// land in any label's group, not only the labels that person's own tabs carry.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSessionSim, type SessionRow } from '../quality/sessions-sim';
import { newTally, report, tally } from './score';
type Row = SessionRow & { also?: string[] };
describe.skipIf(!process.env.BENCHMARK)('sealed benchmark', () => {
  it('reports strict and lenient precision, coverage and overall accuracy on non-other tabs', async () => {
    const rows: Row[] = JSON.parse(await readFile(resolve(import.meta.dirname, 'v2/benchmark.json'), 'utf8'));
    const { simulate } = await loadSessionSim();
    for (const [name, neighbours] of [['with neighbours', 'shipped'], ['without neighbours', null]] as const) {
      const t = newTally();
      await simulate(rows, {
        neighbours, userShare: 0, seeds: [1], allGroups: true,
        record: (row, groupId) => tally(t, row as Row, groupId),
      });
      console.log(report(name, t));
      expect(t.total + t.others).toBe(rows.length);
      expect(t.grouped).toBeGreaterThan(0);
    }
  }, 600_000);
});

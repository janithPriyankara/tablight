import { beforeAll, describe, expect, it } from 'vitest';
import tune from '../../training/sessions-tune.json';
import sessions from './sessions.json';
import { NEIGHBOUR_K, NEIGHBOUR_MIN, type NeighbourOpts } from '../../src/classify/pick';
import { loadSessionSim, SCENARIOS, score, SEEDS, type SessionRow, type SimResult } from './sessions-sim';
import type { QualityHead } from './model';

// The neighbour step (pickGroup): an unsure tab follows its closest grouped tabs, at the head's validated
// similarity bar (not tuned here). Scored on browsing sessions of imagined people, replayed in two scenarios
// (SCENARIOS: automatic placements only, and 30% placed by hand), with score = right − 2 × (wrong + `other` put in
// a group). sessions-tune.json gets a printed diagnostic sweep; sessions.json gets a no-harm gate (aggregates only).
let simulate: Awaited<ReturnType<typeof loadSessionSim>>['simulate'];
let head: QualityHead;
beforeAll(async () => {
  ({ simulate, head } = await loadSessionSim());
}, 300_000);

const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;
const line = (name: string, r: SimResult) =>
  `  ${name.padEnd(26)} right ${String(r.right).padStart(4)}  wrong ${String(r.wrong).padStart(4)} (${pct(r.wrong, r.total)})  ` +
  `unsorted ${String(r.unsorted).padStart(4)}  of ${r.total}  right−2×(wrong+other) ${String(score(r)).padStart(5)}  ` +
  `'other' auto-assigned ${r.otherAssigned}/${r.others} (${pct(r.otherAssigned, r.others)})`;
const brief = (r: SimResult) => `${r.right}/${r.wrong}/${r.unsorted} other ${r.otherAssigned} ${String(score(r)).padStart(5)}`;
const shippedOpts = (): NeighbourOpts => ({ similarity: head.similarity, min: NEIGHBOUR_MIN, k: NEIGHBOUR_K });

describe('neighbour step', () => {
  it('diagnostic sweep on the tuning sessions (printed, not gated, not used to choose constants)', async () => {
    const rows = tune as SessionRow[];
    const run = (neighbours: NeighbourOpts | null) =>
      Promise.all(SCENARIOS.map(({ userShare }) => simulate(rows, { neighbours, userShare })));
    const sum = (rs: SimResult[]) => rs.reduce((t, r) => t + score(r), 0);
    const row = (name: string, rs: SimResult[]) => `${name.padEnd(32)}${rs.map(brief).join(' | ')} | ${sum(rs)}`;
    const out = [`TUNE sessions (${rows.length} tabs, ${SEEDS.length} replays per scenario)`];
    out.push(`${'setting'.padEnd(32)}${SCENARIOS.map((sc) => `${sc.name} (right/wrong/unsorted other score)`).join(' | ')} | sum`);
    out.push(row('no neighbours', await run(null)));
    const s = shippedOpts();
    out.push(row(`shipped: sim ${s.similarity} min ${s.min} k ${s.k}`, await run(s)));
    for (let sim = 0.5; sim <= 0.8 + 1e-9; sim += 0.02) {
      for (const min of [2, 3]) {
        for (const k of [5, 10]) {
          const o = { similarity: Number(sim.toFixed(2)), min, k };
          out.push(row(`sim ${o.similarity.toFixed(2)} min ${min} k ${String(k).padStart(2)}`, await run(o)));
        }
      }
    }
    console.log(out.join('\n'));
    // The sweep's stand-in for pickGroup's neighbour step is the product path itself at the shipped values.
    for (const { userShare } of SCENARIOS) {
      expect(await simulate(rows, { neighbours: 'shipped', userShare })).toEqual(await simulate(rows, { neighbours: s, userShare }));
    }
  }, 300_000);

  it('no-harm gate on the blind sessions, each scenario: score not lower, wrong ≤ +1 point, `other` in a group ≤ +2 points', async () => {
    const rows = sessions as SessionRow[];
    const out = [`SESSIONS (blind, ${rows.length} tabs, ${SEEDS.length} replays per scenario; no-harm gate)`];
    const results = [];
    for (const sc of SCENARIOS) {
      const none = await simulate(rows, { neighbours: null, userShare: sc.userShare });
      const ship = await simulate(rows, { neighbours: 'shipped', userShare: sc.userShare });
      out.push(`${sc.name}:`, line('no neighbours', none), line('shipped', ship));
      results.push({ none, ship });
    }
    console.log(out.join('\n'));
    for (const { none, ship } of results) {
      expect(score(ship)).toBeGreaterThanOrEqual(score(none));
      expect(ship.wrong / ship.total).toBeLessThanOrEqual(none.wrong / none.total + 0.01);
      expect(ship.otherAssigned / ship.others).toBeLessThanOrEqual(none.otherAssigned / none.others + 0.02);
    }
  }, 300_000);
});

import { beforeAll, describe, expect, it } from 'vitest';
import tune from '../../training/sessions-tune.json';
import sessions from './sessions.json';
import { NEIGHBOUR_K, NEIGHBOUR_MIN, NEIGHBOUR_SIMILARITY, type NeighbourOpts } from '../../src/classify/pick';
import { loadSessionSim, SCENARIOS, score, SEEDS, type SessionRow, type SimResult } from './sessions-sim';

// The neighbour step (pickGroup): an unsure tab follows its closest grouped tabs. Scored on browsing sessions of
// imagined people, replayed in two scenarios (SCENARIOS: automatic placements only, and 30% placed by hand).
// sessions-tune.json chooses the constants by the sum of right − 2 × (wrong + `other` put in a group) over both
// (printed sweep, not gated);
// sessions.json is never tuned on and printed as aggregates only.
let simulate: Awaited<ReturnType<typeof loadSessionSim>>['simulate'];
beforeAll(async () => {
  ({ simulate } = await loadSessionSim());
}, 300_000);

const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;
const line = (name: string, r: SimResult) =>
  `  ${name.padEnd(26)} right ${String(r.right).padStart(4)}  wrong ${String(r.wrong).padStart(4)} (${pct(r.wrong, r.total)})  ` +
  `unsorted ${String(r.unsorted).padStart(4)}  of ${r.total}  right−2×(wrong+other) ${String(score(r)).padStart(5)}  ` +
  `'other' auto-assigned ${r.otherAssigned}/${r.others} (${pct(r.otherAssigned, r.others)})`;
const brief = (r: SimResult) => `${r.right}/${r.wrong}/${r.unsorted} other ${r.otherAssigned} ${String(score(r)).padStart(5)}`;
const shipped: NeighbourOpts = { similarity: NEIGHBOUR_SIMILARITY, min: NEIGHBOUR_MIN, k: NEIGHBOUR_K };
const same = (a: NeighbourOpts, b: NeighbourOpts) => a.similarity === b.similarity && a.min === b.min && a.k === b.k;

describe('neighbour step', () => {
  it('sweep on the tuning sessions (printed, not gated)', async () => {
    const rows = tune as SessionRow[];
    const run = (neighbours: NeighbourOpts | null) =>
      Promise.all(SCENARIOS.map(({ userShare }) => simulate(rows, { neighbours, userShare })));
    const none = await run(null);
    const out = [`TUNE sessions (${rows.length} tabs, ${SEEDS.length} replays per scenario)`, 'no neighbours:'];
    SCENARIOS.forEach((sc, i) => out.push(line(sc.name, none[i]!)));
    out.push(`no neighbours sum ${none.reduce((t, r) => t + score(r), 0)}`);
    out.push(`setting                   ${SCENARIOS.map((sc) => `${sc.name} (right/wrong/unsorted other score)`).join(' | ')} | sum`);
    let best: { o: NeighbourOpts; sum: number; rs: SimResult[] } | null = null;
    for (let s = 0.5; s <= 0.8 + 1e-9; s += 0.02) {
      for (const min of [2, 3]) {
        for (const k of [5, 10]) {
          const o = { similarity: Number(s.toFixed(2)), min, k };
          const rs = await run(o);
          const sum = rs.reduce((t, r) => t + score(r), 0);
          out.push(`sim ${o.similarity.toFixed(2)} min ${min} k ${String(k).padStart(2)}    ${rs.map(brief).join(' | ')} | ${sum}`);
          // Ties go to the higher similarity (the loop runs upwards).
          if (!best || sum >= best.sum) best = { o, sum, rs };
        }
      }
    }
    out.push(`best: sim ${best!.o.similarity} min ${best!.o.min} k ${best!.o.k} (sum ${best!.sum}); ` +
      `shipped: sim ${NEIGHBOUR_SIMILARITY} min ${NEIGHBOUR_MIN} k ${NEIGHBOUR_K}`);
    if (!same(best!.o, shipped)) out.push('WARNING: the best setting on the tuning sessions differs from the shipped constants');
    console.log(out.join('\n'));
    // The sweep's stand-in for pickGroup's neighbour step is the product path itself at the shipped values.
    for (const { userShare } of SCENARIOS) {
      expect(await simulate(rows, { neighbours: 'shipped', userShare })).toEqual(await simulate(rows, { neighbours: shipped, userShare }));
    }
  }, 300_000);

  it('gate on the blind sessions, each scenario: a higher score, at most +2 points wrong, at most +5 points `other` in a group', async () => {
    const rows = sessions as SessionRow[];
    const out = [`SESSIONS (blind, ${rows.length} tabs, ${SEEDS.length} replays per scenario)`];
    const results = [];
    for (const sc of SCENARIOS) {
      const none = await simulate(rows, { neighbours: null, userShare: sc.userShare });
      const ship = await simulate(rows, { neighbours: 'shipped', userShare: sc.userShare });
      out.push(`${sc.name}:`, line('no neighbours', none), line('shipped', ship));
      results.push({ none, ship });
    }
    console.log(out.join('\n'));
    for (const { none, ship } of results) {
      expect(score(ship)).toBeGreaterThan(score(none));
      expect(ship.wrong / ship.total).toBeLessThanOrEqual(none.wrong / none.total + 0.02);
      expect(ship.otherAssigned / ship.others).toBeLessThanOrEqual(none.otherAssigned / none.others + 0.05);
    }
  }, 300_000);
});

import { beforeAll, describe, expect, it } from 'vitest';
import tune from '../../training/sessions-tune.json';
import sessions from './sessions.json';
import { NEIGHBOUR_K, NEIGHBOUR_MIN, NEIGHBOUR_SIMILARITY, type NeighbourOpts } from '../../src/classify/pick';
import { loadSessionSim, score, SEEDS, USER_SHARE, type SessionRow, type SimResult } from './sessions-sim';

// The neighbour step (pickGroup): an unsure tab follows its closest grouped tabs. Scored on browsing sessions of
// imagined people, replayed with a seeded 30% of tabs placed by the user. sessions-tune.json chooses the
// constants (printed sweep, not gated); sessions.json is never tuned on and printed as aggregates only.
let simulate: Awaited<ReturnType<typeof loadSessionSim>>['simulate'];
beforeAll(async () => {
  ({ simulate } = await loadSessionSim());
}, 300_000);

const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;
const line = (name: string, r: SimResult) =>
  `${name.padEnd(28)} right ${String(r.right).padStart(4)}  wrong ${String(r.wrong).padStart(4)} (${pct(r.wrong, r.total)})  ` +
  `unsorted ${String(r.unsorted).padStart(4)}  of ${r.total}  right−2×wrong ${String(score(r)).padStart(5)}  ` +
  `'other' auto-assigned ${r.otherAssigned}/${r.others} (${pct(r.otherAssigned, r.others)})`;
const replay = `${SEEDS.length} replays, ${USER_SHARE * 100}% placed by the user`;

describe('neighbour step', () => {
  it('sweep on the tuning sessions (printed, not gated)', async () => {
    const rows = tune as SessionRow[];
    const none = await simulate(rows, { neighbours: null });
    const out: string[] = [`TUNE sessions (${rows.length} tabs, ${replay})`, line('no neighbours', none)];
    let best: { o: NeighbourOpts; r: SimResult } | null = null;
    for (let s = 0.6; s <= 0.8 + 1e-9; s += 0.02) {
      for (const min of [2, 3]) {
        for (const k of [5, 10]) {
          const o = { similarity: Number(s.toFixed(2)), min, k };
          const r = await simulate(rows, { neighbours: o });
          out.push(line(`sim ${o.similarity.toFixed(2)} min ${min} k ${String(k).padStart(2)}`, r));
          // Ties go to the higher similarity (the loop runs upwards).
          if (!best || score(r) >= score(best.r)) best = { o, r };
        }
      }
    }
    out.push(`best: sim ${best!.o.similarity} min ${best!.o.min} k ${best!.o.k} (right−2×wrong ${score(best!.r)}); ` +
      `shipped: sim ${NEIGHBOUR_SIMILARITY} min ${NEIGHBOUR_MIN} k ${NEIGHBOUR_K}`);
    console.log(out.join('\n'));
    // The sweep's stand-in for pickGroup's neighbour step is the product path itself at the shipped values.
    const shipped = { similarity: NEIGHBOUR_SIMILARITY, min: NEIGHBOUR_MIN, k: NEIGHBOUR_K };
    expect(await simulate(rows, { neighbours: 'shipped' })).toEqual(await simulate(rows, { neighbours: shipped }));
  }, 300_000);

  it('gate on the blind sessions: the shipped step scores higher and adds at most 2 points of wrong groups', async () => {
    const rows = sessions as SessionRow[];
    const none = await simulate(rows, { neighbours: null });
    const shipped = await simulate(rows, { neighbours: 'shipped' });
    console.log([`SESSIONS (blind, ${rows.length} tabs, ${replay})`, line('no neighbours', none), line('shipped', shipped)].join('\n'));
    expect(score(shipped)).toBeGreaterThan(score(none));
    expect(shipped.wrong / shipped.total).toBeLessThanOrEqual(none.wrong / none.total + 0.02);
  }, 300_000);
});

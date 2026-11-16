import { beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixture.json';
import holdout from './holdout.json';
import { loadEmbedder } from './model';
import { assign, buildStarterGroups, DEFAULT_K, DEFAULT_THRESHOLD } from '../../src/classify/assign';
import { ruleGroup } from '../../src/classify/rules';
import { embedText } from '../../src/shared/url';
import type { Group } from '../../src/shared/types';
interface Row { title: string; url: string; group: string }
const dev = fixture as Row[];
const blind = holdout as Row[];
let classify: (rows: Row[]) => Promise<(string | null)[]>;
beforeAll(async () => {
  const embed = await loadEmbedder();
  const groups: Group[] = await buildStarterGroups(embed);
  // Caller pipeline: (user group) > ruleGroup > assign > Unsorted (null).
  classify = async (rows) => {
    const vecs = await embed(rows.map((r) => embedText(r)));
    return rows.map((r, i) => ruleGroup(r.url, r.title) ?? assign(vecs[i]!, groups).groupId);
  };
}, 180_000);
function score(rows: Row[], predicted: (string | null)[]) {
  let correct = 0;
  let total = 0;
  let others = 0;
  let otherAssigned = 0;
  rows.forEach((r, i) => {
    if (r.group === 'other') {
      others++;
      if (predicted[i] !== null) otherAssigned++;
      return;
    }
    total++;
    if (predicted[i] === r.group) correct++;
  });
  const acc = correct / total;
  const summary =
    `top-1 accuracy ${(acc * 100).toFixed(1)}% (${correct}/${total}); threshold ${DEFAULT_THRESHOLD}, k ${DEFAULT_K}; ` +
    `'other' items falsely auto-assigned ${otherAssigned}/${others} (${((otherAssigned / others) * 100).toFixed(0)}%)`;
  return { acc, summary };
}
describe('classifier accuracy', () => {
  it('puts AI-agent tabs from YouTube and from docs in AI & Agents', async () => {
    const rows = ['LangGraph agents tutorial', 'Agent SDK overview - Claude Docs'].map(
      (needle) => dev.find((r) => r.title.includes(needle))!,
    );
    expect(await classify(rows)).toEqual(['ai', 'ai']);
  });
  it('dev fixture (used for tuning): ≥ 85% top-1 on items not labelled other', async () => {
    const predicted = await classify(dev);
    const { acc, summary } = score(dev, predicted);
    const confusion = new Map<string, Map<string, number>>();
    dev.forEach((r, i) => {
      if (r.group === 'other') return;
      const p = predicted[i] ?? 'unsorted';
      const m = confusion.get(r.group) ?? new Map<string, number>();
      m.set(p, (m.get(p) ?? 0) + 1);
      confusion.set(r.group, m);
    });
    const lines = [...confusion].map(([label, m]) => {
      const n = [...m.values()].reduce((s, x) => s + x, 0);
      const wrong = [...m].filter(([p]) => p !== label).sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}×${c}`);
      return `  ${label.padEnd(12)} ${m.get(label) ?? 0}/${n}${wrong.length ? `  → ${wrong.join(', ')}` : ''}`;
    });
    console.log(`DEV ${summary}\n${lines.join('\n')}`);
    expect(acc).toBeGreaterThanOrEqual(0.85);
  });
  // Blind holdout written independently of the seeds and rules. Never tune against it:
  // only aggregate numbers are printed, by design.
  it('blind holdout: ≥ 85% top-1 on items not labelled other', async () => {
    const { acc, summary } = score(blind, await classify(blind));
    console.log(`HOLDOUT ${summary}`);
    expect(acc).toBeGreaterThanOrEqual(0.85);
  });
});

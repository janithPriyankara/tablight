import { beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixture.json';
import { loadEmbedder } from './model';
import { assign, buildStarterGroups, DEFAULT_K, DEFAULT_THRESHOLD } from '../../src/classify/assign';
import { ruleGroup } from '../../src/classify/rules';
import { embedText } from '../../src/shared/url';
import type { Group } from '../../src/shared/types';
interface Row { title: string; url: string; group: string }
const rows = fixture as Row[];
let predicted: (string | null)[] = [];
beforeAll(async () => {
  const embed = await loadEmbedder();
  const groups: Group[] = await buildStarterGroups(embed);
  const vecs = await embed(rows.map((r) => embedText(r)));
  // Caller pipeline: (user group) > ruleGroup > assign > Unsorted (null).
  predicted = rows.map((r, i) => ruleGroup(r.url, r.title) ?? assign(vecs[i]!, groups).groupId);
}, 180_000);
describe('classifier accuracy on the labelled fixture', () => {
  it('puts AI-agent tabs from YouTube and from docs in AI & Agents', () => {
    const at = (needle: string) => predicted[rows.findIndex((r) => r.title.includes(needle))];
    expect(at('LangGraph agents tutorial')).toBe('ai');
    expect(at('Agent SDK overview - Claude Docs')).toBe('ai');
  });

  it('reaches ≥ 85% top-1 accuracy on items not labelled other', () => {
    const confusion = new Map<string, Map<string, number>>();
    let correct = 0;
    let total = 0;
    rows.forEach((r, i) => {
      if (r.group === 'other') return;
      const p = predicted[i] ?? 'unsorted';
      total++;
      if (p === r.group) correct++;
      const m = confusion.get(r.group) ?? new Map<string, number>();
      m.set(p, (m.get(p) ?? 0) + 1);
      confusion.set(r.group, m);
    });
    const acc = correct / total;
    const lines = [...confusion].map(([label, m]) => {
      const ok = m.get(label) ?? 0;
      const n = [...m.values()].reduce((s, x) => s + x, 0);
      const wrong = [...m].filter(([p]) => p !== label).sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}×${c}`);
      return `  ${label.padEnd(12)} ${ok}/${n}${wrong.length ? `  → ${wrong.join(', ')}` : ''}`;
    });
    const others = rows.filter((r) => r.group === 'other').length;
    const otherAssigned = rows.filter((r, i) => r.group === 'other' && predicted[i] !== null).length;
    console.log(
      `top-1 accuracy ${(acc * 100).toFixed(1)}% (${correct}/${total}); ` +
        `threshold ${DEFAULT_THRESHOLD}, k ${DEFAULT_K}; ` +
        `'other' items falsely auto-assigned ${otherAssigned}/${others} ` +
        `(${((otherAssigned / others) * 100).toFixed(0)}%)\n` +
        lines.join('\n'),
    );
    expect(acc).toBeGreaterThanOrEqual(0.85);
  });
});

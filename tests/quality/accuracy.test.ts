import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixture.json';
import holdout from './holdout.json';
import { loadEmbedder } from './model';
import { buildStarterGroups, classify, type Head } from '../../src/classify/assign';
import { ruleGroup } from '../../src/classify/rules';
import { embedText } from '../../src/shared/url';
import type { Group } from '../../src/shared/types';
interface Row { title: string; url: string; group: string }
const dev = fixture as Row[];
const blind = holdout as Row[];
// HEAD_PATH / MODEL_PATH let model experiments run without touching the bundled files.
const headPath = process.env.HEAD_PATH ?? resolve(import.meta.dirname, '../../src/classify/head.json');
let head: Head & { pooling?: 'mean' | 'cls'; val?: { acc: number; otherAssigned: number } };
let run: (rows: Row[]) => Promise<(string | null)[]>;
beforeAll(async () => {
  head = JSON.parse(await readFile(headPath, 'utf8'));
  const embed = await loadEmbedder({ model: head.model, pooling: head.pooling, path: process.env.MODEL_PATH });
  const groups: Group[] = await buildStarterGroups(embed);
  // Caller pipeline: (user group) > ruleGroup > classify > Unsorted (null).
  run = async (rows) => {
    const vecs = await embed(rows.map((r) => embedText(r)));
    return rows.map((r, i) => ruleGroup(r.url, r.title) ?? classify(vecs[i]!, groups, head).groupId);
  };
}, 300_000);
describe('classifier accuracy', () => {
  it('puts AI-agent tabs from YouTube and from docs in AI & Agents', async () => {
    const rows = ['LangGraph agents tutorial', 'Agent SDK overview - Claude Docs'].map(
      (needle) => dev.find((r) => r.title.includes(needle))!,
    );
    expect(await run(rows)).toEqual(['ai', 'ai']);
  });
  // Blind holdout, written independently and never used for training or tuning.
  // Only aggregate numbers are printed, by design.
  it('blind holdout: ≥ 85% top-1, ≤ 35% of `other` pages auto-assigned', async () => {
    const predicted = await run(blind);
    let correct = 0;
    let total = 0;
    let others = 0;
    let otherAssigned = 0;
    blind.forEach((r, i) => {
      if (r.group === 'other') {
        others++;
        if (predicted[i] !== null) otherAssigned++;
      } else {
        total++;
        if (predicted[i] === r.group) correct++;
      }
    });
    const acc = correct / total;
    const otherRate = otherAssigned / others;
    console.log(
      `HOLDOUT top-1 accuracy ${(acc * 100).toFixed(1)}% (${correct}/${total}); ` +
        `'other' auto-assigned ${otherAssigned}/${others} (${(otherRate * 100).toFixed(0)}%); ` +
        `model ${head.model}, threshold ${head.threshold}, similarity ${head.similarity}` +
        (head.val ? `; train-time val ${(head.val.acc * 100).toFixed(1)}%` : ''),
    );
    expect(acc).toBeGreaterThanOrEqual(0.85);
    expect(otherRate).toBeLessThanOrEqual(0.35);
  });
});

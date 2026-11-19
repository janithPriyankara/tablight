import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixture.json';
import holdout from './holdout.json';
import holdout2 from './holdout2.json';
import youtubeTopics from './youtube-topics.json';
import trainA from '../../training/train-a.json';
import trainB from '../../training/train-b.json';
import trainC from '../../training/train-c.json';
import { loadEmbedder } from './model';
import { buildStarterGroups, classify, type Head } from '../../src/classify/assign';
import { pickGroup } from '../../src/classify/pick';
import { ruleGroup } from '../../src/classify/rules';
import { embedText } from '../../src/shared/url';
import type { Group } from '../../src/shared/types';
interface Row { title: string; url: string; group: string }
const dev = fixture as Row[];
const blind = holdout as Row[];
const blind2 = holdout2 as Row[];
// HEAD_PATH / MODEL_PATH let model experiments run without touching the bundled files.
const headPath = process.env.HEAD_PATH ?? resolve(import.meta.dirname, '../../src/classify/head.json');
let head: Head & { pooling?: 'mean' | 'cls'; val?: { acc: number; otherAssigned: number } };
let run: (rows: Row[]) => Promise<(string | null)[]>;
/** The product pipeline with the installed (starter) groups: pickGroup, which adds the Videos fallback. */
let runProduct: (rows: Row[]) => Promise<(string | null)[]>;
beforeAll(async () => {
  head = JSON.parse(await readFile(headPath, 'utf8'));
  const embed = await loadEmbedder({ model: head.model, pooling: head.pooling, path: process.env.MODEL_PATH });
  const groups: Group[] = await buildStarterGroups(embed);
  // Caller pipeline: (user group) > ruleGroup > classify > Unsorted (null).
  run = async (rows) => {
    const vecs = await embed(rows.map((r) => embedText(r)));
    return rows.map((r, i) => ruleGroup(r.url, r.title) ?? classify(vecs[i]!, groups, head).groupId);
  };
  runProduct = async (rows) => {
    const vecs = await embed(rows.map((r) => embedText(r)));
    return rows.map((r, i) => pickGroup(r, vecs[i]!, groups, head).groupId);
  };
}, 300_000);
describe('classifier accuracy', () => {
  it('puts AI-agent tabs from YouTube and from docs in AI & Agents', async () => {
    const rows = ['LangGraph agents tutorial', 'Agent SDK overview - Claude Docs'].map(
      (needle) => dev.find((r) => r.title.includes(needle))!,
    );
    expect(await run(rows)).toEqual(['ai', 'ai']);
  });
  // Security tools, browser add-on pages and account pages have no group. They must stay Unsorted, not be guessed
  // into one (Browser Guard and AdBlock were once filed under Social). None of these rows is in the training pool.
  it('leaves security-tool, add-on and account pages Unsorted', async () => {
    const rows = [
      ['Browser Guard | Malwarebytes', 'https://my.malwarebytes.com/public/browser-guard'],
      ['Norton 360 | Antivirus and VPN', 'https://us.norton.com/products/norton-360-deluxe'],
      ['NordVPN: Best VPN service', 'https://nordvpn.com/'],
      ['Kaspersky Free Antivirus', 'https://www.kaspersky.com/free-antivirus'],
      ['Microsoft Defender', 'https://security.microsoft.com/'],
      ['Thanks for installing Adblock Plus', 'https://adblockplus.org/en/installed'],
      ['Tampermonkey - Microsoft Edge Addons', 'https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd'],
    ].map(([title, url]) => ({ title: title!, url: url!, group: 'other' }));
    expect(await run(rows)).toEqual(rows.map(() => null));
  });
  /** Top-1 on non-`other` rows and the share of `other` rows pushed into a group. Aggregates only. */
  async function measure(rows: Row[]) {
    const predicted = await run(rows);
    let correct = 0, total = 0, others = 0, otherAssigned = 0, wrong = 0;
    rows.forEach((r, i) => {
      if (r.group === 'other') {
        others++;
        if (predicted[i] !== null) otherAssigned++;
      } else {
        total++;
        if (predicted[i] === r.group) correct++;
        else if (predicted[i] !== null) wrong++;
      }
    });
    return { acc: correct / total, correct, total, wrong, otherRate: others ? otherAssigned / others : 0, otherAssigned, others };
  }
  const line = (name: string, m: Awaited<ReturnType<typeof measure>>) =>
    `${name} top-1 accuracy ${(m.acc * 100).toFixed(1)}% (${m.correct}/${m.total}, ${m.wrong} in a wrong group); ` +
    `'other' auto-assigned ${m.otherAssigned}/${m.others} (${(m.otherRate * 100).toFixed(0)}%)`;
  // Blind holdouts, written independently and never used for training or tuning.
  // Only aggregate numbers are printed, by design.
  it('blind holdout: ≥ 85% top-1, ≤ 35% of `other` pages auto-assigned', async () => {
    const m = await measure(blind);
    console.log(
      `${line('HOLDOUT', m)}; model ${head.model}, threshold ${head.threshold}, similarity ${head.similarity}` +
        (head.val ? `; train-time val ${(head.val.acc * 100).toFixed(1)}%` : ''),
    );
    expect(m.acc).toBeGreaterThanOrEqual(0.85);
    expect(m.otherRate).toBeLessThanOrEqual(0.35);
  }, 120_000); // Full-dataset inference can exceed Vitest's 5s default on shared CI workers.
  // holdout2: 300 tabs from eight imagined people, written after the model choice and never seen while tuning.
  // "clean" leaves out rows whose URL or title also occurs in the training pool (common pages like an inbox).
  it('blind holdout 2: ≥ 82% top-1, ≤ 35% of `other` pages auto-assigned', async () => {
    const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
    const pool = [...(trainA as Row[]), ...(trainB as Row[]), ...(trainC as Row[]), ...dev];
    const urls = new Set(pool.map((r) => norm(r.url)));
    const titles = new Set(pool.map((r) => r.title.toLowerCase()));
    const clean = blind2.filter((r) => !urls.has(norm(r.url)) && !titles.has(r.title.toLowerCase()));
    const m = await measure(blind2);
    const c = await measure(clean);
    console.log(`${line('HOLDOUT2', m)}\n${line(`HOLDOUT2 clean (${clean.length} rows)`, c)}`);
    expect(m.acc).toBeGreaterThanOrEqual(0.82);
    expect(m.otherRate).toBeLessThanOrEqual(0.35);
  }, 120_000); // Runs inference over both the full and decontaminated holdout.
  // youtube-topics.json: synthetic YouTube videos written blind from training/LABELING.md, never trained on.
  // A video about a subject belongs in that subject's group; one with no clear subject belongs in `videos`.
  // TOPIC_MIN is the rate measured on the first run after the YouTube re-labelling retrain (2026-11-19): 81/90.
  it('youtube topic first: ≥ 90% of topic videos in their topic group, ≥ 70% of no-topic videos in Videos', async () => {
    const TOPIC_MIN = 0.9;
    const rows = youtubeTopics as Row[];
    const predicted = await runProduct(rows);
    let topic = 0, topicHit = 0, topicVideos = 0, plain = 0, plainHit = 0;
    rows.forEach((r, i) => {
      if (r.group === 'videos') {
        plain++;
        if (predicted[i] === 'videos') plainHit++;
      } else {
        topic++;
        if (predicted[i] === r.group) topicHit++;
        else if (predicted[i] === 'videos') topicVideos++;
      }
    });
    const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
    console.log(
      `YOUTUBE topic videos in their topic group ${pct(topicHit, topic)} (${topicHit}/${topic}, ${topicVideos} parked in videos); ` +
        `no-topic videos in videos ${pct(plainHit, plain)} (${plainHit}/${plain})`,
    );
    expect(topicHit / topic).toBeGreaterThanOrEqual(TOPIC_MIN);
    expect(plainHit / plain).toBeGreaterThanOrEqual(0.7);
  }, 120_000);
});

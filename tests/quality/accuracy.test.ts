import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixture.json';
import holdout from './holdout.json';
import holdout2 from './holdout2.json';
import holdout3 from './holdout3.json';
import youtubeTopics from './youtube-topics.json';
import youtubeMessy from './youtube-messy.json';
import trainA from '../../training/train-a.json';
import trainB from '../../training/train-b.json';
import trainC from '../../training/train-c.json';
import { loadEmbedder } from './model';
import { buildStarterGroups, buildTrainedGroup, classify, TRAINED_IDS, type Head } from '../../src/classify/assign';
import { pickGroup } from '../../src/classify/pick';
import { ruleGroup } from '../../src/classify/rules';
import { embedText } from '../../src/shared/url';
import type { Group } from '../../src/shared/types';
interface Row { title: string; url: string; group: string }
const dev = fixture as Row[];
const blind = holdout as Row[];
const blind2 = holdout2 as Row[];
const blind3 = holdout3 as Row[];
// HEAD_PATH / MODEL_PATH let model experiments run without touching the bundled files.
const headPath = process.env.HEAD_PATH ?? resolve(import.meta.dirname, '../../src/classify/head.json');
let head: Head & { pooling?: 'mean' | 'cls'; val?: { acc: number; otherAssigned: number } };
/** The caller pipeline with the installed (starter) groups, or with `all` groups (starter plus every on-demand one). */
let run: (rows: Row[], set?: 'installed' | 'all') => Promise<(string | null)[]>;
/** The product pipeline with the installed (starter) groups: pickGroup, which adds the Videos fallback. */
let runProduct: (rows: Row[], set?: 'installed' | 'all') => Promise<(string | null)[]>;
beforeAll(async () => {
  head = JSON.parse(await readFile(headPath, 'utf8'));
  const embed = await loadEmbedder({ model: head.model, pooling: head.pooling, path: process.env.MODEL_PATH });
  const groups: Group[] = await buildStarterGroups(embed);
  const allGroups: Group[] = [...groups, ...(await Promise.all([...TRAINED_IDS].map((id) => buildTrainedGroup(id, embed))))];
  // Caller pipeline: (user group) > ruleGroup > classify > Unsorted (null).
  run = async (rows, set = 'installed') => {
    const vecs = await embed(rows.map((r) => embedText(r)));
    const gs = set === 'all' ? allGroups : groups;
    return rows.map((r, i) => ruleGroup(r.url, r.title) ?? classify(vecs[i]!, gs, head).groupId);
  };
  runProduct = async (rows, set = 'installed') => {
    const vecs = await embed(rows.map((r) => embedText(r)));
    const gs = set === 'all' ? allGroups : groups;
    return rows.map((r, i) => pickGroup(r, vecs[i]!, gs, head).groupId);
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
  async function measure(rows: Row[], set: 'installed' | 'all' = 'installed', runner = run) {
    const predicted = await runner(rows, set);
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
    return {
      acc: correct / total, correct, total, wrong, otherRate: others ? otherAssigned / others : 0, otherAssigned, others, predicted,
    };
  }
  const line = (name: string, m: Awaited<ReturnType<typeof measure>>) =>
    `${name} top-1 accuracy ${(m.acc * 100).toFixed(1)}% (${m.correct}/${m.total}, ${m.wrong} in a wrong group); ` +
    `'other' auto-assigned ${m.otherAssigned}/${m.others} (${(m.otherRate * 100).toFixed(0)}%)`;
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  const OTHER_MAX = 0.35;
  const HOLDOUT_MIN = 0.85;
  const HOLDOUT2_MIN = 0.82;
  // Blind holdouts, written independently and never used for training or tuning.
  // Only aggregate numbers are printed, by design. Old gates use the installed (starter) groups and are scored on
  // the product pipeline (pickGroup, with the Videos fallback); the caller pipeline's numbers print alongside.
  it(`blind holdout: ≥ ${pc(HOLDOUT_MIN)} top-1, ≤ ${pc(OTHER_MAX)} of \`other\` pages auto-assigned`, async () => {
    const m = await measure(blind, 'installed', runProduct);
    const old = await measure(blind);
    console.log(
      `${line('HOLDOUT', m)}; model ${head.model}, threshold ${head.threshold}, similarity ${head.similarity}` +
        (head.val ? `; train-time val ${(head.val.acc * 100).toFixed(1)}%` : '') +
        `\n${line('HOLDOUT (caller pipeline, not gated)', old)}`,
    );
    expect(m.acc).toBeGreaterThanOrEqual(HOLDOUT_MIN);
    expect(m.otherRate).toBeLessThanOrEqual(OTHER_MAX);
  }, 120_000); // Full-dataset inference can exceed Vitest's 5s default on shared CI workers.
  // holdout2: 300 tabs from eight imagined people, written after the model choice and never seen while tuning.
  // "clean" leaves out rows whose URL or title also occurs in the training pool (common pages like an inbox).
  it(`blind holdout 2: ≥ ${pc(HOLDOUT2_MIN)} top-1, ≤ ${pc(OTHER_MAX)} of \`other\` pages auto-assigned`, async () => {
    const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
    const pool = [...(trainA as Row[]), ...(trainB as Row[]), ...(trainC as Row[]), ...dev];
    const urls = new Set(pool.map((r) => norm(r.url)));
    const titles = new Set(pool.map((r) => r.title.toLowerCase()));
    const clean = blind2.filter((r) => !urls.has(norm(r.url)) && !titles.has(r.title.toLowerCase()));
    const m = await measure(blind2, 'installed', runProduct);
    const c = await measure(clean, 'installed', runProduct);
    const old = await measure(blind2);
    const oldC = await measure(clean);
    console.log(
      `${line('HOLDOUT2', m)}\n${line(`HOLDOUT2 clean (${clean.length} rows)`, c)}` +
        `\n${line('HOLDOUT2 (caller pipeline, not gated)', old)}\n${line(`HOLDOUT2 clean (${clean.length} rows, caller pipeline, not gated)`, oldC)}`,
    );
    expect(m.acc).toBeGreaterThanOrEqual(HOLDOUT2_MIN);
    expect(m.otherRate).toBeLessThanOrEqual(OTHER_MAX);
  }, 120_000); // Runs inference over both the full and decontaminated holdout.
  // holdout3: written blind from training/LABELING.md after the 14 on-demand labels were added, at least 28 rows
  // per new label plus rows across the old labels and `other`. Scored with every group present (starter plus each
  // on-demand group), as for a user who has picked them all. Prints aggregates and per-label rates only.
  const HOLDOUT3_MIN = 0.82;
  const NEW_LABEL_MIN = 0.7;
  it(`blind holdout 3: ≥ ${pc(HOLDOUT3_MIN)} top-1 with all groups, each on-demand label ≥ ${pc(NEW_LABEL_MIN)}`, async () => {
    const m = await measure(blind3, 'all');
    console.log(line('HOLDOUT3 (all groups)', m));
    const per = new Map<string, { hit: number; n: number }>();
    blind3.forEach((r, i) => {
      if (r.group === 'other') return;
      const s = per.get(r.group) ?? { hit: 0, n: 0 };
      s.n++;
      if (m.predicted[i] === r.group) s.hit++;
      per.set(r.group, s);
    });
    const rate = (id: string) => per.get(id)!.hit / per.get(id)!.n;
    const rows = [...per.keys()].sort((a, b) => Number(TRAINED_IDS.has(b)) - Number(TRAINED_IDS.has(a)) || a.localeCompare(b));
    console.log(
      rows.map((id) => `  ${TRAINED_IDS.has(id) ? '*' : ' '} ${id.padEnd(12)} ${pc(rate(id)).padStart(4)} (${per.get(id)!.hit}/${per.get(id)!.n})`).join('\n'),
    );
    expect(m.acc).toBeGreaterThanOrEqual(HOLDOUT3_MIN);
    const weak = [...TRAINED_IDS].filter((id) => per.has(id) && rate(id) < NEW_LABEL_MIN);
    expect(weak).toEqual([]);
    expect([...TRAINED_IDS].filter((id) => !per.has(id))).toEqual([]);
  }, 120_000);
  // youtube-topics.json: synthetic YouTube videos written blind from training/LABELING.md, never trained on.
  // A video about a subject belongs in that subject's group; one with no clear subject belongs in `videos`.
  // TOPIC_MIN is the rate measured with the YouTube bar (pickGroup's YOUTUBE_THRESHOLD) after the retrain for the
  // hashtag-as-words input (2026-11-19): 81/90 (77/90 before it). The bar was tuned on this set, so it is no longer
  // blind for the bar; youtube-messy.json below is the honest score. Scored with the installed groups, so a video
  // the head gives an on-demand label (say, a shopping haul it reads as fashion) falls back to Videos and counts as a
  // miss here.
  const TOPIC_MIN = 81 / 90;
  const NO_TOPIC_MIN = 0.7;
  /** Product pipeline over YouTube rows: topic videos in their topic group, no-topic videos in Videos. Aggregates only. */
  async function youtubeRates(name: string, rows: Row[], set: 'installed' | 'all' = 'installed') {
    const predicted = await runProduct(rows, set);
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
      `${name} topic videos in their topic group ${pct(topicHit, topic)} (${topicHit}/${topic}, ${topicVideos} parked in videos); ` +
        `no-topic videos in videos ${pct(plainHit, plain)} (${plainHit}/${plain})`,
    );
    return { topic: topicHit / topic, plain: plainHit / plain };
  }
  it(`youtube topic first: ≥ 81/90 (${pc(TOPIC_MIN)}) of topic videos in their topic group, ≥ ${pc(NO_TOPIC_MIN)} of no-topic videos in Videos`, async () => {
    const r = await youtubeRates('YOUTUBE', youtubeTopics as Row[]);
    expect(r.topic).toBeGreaterThanOrEqual(TOPIC_MIN);
    expect(r.plain).toBeGreaterThanOrEqual(NO_TOPIC_MIN);
  }, 120_000);
  // youtube-messy.json: 221 YouTube videos (159 about a subject, 62 with none) with the titles real tabs carry:
  // notification counters "(1157) ", hashtag-heavy Shorts, clickbait and "Talk — Speaker (Conf)" talks. Written
  // blind from training/LABELING.md and never trained or tuned on. MESSY_TOPIC_MIN is the rate first measured with the
  // YouTube bar (2026-11-19): 73/159 (70/159 before it). 66 of the 159 have an on-demand label, so with the installed
  // groups they can only be parked in Videos; the all-groups line is printed for them and not gated.
  const MESSY_TOPIC_MIN = 73 / 159;
  it(`youtube messy titles: ≥ 73/159 (${pc(MESSY_TOPIC_MIN)}) of topic videos in their topic group, ≥ ${pc(NO_TOPIC_MIN)} of no-topic videos in Videos`, async () => {
    const r = await youtubeRates('YOUTUBE MESSY', youtubeMessy as Row[]);
    await youtubeRates('YOUTUBE MESSY (all groups, not gated)', youtubeMessy as Row[], 'all');
    expect(r.topic).toBeGreaterThanOrEqual(MESSY_TOPIC_MIN);
    expect(r.plain).toBeGreaterThanOrEqual(NO_TOPIC_MIN);
  }, 120_000);
});

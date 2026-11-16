import { cosine } from '../shared/vec';

export interface Suggestion {
  itemIds: string[];
  name: string;
}

export const CLUSTER_THRESHOLD = 0.55;
export const CLUSTER_MIN_SIZE = 3;
/** O(n²) memory/time: only the most recent items are clustered. */
export const MAX_CLUSTER_ITEMS = 2000;

interface ClusterItem {
  id: string;
  title: string;
  domain: string;
  vec: number[];
}

/**
 * Average-link agglomerative clustering on cosine similarity, cut at `threshold`.
 * Uses the nearest-neighbour chain algorithm (valid because average link is reducible), O(n²).
 * Items are expected oldest-first; only the last MAX_CLUSTER_ITEMS are clustered.
 */
export function suggestGroups(
  items: ClusterItem[],
  opts: { threshold?: number; minSize?: number } = {},
): Suggestion[] {
  const threshold = opts.threshold ?? CLUSTER_THRESHOLD;
  const minSize = opts.minSize ?? CLUSTER_MIN_SIZE;
  const xs = items.slice(-MAX_CLUSTER_ITEMS);
  const n = xs.length;
  if (n === 0) return [];

  const sim = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosine(xs[i]!.vec, xs[j]!.vec);
      sim[i * n + j] = s;
      sim[j * n + i] = s;
    }
  }
  const members: number[][] = xs.map((_, i) => [i]);
  const active = new Set<number>(xs.map((_, i) => i));
  const done: number[][] = [];
  const chain: number[] = [];

  while (active.size > 1) {
    if (chain.length === 0) chain.push(active.values().next().value!);
    const a = chain[chain.length - 1]!;
    const prev = chain.length > 1 ? chain[chain.length - 2]! : -1;
    let b = prev;
    let best = prev >= 0 ? sim[a * n + prev]! : -Infinity;
    for (const k of active) {
      if (k === a) continue;
      const s = sim[a * n + k]!;
      if (s > best) {
        best = s;
        b = k;
      }
    }
    if (best < threshold) {
      // Reducibility: no later merge can bring `a` above the threshold. Finalise it.
      active.delete(a);
      done.push(members[a]!);
      chain.pop();
      continue;
    }
    if (b === prev) {
      chain.pop();
      chain.pop();
      const na = members[a]!.length;
      const nb = members[b]!.length;
      for (const k of active) {
        if (k === a || k === b) continue;
        const s = (na * sim[a * n + k]! + nb * sim[b * n + k]!) / (na + nb);
        sim[a * n + k] = s;
        sim[k * n + a] = s;
      }
      members[a] = members[a]!.concat(members[b]!);
      active.delete(b);
    } else {
      chain.push(b);
    }
  }
  for (const k of active) done.push(members[k]!);

  const corpus = xs.map((x) => x.title);
  return done
    .filter((m) => m.length >= minSize)
    .sort((p, q) => q.length - p.length)
    .map((m) => ({
      itemIds: m.map((i) => xs[i]!.id),
      name: nameCluster(m.map((i) => xs[i]!.title), m.map((i) => xs[i]!.domain), corpus),
    }));
}

const STOP = new Set(
  (
    'a an and are as at be but by can do does for from get got has have how i if in into is it its just ' +
    'me my new no not of on or our out so than that the their them then there these this to up us vs ' +
    'was we what when where which who why will with you your all any about after before more most best ' +
    'top one two use using via de la le el les des du en et un une der die das und ' +
    'com www http https html htm php org net io amp page home official site online free watch video ' +
    'videos youtube github reddit wikipedia google'
  ).split(' '),
);

function tokens(title: string): string[] {
  return (title.match(/[\p{L}\p{N}][\p{L}\p{N}+#.'-]*/gu) ?? [])
    .map((t) => t.replace(/[.'-]+$/, ''))
    .filter((t) => t.length >= 2 && /\p{L}/u.test(t) && !STOP.has(t.toLowerCase()));
}

/**
 * Names a cluster from its two most distinctive title terms (TF-IDF: share of the cluster's
 * titles containing the term, weighted by rarity in `corpus` when given), plus the domain
 * when at least 60% of the items share it. e.g. "Rust · async".
 */
export function nameCluster(titles: string[], domains: string[], corpus: string[] = []): string {
  const df = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  const forms = new Map<string, Map<string, number>>();
  let pos = 0;
  for (const title of titles) {
    const seen = new Set<string>();
    for (const t of tokens(title)) {
      const key = t.toLowerCase();
      const f = forms.get(key) ?? new Map<string, number>();
      f.set(t, (f.get(t) ?? 0) + 1);
      forms.set(key, f);
      if (!firstSeen.has(key)) firstSeen.set(key, pos++);
      if (seen.has(key)) continue;
      seen.add(key);
      df.set(key, (df.get(key) ?? 0) + 1);
    }
  }
  const corpusDf = new Map<string, number>();
  for (const title of corpus) {
    for (const key of new Set(tokens(title).map((t) => t.toLowerCase()))) {
      corpusDf.set(key, (corpusDf.get(key) ?? 0) + 1);
    }
  }
  const idf = (key: string) => (corpus.length ? Math.log((1 + corpus.length) / (1 + (corpusDf.get(key) ?? 0))) + 1 : 1);
  const display = (key: string) =>
    [...(forms.get(key) ?? new Map<string, number>()).entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? key;

  const ranked = [...df.keys()].sort(
    (p, q) => df.get(q)! * idf(q) - df.get(p)! * idf(p) || firstSeen.get(p)! - firstSeen.get(q)!,
  );
  // Prefer terms shared by several titles; fall back to the single best term.
  const shared = ranked.filter((k) => df.get(k)! >= 2);
  const terms = (shared.length ? shared : ranked).slice(0, 2).map(display);

  const domainCount = new Map<string, number>();
  for (const d of domains) if (d) domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
  const [topDomain, topCount] = [...domainCount.entries()].sort((p, q) => q[1] - p[1])[0] ?? ['', 0];
  const parts = [...terms];
  if (topDomain && domains.length && topCount / domains.length >= 0.6) parts.push(topDomain);
  return parts.length ? parts.join(' · ') : 'New group';
}

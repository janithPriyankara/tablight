import { MAX_EXEMPLARS, buildTrainedGroup } from '../classify/assign';
import { EMBED_MODEL } from '../classify/model';
import { STARTER_GROUPS } from '../classify/seeds';
import type { Group, Item } from '../shared/types';
import { mean, normalize } from '../shared/vec';
import type { Db } from './db';
import { embed } from './embedder';

/** chrome.storage.local: the embedding model the stored vectors (cache, exemplars, centroids) come from. */
export const EMBED_MODEL_KEY = 'embedModel';
/** The model every install embedded with before the key existed (Tablight 1.3.x and older). */
export const LEGACY_MODEL = 'Xenova/bge-small-en-v1.5';
/** Texts per embed call (the queue's batch size). */
const CHUNK = 32;
/** Rebuild attempts when the user teaches a group while the lessons are being embedded. */
const ATTEMPTS = 3;
const SEED_IDS: ReadonlySet<string> = new Set(STARTER_GROUPS.map((g) => g.id));

type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

async function readStored(): Promise<string | undefined> {
  const v: unknown = (await chrome.storage.local.get(EMBED_MODEL_KEY))[EMBED_MODEL_KEY];
  return typeof v === 'string' ? v : undefined;
}
/** Records that everything stored comes from the bundled model (a fresh install has nothing older). */
export async function markModelCurrent(): Promise<void> {
  await chrome.storage.local.set({ [EMBED_MODEL_KEY]: EMBED_MODEL });
}

/** Vectors of the texts that embedded; `failed` holds the ones that did not, even alone. */
interface Embedded { vecs: Map<string, number[]>; failed: Set<string>; ok: number; tried: number; error?: unknown }
/**
 * Embeds `texts` in chunks; a chunk that fails is retried text by text, so one bad text costs only its own vector.
 * `ok` / `tried` count the embed calls that worked / were made (all failing means the embedder is down).
 */
async function embedAll(texts: string[], embedFn: EmbedFn, into?: Embedded): Promise<Embedded> {
  const out = into ?? { vecs: new Map<string, number[]>(), failed: new Set<string>(), ok: 0, tried: 0 };
  const todo = [...new Set(texts)].filter((t) => !out.vecs.has(t) && !out.failed.has(t));
  const one = async (part: string[]): Promise<boolean> => {
    out.tried++;
    try {
      const vecs = await embedFn(part);
      if (vecs.length !== part.length) throw new Error('embedder returned the wrong number of vectors');
      part.forEach((t, k) => out.vecs.set(t, Array.from(vecs[k]!)));
      out.ok++;
      return true;
    } catch (e) {
      out.error = e;
      return false;
    }
  };
  for (let i = 0; i < todo.length; i += CHUNK) {
    const part = todo.slice(i, i + CHUNK);
    if (await one(part)) continue;
    if (part.length === 1) {
      out.failed.add(part[0]!);
      continue;
    }
    for (const t of part) if (!(await one([t]))) out.failed.add(t);
  }
  return out;
}
class LessonsChanged extends Error {}
/**
 * One pass: embeds every lesson text, the seeds of seed groups left without lessons and the names of the other
 * groups without lessons with the bundled model, then in one transaction rebuilds every group from them, dissolves
 * suggestions, drops each item's vector key, queues every classifiable item (quietly: its re-pick is never synced)
 * and empties the vector cache. Throws LessonsChanged when a group gained a lesson, or appeared, meanwhile.
 */
async function rebuild(db: Db, embedFn: EmbedFn): Promise<void> {
  const groups = (await db.groups.all()).filter((g) => !g.suggested);
  const known = new Set(groups.map((g) => g.id));
  const emb = await embedAll(groups.flatMap((g) => (g.lessons ?? []).map(([t]) => t)), embedFn);
  // A group with nothing taught gets back what it was built from: a seed group its seeds' centroid (as at
  // install), any other group its name's vector (as sync creates them). A taught group's centroid is its
  // exemplars' (assign.learn).
  const untaught = groups.filter((g) => !g.lessons?.length);
  const seedCentroid = new Map<string, number[] | null>();
  for (const g of untaught.filter((x) => SEED_IDS.has(x.id))) {
    emb.tried++;
    try {
      seedCentroid.set(g.id, (await buildTrainedGroup(g.id, embedFn)).centroid);
      emb.ok++;
    } catch (e) {
      emb.error = e;
    }
  }
  const named = untaught.filter((g) => !SEED_IDS.has(g.id));
  await embedAll(named.map((g) => g.name), embedFn, emb);
  // Nothing embedded at all: the embedder is down, so change nothing and let the caller retry.
  if (emb.tried > 0 && emb.ok === 0) throw emb.error instanceof Error ? emb.error : new Error('embedding failed');
  const nameCentroid = new Map(named.flatMap((g) => {
    const v = emb.vecs.get(g.name);
    return v ? [[g.id, normalize(v)] as const] : [];
  }));
  // Queue order: tabs the user placed (the neighbour step's evidence) first, then open and sleeping tabs (what the
  // user sees), saved tabs last.
  const rank = (i: Item) => (i.groupSource === 'user' ? 0 : i.state === 'stashed' ? 2 : 1);
  await db.tx(['items', 'groups', 'embeddings', 'queue'], async (s) => {
    const suggested = new Set<string>();
    for (const cur of await s.groups.all()) {
      if (cur.suggested) {
        // Its members are re-picked among regular groups and would leave it empty: dissolve it (not a dismissal,
        // so the topic may be suggested again from the new vectors).
        suggested.add(cur.id);
        await s.groups.delete(cur.id);
        continue;
      }
      if (!known.has(cur.id)) throw new LessonsChanged(); // created meanwhile (maybe taught with an old vector)
      const lessons = cur.lessons ?? [];
      if (lessons.some(([t]) => !emb.vecs.has(t) && !emb.failed.has(t))) throw new LessonsChanged();
      // Exemplars are rebuilt from the lessons' texts; an exemplar with no lesson (taught before lessons existed),
      // or whose text failed to embed, has no vector of the new model and is dropped. Lessons are all kept.
      const exemplars = lessons.flatMap(([t]) => {
        const v = emb.vecs.get(t);
        return v ? [v.slice()] : [];
      }).slice(-MAX_EXEMPLARS);
      const centroid = exemplars.length
        ? normalize(mean(exemplars))
        : (seedCentroid.get(cur.id) ?? nameCentroid.get(cur.id) ?? null);
      const next: Group = { ...cur, exemplars, centroid };
      await s.groups.put(next);
    }
    const order = (await s.items.all()).sort((a, b) => rank(a) - rank(b));
    for (const cur of order) {
      let next = cur;
      // embKey names a vector of the old model: without it nothing (search, teaching, regroup, the neighbour
      // pool) can read that vector. Local-only field: no updatedAt bump.
      if (next.embKey !== undefined) {
        const { embKey: _old, ...rest } = next;
        void _old;
        next = rest as Item;
      }
      // A dissolved suggestion's members go back to Unsorted. Unaccepted suggestions never sync (their tabs sync
      // with no group), so this is local only too.
      if (next.groupId !== null && suggested.has(next.groupId)) next = { ...next, groupId: null };
      if (next !== cur) await s.items.put(next);
      if (cur.classifiable) await s.queue.add(cur.id, { quiet: true });
    }
    await s.embeddings.clear();
  });
}
/** After a failed run, the next one waits this long (doubling per failure, at most MAX_BACKOFF_MS). */
export const BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
let failures = 0;
let retryAt = 0;
let lastError: unknown;
async function run(db: Db, embedFn: EmbedFn, now: number): Promise<boolean> {
  const stored = await readStored();
  if (stored === EMBED_MODEL) return false;
  if (stored === undefined && !(await db.groups.all()).length && !(await db.items.all()).length) {
    await markModelCurrent(); // nothing stored yet: a fresh install
    return false;
  }
  // Failing closed (classifying against old vectors would be worse), but without reloading the model for every
  // tab event while it keeps failing.
  if (now < retryAt) throw lastError instanceof Error ? lastError : new Error('model migration failed');
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await rebuild(db, embedFn);
        break;
      } catch (e) {
        if (!(e instanceof LessonsChanged) || attempt >= ATTEMPTS) throw e;
      }
    }
  } catch (e) {
    failures++;
    retryAt = now + Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (failures - 1));
    lastError = e;
    throw e;
  }
  failures = 0;
  retryAt = 0;
  await markModelCurrent();
  return true;
}
let running: Promise<boolean> | undefined;
/**
 * Moves stored data to the bundled model when it changed (chrome.storage.local `embedModel` differs from
 * EMBED_MODEL; a missing key with stored data counts as LEGACY_MODEL). Vectors of two models are never compared:
 * - every group's exemplars are rebuilt by embedding its `lessons` texts (lessons kept; exemplars without a lesson,
 *   or whose text will not embed, dropped); its centroid is the rebuilt exemplars' mean, else its seeds' (seed
 *   groups), else its name's vector;
 * - suggestions are dissolved (members back to Unsorted, no dismissal recorded);
 * - every item loses its vector key and every classifiable item is queued (user-placed first, saved tabs last), so
 *   the queue re-embeds it under a key that names the new model (tab-index embeddingKey) and re-picks automatic
 *   placements; the entries are `quiet`, so a re-pick never bumps updatedAt or reaches other devices;
 * - the vector cache is emptied.
 * The key is written only after all of that committed; if embedding fails nothing is changed or stored, and the
 * next call after a backoff (BACKOFF_MS, doubling, at most MAX_BACKOFF_MS; earlier calls reject at once) tries
 * again. Concurrent calls share one run. Resolves true when it migrated.
 */
export function migrateModel(db: Db, embedFn: EmbedFn = embed, now = Date.now()): Promise<boolean> {
  running ??= run(db, embedFn, now).finally(() => {
    running = undefined;
  });
  return running;
}

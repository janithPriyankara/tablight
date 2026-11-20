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

async function embedAll(texts: string[], embedFn: EmbedFn): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const todo = [...new Set(texts)];
  for (let i = 0; i < todo.length; i += CHUNK) {
    const part = todo.slice(i, i + CHUNK);
    const vecs = await embedFn(part);
    if (vecs.length !== part.length) throw new Error('embedder returned the wrong number of vectors');
    part.forEach((t, k) => out.set(t, Array.from(vecs[k]!)));
  }
  return out;
}

class LessonsChanged extends Error {}

/**
 * One pass: embeds every lesson text (and the seeds of seed groups left without exemplars) with the bundled
 * model, then in one transaction rebuilds every group from them, drops each item's vector key, queues every
 * classifiable item and empties the vector cache. Throws LessonsChanged when a group gained a lesson meanwhile.
 */
async function rebuild(db: Db, embedFn: EmbedFn): Promise<void> {
  const groups = await db.groups.all();
  const lessonTexts = groups.flatMap((g) => (g.lessons ?? []).map(([t]) => t));
  const vecOf = await embedAll(lessonTexts, embedFn);
  // A seed group with nothing taught gets its seed centroid back (as at install); a taught group's centroid is
  // its exemplars' (assign.learn).
  const seedCentroid = new Map<string, number[] | null>();
  for (const g of groups) {
    if (!SEED_IDS.has(g.id) || g.suggested || g.lessons?.length) continue;
    seedCentroid.set(g.id, (await buildTrainedGroup(g.id, embedFn)).centroid);
  }
  await db.tx(['items', 'groups', 'embeddings', 'queue'], async (s) => {
    for (const cur of await s.groups.all()) {
      const lessons = cur.lessons ?? [];
      if (lessons.some(([t]) => !vecOf.has(t))) throw new LessonsChanged();
      // Exemplars are rebuilt from the lessons' texts; an exemplar with no lesson (taught before lessons existed)
      // has no text to embed again and is dropped.
      const exemplars = lessons.map(([t]) => vecOf.get(t)!.slice()).slice(-MAX_EXEMPLARS);
      const centroid = exemplars.length ? normalize(mean(exemplars)) : (seedCentroid.get(cur.id) ?? null);
      const next: Group = { ...cur, exemplars, centroid };
      await s.groups.put(next);
    }
    for (const cur of await s.items.all()) {
      // embKey names a vector of the old model: without it nothing (search, teaching, regroup, the neighbour
      // pool) can read that vector. Local-only field: no updatedAt bump.
      if (cur.embKey !== undefined) {
        const { embKey: _old, ...rest } = cur;
        void _old;
        await s.items.put(rest as Item);
      }
      if (cur.classifiable) await s.queue.add(cur.id);
    }
    for (const k of await s.embeddings.keys()) await s.embeddings.delete(k);
  });
}

async function run(db: Db, embedFn: EmbedFn): Promise<boolean> {
  const stored = await readStored();
  if (stored === EMBED_MODEL) return false;
  if (stored === undefined && !(await db.groups.all()).length && !(await db.items.all()).length) {
    await markModelCurrent(); // nothing stored yet: a fresh install
    return false;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await rebuild(db, embedFn);
      break;
    } catch (e) {
      if (!(e instanceof LessonsChanged) || attempt >= ATTEMPTS) throw e;
    }
  }
  await markModelCurrent();
  return true;
}

let running: Promise<boolean> | undefined;
/**
 * Moves stored data to the bundled model when it changed (chrome.storage.local `embedModel` differs from
 * EMBED_MODEL; a missing key with stored data counts as LEGACY_MODEL). Vectors of two models are never compared:
 * - every group's exemplars are rebuilt by embedding its `lessons` texts (lessons kept; exemplars without a lesson
 *   dropped); its centroid is the rebuilt exemplars' mean, else its seeds' (seed groups), else null;
 * - every item loses its vector key and every classifiable item is queued, so the queue re-embeds it under a key
 *   that names the new model (tab-index embeddingKey) and re-picks automatic placements;
 * - the vector cache is emptied.
 * The key is written only after all of that committed; if embedding fails nothing is changed or stored, and the
 * next call (the next pipeline pass or start) tries again. Concurrent calls share one run. Resolves true when it
 * migrated.
 */
export function migrateModel(db: Db, embedFn: EmbedFn = embed): Promise<boolean> {
  running ??= run(db, embedFn).finally(() => {
    running = undefined;
  });
  return running;
}

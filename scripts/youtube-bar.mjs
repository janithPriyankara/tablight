// The selection half of tune-youtube-bar.mjs, apart from data loading and embedding so it can be tested on its own.
//
// pickGroup's path for a YouTube video with no user exemplars and no neighbour pool (what the YouTube quality gate
// runs): a rule whose group is installed > the head's top label at head.threshold > the same label at the lower
// YouTube bar, min(bar, head.threshold) > Videos (when installed) > Unsorted. A label must be installed and never
// `other`. chooseYoutubeBar scores each bar on labelled rows the way the gate does: a row is a hit when it ends in
// its labelled group (a topic, or `videos`).

/**
 * Where one video ends at YouTube bar `bar`.
 * row = { group, rule, label, score }: labelled group, ruleGroup(url, title) or null, the head's top label and score.
 */
export function outcome(row, bar, { threshold, installed }) {
  if (row.rule !== null && installed.has(row.rule)) return row.rule;
  const ok = row.label !== undefined && row.label !== null && row.label !== 'other' && installed.has(row.label);
  if (ok && row.score >= Math.min(bar, threshold)) return row.label;
  return installed.has('videos') ? 'videos' : null;
}

/** Hits (row in its labelled group) and wrong (a row placed in another group than its label, Videos excluded). */
export function scoreBar(rows, bar, opts) {
  let hits = 0;
  let wrong = 0;
  let parked = 0;
  for (const r of rows) {
    const g = outcome(r, bar, opts);
    if (g === r.group) hits++;
    else if (g === 'videos') parked++;
    else if (g !== null) wrong++;
  }
  return { bar, hits, wrong, parked, n: rows.length };
}

/**
 * The bar from `grid` (default 0.00..head.threshold in 0.01 steps: above head.threshold every bar acts as
 * head.threshold) with the most hits; ties go to fewer wrong, then to the highest bar (as YOUTUBE_THRESHOLD was
 * chosen: the top of the plateau). Returns the choice and every bar's score.
 */
export function chooseYoutubeBar(rows, { threshold, installed, grid }) {
  const bars = grid ?? Array.from({ length: Math.round(threshold * 100) + 1 }, (_, i) => i / 100);
  const table = bars.map((bar) => scoreBar(rows, bar, { threshold, installed }));
  let best = null;
  for (const s of table) {
    if (!best || s.hits > best.hits || (s.hits === best.hits && (s.wrong < best.wrong || (s.wrong === best.wrong && s.bar > best.bar)))) {
      best = s;
    }
  }
  return { best, table };
}

# Grouping by meaning: neighbours, drama rules, careful growth, a better model

## Why

The owner's export (188 tabs, 2026-11-19) showed about a third of tabs where a person would not put them: 19 of 23 in
YouTube / Videos have a clear subject (RAG, backend interviews, Kalman filters, K-drama shorts), 28 of 36 Unsorted
have an obvious home (ESP32 and TI pages next to 35 hardware tabs, Jenkins next to the Jenkins console, kisskh dramas
next to other kisskh dramas), a junk Food & cooking group grew from a drama short and a tea machine, and single words
beat meaning ("Level Up Claude Code" → Games). The owner expects tabs to be grouped "by semantic meaning".

Causes found by running the model on the export (diagnosis only; the export is never training or tuning data):

1. With 32 labels the head is rarely sure: top scores of 0.1–0.3 against the 0.36 bar, so tabs fall to Unsorted or Videos.
2. The `videos` label learned a style (talks, clickbait, drama shorts score 0.35–0.76 for it), not "no subject".
3. Drama titles need world knowledge the model lacks.
4. Two weak wants (GROW_MIN 2, YouTube bar 0.26) are enough to create a group.
5. Each tab is judged alone; the owner's own groups are ignored, though the nearest grouped tab was the right
   answer in about ten cases (cosine 0.67–0.84).

## Goals

- An unsure tab joins the group its closest grouped tabs are in (fix 1).
- Drama streaming sites and drama hashtags go to TV Series / Movies (fix 2).
- Only confident guesses grow a group, and it takes 3 of them (fix 3).
- `videos` means "a video with no subject", and the embedding model is the best one that fits the extension (fix 4;
  the owner: "use better models if needed").
- Every existing quality gate still passes; new gates cover the new behaviour.

## Non-goals

- Reading page content (privacy promise: titles and URLs only).
- Training or tuning on the owner's tabs. The export is used only to check the result by eye at the end.
- A server-side or remote model. Everything stays in the extension.

## Anti-goals

- A tab moving on its own after the user put it somewhere: user placements (`groupSource: 'user'`) never change.
- Neighbours snowballing: one wrong auto placement pulling in more wrong ones.
- A model swap that loses what the user taught (exemplars) or makes sync noticeably slow.

## Constraints

- Synthetic, blind data only; never open the rows of holdout.json, holdout2.json, holdout3.json, youtube-messy.json
  or any new holdout created here.
- Gates kept: holdout ≥ 85%, holdout2 ≥ 82%, `other` auto-assigned ≤ 35%, holdout3 ≥ 82% with each on-demand label
  ≥ 70%, YouTube no-topic in Videos ≥ 70%, youtube-topics and youtube-messy topic rates no lower than today.
- Model files are pinned by SHA-256 (scripts/model-manifest.mjs); src/classify/model.ts must agree (unit test).

## Approaches

- **Picked: all four fixes, cheapest first** (owner chose "All four fixes"). 1–3 are code changes measured on
  synthetic data; 4 is new data, a retrain and a model comparison, landing last so its numbers include 1–3.
- Only retraining or swapping the model: still judges each tab alone and still grows junk groups; set aside.
- Only neighbours: fixes the export's worst cases but leaves Videos and growth broken; set aside.

## Design

### 1. Neighbour step

In `pickGroup`, after the rule and `classify` (exemplars, then head at `threshold`) find nothing, and before the
YouTube low bar: look at the tab's nearest grouped tabs. If at least `NEIGHBOUR_MIN` (2, to tune) of its `k` nearest
grouped tabs with cosine ≥ `NEIGHBOUR_SIMILARITY` (about 0.68, to tune) are in the same group, and no other group has
as many, the tab goes there (`want` null).

- Neighbour pool: open, sleeping and saved items in an existing, non-suggested group other than Videos and Other,
  excluding the tab itself. User-placed items always count. Auto-placed items count only if they were placed by a
  rule, an exemplar or the head at `threshold` (not by a neighbour), so neighbour placements never become evidence
  for more neighbour placements (anti-goal: snowballing). This needs a new local field on the item recording how an
  auto placement was made (builder names it; local only, like `want`).
- Pool size is capped (most recently active first; cap chosen by the builder with a perf test) so a 5,000-tab
  profile stays fast.
- `pickGroup` takes the pool as an optional argument; `autoPick` (tab-index) supplies it from cached vectors, so new
  tabs, sync and regroup all use it.
- Tuning: `NEIGHBOUR_SIMILARITY`, `NEIGHBOUR_MIN` and `k` are chosen on a new synthetic tuning set of imagined
  people's browsing sessions (below), maximising right − 2 × wrong, then checked once on a separate blind sessions
  holdout.

### 2. Drama rules (src/classify/rules.ts)

- Drama streaming hosts (kisskh and its mirrors, dramacool-style sites, viki.com, wetv.vip, iq.com, mydramalist.com;
  final list by the builder from public knowledge, not from the export): "Full Movie" / "Movie" in the title →
  `movies`, else `tv`.
- A YouTube video whose title carries #kdrama, #cdrama, #jdrama, #thaidrama, #kdramaedit, #cdramaedit (or similar
  drama tags) → `tv`.
- As today, a rule only applies when its group exists.

### 3. Careful growth

- `pickGroup` sets `want` only when the head's top score is ≥ `head.threshold` (also for videos; today a video's want
  uses the 0.26 YouTube bar).
- `GROW_MIN` 2 → 3.

### 4. Videos retrain and model choice

- New blind synthetic training data: YouTube titles in the messy style (talks, interviews, explainers, podcasts,
  drama and anime shorts, clickbait, notification counters), labelled by subject per training/LABELING.md, with
  `videos` only for truly subject-less videos. Written by blind agents that never see src/, tests/ or the export.
  Rows sharing a URL or title with any holdout are dropped.
- New blind sessions data (for fix 1): imagined people, each with 30–60 tabs clustered around their own interests
  (a maker with many ESP32 pages, a drama watcher, a backend developer…). One file for tuning, one blind holdout
  (tests/quality/sessions.json), written by different agents.
- Retrain the head with the new pool. Re-measure `YOUTUBE_THRESHOLD` on youtube-topics.json as today.
- Model comparison, same pool and same training script (MODEL_ID / MODEL_PATH): bge-small-en-v1.5 (today),
  bge-base-en-v1.5, gte-small, and a multilingual small model (the owner's tabs include Sinhala and Chinese titles).
  Choose by 5-fold CV on the pool, then confirm on the holdouts, youtube-messy and the sessions holdout. Swap only if
  the winner gains at least 3 points on the honest sets (holdout2, youtube-messy, sessions) and embedding 200 tabs
  stays within 2× today's time on the perf test; otherwise keep bge-small and record the numbers.
- If the model changes: cached vectors re-embed through the existing cache key (it includes the model id); user
  exemplars are rebuilt from `lessons` (their texts) and an exemplar with no lesson is dropped; group centroids are
  rebuilt from seeds (trained groups) or member tabs (user groups).

## Left to the builder

Names of the new constants and item field, the pool cap, the exact drama host list and hashtags, the multilingual
candidate, how the sessions data is split, and how to present the before/after on the owner's export (counts only).

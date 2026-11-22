# Higher, advertisable classification accuracy

## Intent

The owner wants to advertise Tablight with an accuracy figure, and the figure must always hold up when someone
checks it. So two things: raise accuracy (target 90%+), and produce a number that is honest, reproducible and
measured on data nobody tuned on.

## Where it stands (bge-small, head retrained 2026-11-19)

| Set | Now |
|---|---|
| 5-fold CV on the training pool | 88.6% top-1; at the head threshold 4.5% wrong (≈95% of grouped tabs right) |
| holdout / holdout3 | 90.1% / 91.7% |
| holdout2 | 86.7% |
| YouTube topics | 93.3% |
| sessions (whole browsers, 0% by hand) | 67.7% right |
| messy YouTube (gated) | 52.2% |

Every one of these sets has been read in aggregate while choosing models and constants, so none can back a public
claim.

## Goals

1. A sealed benchmark, written and frozen before any training in this project, scored exactly once at the end.
2. Raise accuracy on the honest sets, first by fine-tuning the embedding model itself (same architecture, size and
   speed as bge-small), then by public data if it helps.
3. Publish the claim as two numbers with the method: **precision** (of the tabs Tablight groups, how many are in the
   right group) and **coverage** (how many tabs it groups), plus overall accuracy for transparency.

## Non-goals and anti-goals

- No page content, ever (privacy promise). Title + URL only.
- No user tabs as training or test data. The owner's export stays diagnosis-only.
- Not a bigger or slower model: download stays ~34 MB, embedding time ≤ 1.2× today.
- Anti-goal: a number that only holds on cherry-picked or tuned-on data. If the sealed benchmark comes out below
  90%, the report says so and the advertised number is the real one.

## Approaches considered

1. **Fine-tune bge-small on our labelled pool (chosen first).** Contrastive + classification fine-tuning with
   sentence-transformers on the Mac's GPU (MPS), export to ONNX int8, keep the product pipeline (mean pooling, JS
   head from train-head.mjs). Usually several points; no size or speed cost.
2. **Bigger model (bge-base).** +3 points on holdout2/sessions but 2.25× slower and 3.2× larger; rejected by the
   2026-11-19 comparison rule.
3. **Public data.** Research (2026-11-20) found no dataset that maps cleanly onto our 31 labels. Usable with clean
   licences: British Library web_archive_classification (title+URL, CC Public Domain Mark) and Curlie (CC BY 3.0,
   attribution). daspartho/subreddit-posts (Apache-2.0 card over scraped Reddit) only as a supplement for niche
   labels, never in evaluation. AG News, Yahoo Answers, Amazon, Kaggle scrapes excluded (NC / unknown licences).
   Mapped rows enter training only if they raise the honest sets; attribution goes in README/notices.

## Design

### Sealed benchmark (`tests/benchmark/`)

- ~1,200 synthetic tabs from 20 new personas (none reused), written by fresh writers from a brief in the style of
  training/SESSIONS.md: realistic sessions, 20–30% YouTube, ~10% other, messy titles, several languages.
- Each row labelled independently by two labellers from LABELING.md; disagreements settled by a third. The
  two-labeller agreement rate is reported as the human ceiling.
- Frozen at creation: file SHA-256 recorded in this design's follow-up note and in the commit message. No one
  (implementers, reviewers, controller) reads its rows or scores against it until the final step. One scoring run.
- Published with the release so anyone can rerun the number.

### Fine-tuning (`scripts/finetune/`, Python, not shipped)

- Start: BAAI/bge-small-en-v1.5 (the same weights Xenova converted). Data: training/*.json pool.
- Split: 80% for fine-tuning, 20% calibration held out from the encoder, so the head's threshold and similarity bar
  are not computed on rows the encoder has memorised. train-head.mjs gains a `CALIBRATION` option (rows to calibrate
  on) used with the fine-tuned model.
- Loss and hyperparameters are the builder's call (SetFit-style contrastive pairs and/or
  MultipleNegativesRanking on (title, label-description) pairs, plus a softmax head); pick by the calibration split
  and holdout2/sessions-tune only.
- Export with optimum to ONNX, dynamic int8 quantisation, Xenova-compatible file layout; verify cosine agreement
  between PyTorch and ONNX int8 embeddings ≥ 0.99 on 500 titles.

### Shipping a new model

- New model id `tablight/bge-small-tabs-v1` under public/models with its own pinned SHA-256s in model-manifest.mjs
  and model.ts; head.json retrained on it; NOTICE lists the base model's MIT licence.
- Stored vectors from the old model don't match: the model change re-embeds tabs on update (the existing cache key
  includes the model id) and rebuilds exemplars from `lessons` texts (the migration designed in the 2026-11-19 spec,
  Task 8).

### Accept rule

Ship the fine-tuned model only if, against today's bge-small, it is ≥ +2 points on holdout2 and on sessions (both
scenarios), not worse than −1 on holdout, holdout3, YouTube topics and messy YouTube, all quality gates pass, and
embedding time ≤ 1.2×. Then score the sealed benchmark once and write the claim from it.

## Left to the builder

Fine-tuning loss, epochs, batch size, learning rate; label-mapping tables for public data; the benchmark brief's
persona list; how the claim is worded on the store page (owner reviews before publishing).

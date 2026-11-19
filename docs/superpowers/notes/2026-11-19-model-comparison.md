Question: does a different embedding model beat the bundled `Xenova/bge-small-en-v1.5` (q8, mean pooling)?
Rule from the spec: switch only if a candidate gains at least 3 points on each of holdout2, youtube-messy and
sessions versus bge-small, and embeds 200 tabs in at most 2x bge-small's time.
- Each candidate: head trained on the same pool (`training/*.json`), 5-fold CV top-1 recorded.
- Full quality suite (`npm run test:quality`, each model with its own head and its own head.similarity) only for
  models with CV of at least 88.0%: bge-small (baseline) and bge-base (CLS). The rest are CV only.
- No per-model neighbour re-sweep. Each model's sessions gate uses its head's similarity.
- Timing: 200 pool titles through `embedText`, q8, Node, warm, median of 3, same machine, nothing else running.
- e5 was trained with the text prefix `query: `.
| Model | Revision | Size (bytes) | SHA-256 |
|---|---|---|---|
| Xenova/bge-small-en-v1.5 (bundled) | bundled | 34,014,426 | 6c9c6101a956d62d... |
| Xenova/gte-small | 5927d1727bb12db490052a1b33265ad78058de08 | 34,014,426 | 18dec105109b6004369799ca4761fb8fb413c64172c02147bcfac186b5c5f6cb |
| Xenova/bge-base-en-v1.5 | 4d6cd88e18e51a5e020c2c305726d76ada9c03cf | 110,083,337 | c9729cc84cbd0e9fecc759505d2be65916c9fe05222d7ea26c65fcb3382af38d |
| Xenova/multilingual-e5-small | 761b726dd34fb83930e26aab4e9ac3899aa1fa78 | 118,308,185 | f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193 |
| Xenova/paraphrase-multilingual-MiniLM-L12-v2 | 2c4055b12046f11709e9df2c122e59ffbdc2f900 | 118,308,126 | 66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc |
Sessions = share of tabs placed right, auto only (0% by hand) / 30% by hand, of 2010 / 1412 tab-placements.
YouTube messy = topic videos in their topic group, gated line / all-groups line.
| Model | CV | holdout | holdout2 | holdout3 | youtube-topics | youtube-messy | sessions (0% / 30%) | size MB | ms per 200 |
|---|---|---|---|---|---|---|---|---|---|
| bge-small (mean, baseline) | 88.6% (88.2% val) | 90.1% | 86.7% | 91.7% | 93.3% | 52.2% / 93.7% | 67.7% / 68.3% | 34.0 | 367 |
| bge-base (CLS) | 88.9% (89.7% val) | 91.3% | 89.8% | 90.8% | 94.4% | 52.2% / 92.5% | 71.4% / 72.0% | 110.1 | 827 |
| bge-base (mean) | 87.2% | not run, CV too low | not run | not run | not run | not run | not run | 110.1 | not run |
| gte-small (mean) | 85.8% | not run, CV too low | not run | not run | not run | not run | not run | 34.0 | not run |
| multilingual-e5-small (`query: `) | 85.8% | not run, CV too low | not run | not run | not run | not run | not run | 118.3 | not run |
| paraphrase-multilingual-MiniLM-L12 | 80.7% | not run, CV too low | not run | not run | not run | not run | not run | 118.3 | not run |
(The CV column for bge-small and bge-base-cls is the head's recorded validation accuracy next to the CV figure from
training; the other rows are the head's validation accuracy.)
Deltas of bge-base (CLS) over bge-small:
- holdout2: +3.1 points (pass)
- youtube-messy: 0.0 on the gated line, -1.2 on the all-groups line (fail)
- sessions: +3.7 (auto only) and +3.6 (30% by hand) points of tabs right (pass); the sessions score
  (right - 2x(wrong+other)) rises 610 to 735 and 467 to 556, but `other` auto-assigned rises 26.7% to 40.0%
- time for 200 tabs: 827 ms vs 367 ms = 2.25x (fail, limit 2x)
- size: 110.1 MB vs 34.0 MB (3.2x)
All 13 quality tests passed for both models.
Do not switch. No candidate qualifies. bge-base (CLS) gains on holdout2 and sessions but not on youtube-messy,
runs 2.25x slower than bge-small (over the 2x limit), and is 3.2x larger. Every other candidate has CV below
bge-small. Task 8 is skipped; bge-small stays.
- Neighbour constants were not re-swept per model (controller ruling); each model uses its own head similarity.
- The timing was first taken while e5 training was running (bge-small 373 ms, bge-base 851 ms, 2.28x) and repeated
  on an idle machine (the figures above).
- Holdout and sessions fixtures were only scored in aggregate.

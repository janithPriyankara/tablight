All of this data is **synthetic**. It was written by LLM agents (Claude) and contains **no real user data**. Items are realistic `{ title, url, group }` tabs using the starter group ids in `src/classify/seeds.ts`; `other` marks genuinely miscellaneous pages.
- `training/train-a.json` has 500 items, weighted towards developer, AI and movie/TV tabs. A separate agent wrote it blind, without seeing `src/` or `tests/`.
- `training/train-b.json` has 500 items modelling general users, about 20% `other`. Another separate agent wrote it blind.
- `tests/quality/fixture.json` has 320 items, 28 of them `other`. The classifier implementer wrote it during Task 5. It was once the dev set and is now only training data.
`npm run train:head` embeds the pool with `embedText` and the bundled model. It then trains a multinomial logistic-regression head with class-balanced weights and L2 regularisation, using full-batch Adam and a seeded split. It uses a stratified 15% validation split of the pool to choose:
- the L2 strength,
- the Unsorted probability threshold, keeping ≤ 30% of `other` items auto-assigned,
- the learned-exemplar override similarity, at ≥ 95% precision.
The final head is retrained on the whole pool and written to `src/classify/head.json`, together with `poolHash` and its validation metrics.
- `tests/quality/holdout.json` has 200 items, about 14% `other`. A separate agent wrote it without seeing `src/` or `tests/`.
- It is **never** used for training or tuning. `accuracy.test.ts` prints only aggregate numbers for it.
- Do not open it to tune against it, or it stops being a holdout.
`accuracy.test.ts` runs the real model (`public/models`, no network) through the caller pipeline: `ruleGroup`, then `classify`, then Unsorted. It asserts ≥ 85% top-1 accuracy on non-`other` holdout items and ≤ 35% of `other` holdout items auto-assigned. It also checks that the owner's case (LangGraph YouTube tutorial and Claude Agent SDK docs) lands in AI & Agents. For model experiments, `HEAD_PATH` and `MODEL_PATH` point it at an alternative head and model directory.

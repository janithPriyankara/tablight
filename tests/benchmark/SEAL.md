# Benchmark seal

Sealed 2026-11-20, before any fine-tuning or public data in this project. Scored once, at the end (Task 7 of
docs/superpowers/plans/2026-11-20-accuracy.md). Nobody reads its rows; tests print aggregates only.

- File: `benchmark.json`, 1,057 tabs, 20 synthetic personas (`b01`–`b20`, see BRIEF.md), written by fresh writers
  who saw only BRIEF.md and training/LABELING.md.
- SHA-256: `4a8c72e88e09b138a311b2947296c43e916bf2485b1d34b00000cba349e8ec74`
- Labelling: the writer's label plus an independent labeller who saw only title and URL. They agreed on
  914 of 1,120 (81.6%). An adjudicator settled the 206 disagreements (1 with a third label) and marked 174 as
  genuinely fitting either option; those rows carry `also: [<other label>]`.
- Re-sealed the same day, before any fine-tuning or scoring: 41 of the 1,120 rows shared a normalized title or URL
  with training/*.json or tests/quality/*.json and were removed (benchmark-seal.test.ts checks none remain).
  1,079 rows remained, 171 with `also`. First seal: e3cf536e656880599c73aa9b64f0f8c8850225b2adf44441ef2f4363c5341371.
- Re-sealed again the same day, still before any scoring: 22 rows whose title, with the site suffix and punctuation
  dropped, matched a training or quality title (20 distinct titles, most of them one or two words) were removed.
  1,057 rows remain, 171 with `also`. Second seal: c56d2226c89c98e56ca0b1cac7349cbccbdaf1c5d2de94c03ebb969e3ae4200e.
- Scoring: **strict** counts only `group` as right; **lenient** also accepts `also`. Both are reported.
- Scored at the end with the shipped model and head. The scoring command ran twice with identical code because the
  first run's output was not captured; nothing changed between the two runs (docs/accuracy.md).
- Labels per group: shopping 122, music 80, learning 77, design 67, finance 51, health 51, other 47,
  programming 45, games 45, videos 44, docs 40, food 32, work 32, science 32, home 32, tv 31, pets 31, jobs 28,
  sports 28, news 21, travel 19, family 18, social 17, ai 14, photo 12, books 11, realestate 10, hardware 9,
  fashion 7, movies 2, cars 1, anime 1.

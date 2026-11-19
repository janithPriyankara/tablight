# Benchmark seal

Sealed 2026-11-20, before any fine-tuning or public data in this project. Scored once, at the end (Task 7 of
docs/superpowers/plans/2026-11-20-accuracy.md). Nobody reads its rows; tests print aggregates only.

- File: `benchmark.json`, 1,120 tabs, 20 synthetic personas (`b01`–`b20`, see BRIEF.md), written by fresh writers
  who saw only BRIEF.md and training/LABELING.md.
- SHA-256: `e3cf536e656880599c73aa9b64f0f8c8850225b2adf44441ef2f4363c5341371`
- Labelling: the writer's label plus an independent labeller who saw only title and URL. They agreed on
  914 of 1,120 (81.6%). An adjudicator settled the 206 disagreements (1 with a third label) and marked 174 as
  genuinely fitting either option; those rows carry `also: [<other label>]`.
- Scoring: **strict** counts only `group` as right; **lenient** also accepts `also`. Both are reported.
- Labels per group: shopping 128, music 85, learning 78, design 70, other 64, finance 59, health 53, games 47,
  programming 45, videos 44, docs 40, work 36, home 33, food 32, science 32, tv 31, pets 31, jobs 30, sports 29,
  news 24, social 20, travel 19, family 18, ai 16, books 13, photo 12, realestate 11, hardware 9, fashion 7,
  movies 2, cars 1, anime 1.

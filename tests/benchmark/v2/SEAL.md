# Benchmark v2 seal
Sealed 2026-11-20, before the offline name list was built (docs/superpowers/plans/2026-11-20-names-lookup.md Task 1).
To be scored once, at the end of that plan (Task 9). Nobody reads its rows; tests print aggregates only.
- File: `benchmark.json`, 983 tabs, 20 synthetic personas (`c01`-`c20`, 43-60 tabs each, see BRIEF.md), written by four
  fresh writers who saw only BRIEF.md and training/LABELING.md. 1,100 rows were written; 15 duplicate URLs across
  writers were dropped, leaving 1,085.
- SHA-256: `7df59ff6f3324aae2dada792e4aeac870b85d9c9465c54f98703192d155531b1`
- Labelling: the writer's label plus an independent labeller (two fresh agents, shuffled rows, title and URL only).
  They agreed on 889 of 1,085 (81.9%). An adjudicator settled the 196 disagreements (writer 65, labeller 131, third
  label 0) and marked 19 as fitting either label; those rows carry `also: [<other label>]`.
- Before sealing, 102 rows whose normalized title, URL or near-title matched training/*.json or tests/quality/*.json
  were removed (same rules as v1's seal test; benchmark-seal.test.ts checks none remain). 983 rows remain, 18 with
  `also`. 295 are YouTube watch or shorts rows; 43 are `other`.
- Scoring: **strict** counts only `group` as right; **lenient** also accepts `also`. Both are reported.
- Labels per group: shopping 95, cars 55, sports 51, finance 50, hardware 49, health 47, work 46, programming 46,
  learning 43, videos 43, other 43, science 33, movies 33, tv 32, music 32, photo 31, food 30, docs 29, realestate 29,
  games 28, jobs 22, family 22, travel 21, home 15, news 15, social 13, pets 8, books 7, design 6, anime 5, ai 4.

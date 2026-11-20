# How accurate is Tablight's grouping?
Measured 2026-11-20 on a sealed benchmark (v2), scored once, with the model and settings that ship
(`tablight/bge-small-tabs-v1`, `src/classify/head.json`) and the name step. An earlier benchmark (v1) is kept below as history.
Of the tabs Tablight put in a group by itself, **74.6% were in the right group**, counting an `other` tab pulled into a
group as wrong. It grouped **89.5%** of the topical tabs; the rest stayed Unsorted for the user to file.
The project's target was 90% precision. 74.6% falls short of it.
| | Result |
|---|---|
| Precision, counting an `other` tab pulled into a group as wrong (the headline) | **74.6%** |
| Precision on topical tabs only | 75.4% (634 of 841) |
| Precision, also accepting a second label the adjudicator said fits equally well | 75.9% (638 of 841) |
| Coverage: topical tabs put in some group | 89.5% (841 of 940) |
| Overall: topical tabs in the right group, out of all of them | 67.4% (634 of 940) |
| `other` tabs (sign-in pages, settings, odds and ends) left Unsorted | 34 of 43; 9 pulled into a group |
The headline is the strictest of the precision figures. It is the one that matches what a user sees: a sign-in page
dropped into "Shopping" looks just as wrong as a recipe in "Programming".
For reference, v1 measured 72.5% on the same headline with 84.9% coverage. The two benchmarks use different tabs and
different people, and the pipeline changed in between (the name step), so this is not a like-for-like comparison. The
numbers are in the same range; neither run reaches 90%.
Grouping by neighbouring tabs made no difference again: the figures with it and without it are identical. With no
tabs placed by hand, the neighbour step made no difference to any figure on these sessions (see
`src/classify/pick.ts`). Identical figures cannot show whether it placed a tab in the same group the other steps
would have chosen anyway.
The run did not print how many placements the name step made, so that share was not measured and no figure is claimed
for it.
Strict recall per label: how many of that label's tabs ended up in its group.
| Label | Right | Label | Right | Label | Right |
|---|---|---|---|---|---|
| shopping | 72/95 | science | 15/33 | family | 21/22 |
| cars | 47/55 | movies | 31/33 | travel | 17/21 |
| sports | 24/51 | tv | 26/32 | home | 10/15 |
| finance | 27/50 | music | 28/32 | news | 6/15 |
| hardware | 36/49 | photo | 24/31 | social | 4/13 |
| health | 32/47 | food | 27/30 | pets | 7/8 |
| work | 28/46 | docs | 8/29 | books | 7/7 |
| programming | 28/46 | realestate | 23/29 | design | 4/6 |
| learning | 17/43 | games | 20/28 | anime | 5/5 |
| videos | 17/43 | jobs | 19/22 | ai | 4/4 |
Strongest: anime, books, ai, movies, pets, family, jobs. Weakest: social, news, docs, sports, finance, learning,
videos. The weak labels are ones whose tabs often look like another topic, and the small ones (anime 5, ai 4, books 7)
are too small to say much.
- **The benchmark:** 983 made-up browser tabs (title and address only), 43-60 each (the brief asked for 50-70) for 20
  new imagined people, `c01` to `c20`, none of them the v1 people. 295 of the tabs are YouTube videos and 43 are `other`.
  18 carry a second accepted label. The titles are deliberately messy: notification counters, Shorts hashtags, search
  result pages, sign-in pages and some non-English titles. Instructions to the writers:
  [tests/benchmark/v2/BRIEF.md](../tests/benchmark/v2/BRIEF.md).
- **Labels:** the same process as v1. Each tab was labelled by its writer and again by an independent labeller who saw
  only the title and address. They agreed on 889 of 1,085 tabs (81.9%), before 102 tabs were dropped for leakage (below).
  An adjudicator settled the rest and marked some as fitting either label; those count as right only in the lenient
  figure. With labels disagreeing on about 1 tab in 5, no grouping can score near 100% strict on this set.
- **Leakage:** 102 tabs whose title, address or near-identical title matched a training or tuning file were removed
  before sealing. A test checks that none remain.
- **Sealed before the name list was built:** the benchmark was sealed before the offline name list existed, and then
  never read. Its SHA-256 is pinned in [tests/benchmark/v2/SEAL.md](../tests/benchmark/v2/SEAL.md).
- **Scored once:** at commit 53a1c5f, after all choices were made. Nothing was changed after seeing the result.
- **How:** each person's tabs are replayed in order through the real pipeline (rules, the trained head, the lower
  YouTube bar, the name step, the neighbour step), with every group available and nothing placed by hand. That is a new
  user's first run, before Tablight has learned anything from them. Moving tabs by hand teaches groups and makes later
  grouping better; that is not counted here. The pipeline now includes the name step, which uses only search and
  Wikipedia text. The "Look it up" button is user-driven and is not counted in any figure here.
The name step looks a name up in an offline list of about 60,000 well-known names built from Wikidata (CC0). It reads only the query of a search-engine results page or the title of a Wikipedia page, never ordinary page titles. The order of steps is: your rules, groups taught by moving tabs, names, the model, neighbours. The "Look it up" button is user-driven (one tab, after the user confirms the text) and is not counted in any figure here.
A note on blindness: the choice to restrict the name step to search and Wikipedia text was made after seeing aggregate figures on the tuning sessions and on holdout2. Those two sets are therefore no longer blind for the name step. The sealed benchmark v2 was not touched when that choice was made.
## How the model was chosen

The model is BAAI/bge-small-en-v1.5, fine-tuned on Tablight's own synthetic labelled tabs and quantised to int8. On
the project's other test sets it is at or above the stock model on every set: holdout 92.4 vs 90.1, holdout3 94.0
vs 91.7, synthetic sessions 75.1 vs 67.7, and level on YouTube topics. These sets guided the choice of model, so
they are not blind; the benchmark above is the independent figure. The bar set in advance was +2 points on holdout2.
It reached +1.96 (226 of 255 tabs against 221; +2 needed 227), one tab short, and was shipped anyway because no
set got worse. Details: [docs/superpowers/notes/2026-11-20-finetune.md](superpowers/notes/2026-11-20-finetune.md).
A public web-archive dataset was tried and dropped because it made the model worse.

## What this does not cover

- **Real users' tabs.** Tablight never collects them, so the benchmark is synthetic. Real browsers repeat sites
  and pages more, which helps the neighbour step and learned examples.
- **Learning from the user.** Every group a user corrects by hand learns from it; the benchmark measures a
  first run with no corrections.
- **Page content.** Tablight only ever sees a tab's title and address, never the page, and so does this test.
- **Languages.** Mostly English titles, with a few others where a persona would use them. Grouping is weaker for
  non-English titles.

## Rerun it
```
npm run test:benchmark
```
This scores benchmark v2. The run is deterministic and prints the figures above. Rerunning on the same platform should
show the same number; int8 ONNX on another CPU or onnxruntime build can differ slightly. v2 has now been scored, so
tuning anything against it would turn it into a training set: a future model needs a new sealed benchmark.
History, kept as it was. v1 was scored before the name step existed; its sealed benchmark is
[tests/benchmark/SEAL.md](../tests/benchmark/SEAL.md).
Of the tabs Tablight put in a group by itself, **72.5% were in the right group**. It grouped **84.9%** of the
topical tabs; the rest stayed Unsorted for the user to file.
The project's target was 90% precision. 72.5% falls short of it.

| | Result |
|---|---|
| Precision, counting an `other` tab pulled into a group as wrong (the headline) | **72.5%** |
| Precision on topical tabs only | 73.5% (630 of 857) |
| Precision, also accepting a second label the adjudicator said fits equally well | 77.1% (661 of 857) |
| Coverage: topical tabs put in some group | 84.9% (857 of 1,010) |
| Overall: topical tabs in the right group, out of all of them | 62.4% (630 of 1,010) |
| `other` tabs (sign-in pages, settings, odds and ends) left Unsorted | 35 of 47; 12 pulled into a group |

The headline is the strictest of the precision figures. It is the one that matches what a user sees: a sign-in page
dropped into "Shopping" looks just as wrong as a recipe in "Programming".

Grouping by neighbouring tabs made no difference here: the figures with it and without it are identical. With no
tabs placed by hand, the neighbour step made no difference to any figure on these sessions (see
`src/classify/pick.ts`). Identical figures cannot show whether it placed a tab in the same group the other steps
would have chosen anyway.
### What was measured (v1)

- **The benchmark:** 1,057 made-up browser tabs (title and address only), 47–61 each (the brief asked for 50–70) for 20 imagined people with
  their own interests: a line cook, a student pilot, an ICU nurse in Sri Lanka, a Linux sysadmin and so on. The brief asked for
  20–30% YouTube videos per person; 47 tabs (4%) are `other`. The titles are deliberately messy: notification counters,
  Shorts hashtags, search result pages, sign-in pages and some non-English titles. Instructions to the writers:
  [tests/benchmark/BRIEF.md](../tests/benchmark/BRIEF.md).
- **Labels:** each tab was labelled by its writer and again by an independent labeller who saw only the title and
  address. The writer and the independent labeller agreed on 914 of the original 1,120 tabs (81.6%), before the
  re-seals below removed 63 of them. An adjudicator settled the rest and marked 171 of the remaining tabs as
  fitting either label; those count as right only in the 77.1% figure. With labels disagreeing on about 1 tab in 5,
  no grouping can score near 100% strict on this set.
- **Sealed before any tuning:** written before fine-tuning began, then never read. Its SHA-256 is pinned in
  [tests/benchmark/SEAL.md](../tests/benchmark/SEAL.md), and a test checks that no title or address in it, nor a
  near-identical title, appears in any training or tuning file. It was re-sealed twice before scoring to remove
  such overlaps: 41 tabs, then 22 more.
- **Scored once:**[^1] with the shipped model and head, after all choices were made. Nothing was changed after
  seeing the result.
- **How:** each person's tabs are replayed in order through the real pipeline (rules, the trained head, the lower
  YouTube bar, the neighbour step), with every group available and nothing placed by hand. That is a new user's
  first run, before Tablight has learned anything from them. Moving tabs by hand teaches groups and makes later
  grouping better; that is not counted here.
### Per label (v1)

Strict recall per label: how many of that label's tabs ended up in its group.

| Label | Right | Label | Right | Label | Right |
|---|---|---|---|---|---|
| shopping | 93/122 | docs | 12/40 | travel | 17/19 |
| music | 55/80 | food | 25/32 | family | 11/18 |
| learning | 41/77 | work | 15/32 | social | 4/17 |
| design | 30/67 | science | 19/32 | ai | 10/14 |
| finance | 23/51 | home | 14/32 | photo | 10/12 |
| health | 37/51 | tv | 28/31 | books | 7/11 |
| programming | 29/45 | pets | 28/31 | realestate | 6/10 |
| games | 30/45 | jobs | 19/28 | hardware | 8/9 |
| videos | 24/44 | sports | 20/28 | fashion | 5/7 |
| | | news | 8/21 | movies | 1/2 |
| | | | | cars | 0/1 |
| | | | | anime | 1/1 |

Strongest: tv, pets, travel, hardware, food, photo. Weakest: social, docs, news, home, design, finance. These are labels
whose tabs often look like another topic (a design article on a news site, a finance page that reads as shopping).
> Tablight groups your tabs by topic on your own computer. In a blind test on 983 made-up tabs from 20 different
> browsing profiles, it grouped 89.5% of the topical tabs by itself, and 74.6% of the tabs it grouped landed in the
> right group. Anything it isn't sure about stays Unsorted for you. When you move a tab, its new group learns from
> it. How we measured: docs/accuracy.md.
[^1]: The scoring command ran twice with identical code: the first run's output was not captured (the test
    runner's default reporter hid it), so it was run again. Nothing changed between the two runs.

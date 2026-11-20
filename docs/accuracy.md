# How accurate is Tablight's grouping?

Measured 2026-11-20 on a sealed benchmark, scored once, with the model and settings that ship
(`tablight/bge-small-tabs-v1`, `src/classify/head.json`).

## The result

Of the tabs Tablight put in a group by itself, **72.5% were in the right group**. It grouped **84.9%** of the
topical tabs; the rest stayed Unsorted for the user to file.

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
tabs placed by hand, the neighbour step did not fire at its bar on these sessions (see `src/classify/pick.ts`).

## What was measured

- **The benchmark:** 1,057 made-up browser tabs (title and address only), 50–70 each for 20 imagined people with
  their own interests: a line cook, a student pilot, an ICU nurse in Sri Lanka, a Linux sysadmin and so on. The brief asked for
  20–30% YouTube videos per person; 47 tabs (4%) are `other`. The titles are deliberately messy: notification counters,
  Shorts hashtags, search result pages, sign-in pages and some non-English titles. Instructions to the writers:
  [tests/benchmark/BRIEF.md](../tests/benchmark/BRIEF.md).
- **Labels:** each tab was labelled by its writer and again by an independent labeller who saw only the title and
  address. They agreed on 81.6% of tabs. An adjudicator settled the rest and marked 171 tabs as fitting either
  label; those count as right only in the 77.1% figure. Two careful people disagree on about 1 tab in 5, so no
  grouping can score near 100% strict on this set.
- **Sealed before any tuning:** written before fine-tuning began, then never read. Its SHA-256 is pinned in
  [tests/benchmark/SEAL.md](../tests/benchmark/SEAL.md), and a test checks that no title or address in it, nor a
  near-identical title, appears in any training or tuning file. It was re-sealed twice before scoring to remove
  such overlaps: 41 tabs, then 22 more.
- **Scored once:** with the shipped model and head, after all choices were made. Nothing was changed after seeing
  the result.
- **How:** each person's tabs are replayed in order through the real pipeline (rules, the trained head, the lower
  YouTube bar, the neighbour step), with every group available and nothing placed by hand. That is a new user's
  first run, before Tablight has learned anything from them. Moving tabs by hand teaches groups and makes later
  grouping better; that is not counted here.

## Per label

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
| | | news | 8/21 | movies 1/2, cars 0/1, anime 1/1 | |

Strongest: tv, pets, travel, hardware, food, photo. Weakest: social, docs, news, design, finance. These are labels
whose tabs often look like another topic (a design article on a news site, a finance page that reads as shopping).

## How the model was chosen

The model is BAAI/bge-small-en-v1.5, fine-tuned on Tablight's own synthetic labelled tabs and quantised to int8. On
the project's other test sets it beats the stock model everywhere: holdout 92.4 vs 90.1, holdout3 94.0 vs 91.7,
synthetic sessions 75.1 vs 67.7, and level on YouTube topics. The bar set in advance was +2 points on holdout2.
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

The run is deterministic and prints the figures above. Rerunning shows the same number. Tuning anything against
the benchmark would turn it into a training set, so a future model needs a new sealed benchmark.

## Draft store wording (not published)

> Tablight groups your tabs by topic on your own computer. In a blind test on 1,057 made-up tabs from 20 different
> browsing profiles, about 3 in 4 tabs it grouped by itself landed in the right group. Anything it isn't sure
> about stays Unsorted for you. Every tab you move teaches it, so it gets better at your own tabs over time.
> How we measured: docs/accuracy.md.

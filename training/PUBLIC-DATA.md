# Public data (fine-tuning experiment, Task 5, 2026-11-20)

Licence-clean public datasets tried as **extra training rows for the encoder fine-tune only**
(`scripts/finetune/finetune.py --extra`). They are never part of the head's pool (`scripts/train-head.mjs` reads
train-a..f + the fixture only), never calibration rows, and never test rows. Result: see
docs/superpowers/notes/2026-11-20-finetune.md, section "Public data (Task 5)". **Not kept.** With the cleaned
mapping below, the BL rows lowered holdout2 and sessions-tune against the same recipe without them (two-seed mean),
so training/public-bl.json is not in the repo; the reddit rows were dropped earlier (worse than BL alone). The
scripts regenerate both files.

Scripts: `scripts/public-data/fetch.mjs` (download into a new directory outside the repo; downloaded data is
untrusted and only parsed as JSON / CSV text) and `scripts/public-data/map.mjs` (category mapping, cleaning, leakage
filter, cap).

```sh
node scripts/public-data/fetch.mjs --out "$RAW"          # RAW: a new, empty directory outside the repo
node scripts/public-data/map.mjs --raw "$RAW" --bl training/public-bl.json [--reddit training/public-reddit.json] [--seed 1]
npx vitest run tests/unit/benchmark-seal.test.ts         # must still pass with the new files in training/
```

## Sources and licences (checked on each dataset card, 2026-11-20)

| Source | What | Licence | Used for |
|---|---|---|---|
| [TheBritishLibrary/web_archive_classification](https://huggingface.co/datasets/TheBritishLibrary/web_archive_classification) (UK Web Archive, "UK Selective Web Archive Classification Dataset", <https://doi.org/10.5259/ukwa.ds.1/classification/1>) | 26,909 curated UK websites (1996–2013): site title, URL, two-tier subject category | Card: "Creative Commons Public Domain Mark 1.0". The loading script's licence field links CC0 1.0. Both are public-domain terms; no attribution required (credited here anyway). | main source, title + URL as given |
| [daspartho/subreddit-posts](https://huggingface.co/datasets/daspartho/subreddit-posts) | titles of the top 1000 posts of 250 subreddits (scraped with PRAW), columns `title`, `label` (subreddit) | Card: Apache-2.0 (the dataset's own licence; the post titles were written by Reddit users) | supplement for six niche labels only |

Not used: **Curlie** (DMOZ successor, CC BY 3.0) publishes no downloadable dump any more, so there was nothing to
take with titles and recorded attribution. Nothing else was used (no AG News, Yahoo Answers, Amazon or Kaggle
scrapes), per the task ruling.

Download record (fetch.mjs, 2026-11-20): the BL loading script's original TSV link returns 404, so the rows come
from the Hugging Face datasets-server (its parquet conversion of the same file). bl/rows.jsonl 26,909 rows,
sha256 `dc5621a3eda1fede0559c2e22887e972e06e02ff96537496b78adaea0a12476d`; reddit/posts.csv 243,532 rows,
sha256 `71121e3f4c0bd57a2e13fa6ae7e74bcd3f04f811848674e590186f0e4494c111`.

## Mapping

### British Library (primary | secondary category → label)

Every pair not listed is dropped (21,566 rows: government, politics, history, religion, company sites, higher
education, blogs, social welfare, …, which have no Tablight label or are institution sites rather than topics).
Mapped pairs were chosen from category names and a sample of rows; no test set was consulted.

| BL category pair | label |
|---|---|
| Arts & Humanities \| Film / Cinema | movies |
| Arts & Humanities \| TV and Radio, minus rows naming radio (a station, FM/AM, DAB; 12 rows) | tv |
| Arts & Humanities \| Music | music |
| Arts & Humanities \| Art and Design | design |
| Arts & Humanities \| News and Contemporary Events | news |
| Arts & Humanities \| Literature; Arts & Humanities \| Publishing, Printing and Bookselling; Literature \| 19th Century English Literature | books |
| Computer Science, Information Technology and Web Technology \| Video Games | games |
| Business, Economy & Industry \| Banking, Insurance, Accountancy and Financial Economics | finance |
| Medicine & Health \| Health Organisations and Services; Conditions and Diseases; Mental Health; Medicines, Treatments and Therapies; Personal Experiences of Illness; Alternative Medicine / Complementary Medicine | health |
| Science & Technology \| Life Sciences; Physical Sciences; Popular Science; Mathematics; Engineering; Life Sciences \| Darwin 200; Popular Science \| Darwin 200 | science |
| Science & Technology \| Zoology, Veterinary Science and Animal Health | pets |
| Society & Culture \| Food and Drink | food |
| Society & Culture \| Travel & Tourism | travel |

Considered and left out: Computer Science / IT (mostly IT company sites, not code), Dictionaries / Reference Works
(mixed), Lifelong Learning and the education pairs (institution sites, not courses), the Olympic Games 2012 pair
(many sponsor and council pages). Dropped after review (fix round 1), as wrong for the label rather than noisy:
Travel & Tourism | Cornwall and | British Countryside (any Cornwall or countryside site: party branches, colleges,
genealogy), Employment, Unemployment and Labour Economics → jobs (trade unions and policy pages, not listings or
career advice), Society & Culture | Sports and Recreation → sports (about 11 of 28 spot-checked rows off-topic:
council 2012 pages, a donkey park, camping). Banking, Insurance, … → finance was spot-checked (about 6 of 25
off-topic, mostly "staycation" pages) and kept.
### subreddit-posts (subreddit → label; niche labels only)

| label | subreddits |
|---|---|
| anime | anime, comicbooks |
| games | Games, gaming, pcgaming, NintendoSwitch, PS4, PS5, xboxone, Minecraft, Overwatch, leagueoflegends, DestinyTheGame |
| hardware | raspberry_pi, woodworking |
| cars | cars |
| photo | photography, itookapicture |
| food | Cooking, recipes, food, FoodPorn, MealPrepSunday, slowcooking |

A post becomes a reddit tab as the pool writes them: title `<post title> : r/<sub>`, address
`https://www.reddit.com/r/<sub>/comments/<id>/<slug>/` (the dataset has no addresses; `id` is a hash of the title).

## Cleaning, leakage and cap
- Titles: whitespace collapsed; dropped if under 4 or over 140 characters (reddit: 110), a bare address or domain,
  or a placeholder ("Home", "Index of …", error and parked-domain pages). Library-style inverted titles are turned
  back: "Friend, The" → "The Friend".
- Leakage: a public row is dropped if its title, near-duplicate title form (the seal test's form) or address
  (host + path, lowercased, without scheme, `www.`, query or trailing slash; looser than the seal test's) equals
  that of any row in the git-tracked training/*.json and tests/quality/*.json files (`git ls-files`; map.mjs's own
  outputs, training/public-*.json, excepted, so a re-run reproduces them) or tests/benchmark/benchmark.json. Only
  counts are printed. With `--bl` alone: 4 rows dropped for overlap, 897 duplicates within the BL data
  (with `--reddit` too: 13 and 1,032).
- Cap, measured against the **encoder's training side**: public rows of a label are at most 40% of that label's
  rows the encoder trains on, i.e. ≤ ⅔ × (the label's pool rows after finetune.py load_pool's `url\ntitle` dedupe,
  less the round(n × 0.2) calibration rows finetune.py holds out with `--calib-share 0.2`). BL rows first, reddit
  filling the rest. Rows over the cap are dropped by a seeded shuffle with one RNG per (source, label), so `--bl`
  alone writes the same BL rows as `--bl --reddit`.
"pool (train side)" is the label's pool rows the encoder trains on; "share" is public / (train side + public).
| label | pool (train side) | BL available | reddit available | cap | BL kept | reddit kept | share |
|---|---|---|---|---|---|---|---|
| movies | 118 | 56 | – | 78 | 56 | – | 32% |
| tv | 108 | 22 | – | 72 | 22 | – | 17% |
| design | 90 | 434 | – | 60 | 60 | – | 40% |
| news | 125 | 740 | – | 83 | 83 | – | 40% |
| music | 102 | 194 | – | 68 | 68 | – | 40% |
| travel | 111 | 144 | – | 74 | 74 | – | 40% |
| finance | 116 | 260 | – | 77 | 77 | – | 40% |
| health | 123 | 1,056 | – | 82 | 82 | – | 40% |
| games | 95 | 32 | 9,243 | 63 | 32 | 31 | 40% (BL alone 25%) |
| hardware | 171 | – | 1,607 | 114 | – | 114 | 40% |
| science | 173 | 449 | – | 115 | 115 | – | 40% |
| food | 206 | 87 | 5,108 | 137 | 87 | 50 | 40% (BL alone 30%) |
| cars | 187 | – | 822 | 124 | – | 124 | 40% |
| pets | 190 | 33 | – | 126 | 33 | – | 15% |
| books | 196 | 807 | – | 130 | 130 | – | 40% |
| photo | 174 | – | 1,796 | 116 | – | 116 | 40% |
| anime | 178 | – | 1,832 | 118 | – | 118 | 40% |
| **total** | | | | | **919** | **553** | |
The first round (before review) had 1,395 BL rows over 15 labels (with sports, jobs and the Cornwall /
countryside travel rows, capped at ⅔ of the full pool); its results are in the finetune note.

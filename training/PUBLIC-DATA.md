# Public data (fine-tuning experiment, Task 5, 2026-11-20)

Licence-clean public datasets tried as **extra training rows for the encoder fine-tune only**
(`scripts/finetune/finetune.py --extra`). They are never part of the head's pool (`scripts/train-head.mjs` reads
train-a..f + the fixture only), never calibration rows, and never test rows. Result: see
docs/superpowers/notes/2026-11-20-finetune.md, section "Public data (Task 5)". **Kept: training/public-bl.json
(BL only).** The reddit rows were tried and dropped (worse than BL alone on the choosing sets); map.mjs still
writes them with `--reddit`.

Scripts: `scripts/public-data/fetch.mjs` (download into a new directory outside the repo; downloaded data is
untrusted and only parsed as JSON / CSV text) and `scripts/public-data/map.mjs` (category mapping, cleaning, leakage
filter, cap).

```sh
node scripts/public-data/fetch.mjs --out "$RAW"          # RAW: a new, empty directory outside the repo
node scripts/public-data/map.mjs --raw "$RAW" --bl training/public-bl.json [--reddit training/public-reddit.json]
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

Every pair not listed is dropped (20,215 rows: government, politics, history, religion, company sites, higher
education, blogs, social welfare, …, which have no Tablight label or are institution sites rather than topics).
Mapped pairs were chosen from category names and a sample of rows; no test set was consulted.

| BL category pair | label |
|---|---|
| Arts & Humanities \| Film / Cinema | movies |
| Arts & Humanities \| TV and Radio | tv |
| Arts & Humanities \| Music | music |
| Arts & Humanities \| Art and Design | design |
| Arts & Humanities \| News and Contemporary Events | news |
| Arts & Humanities \| Literature; Arts & Humanities \| Publishing, Printing and Bookselling; Literature \| 19th Century English Literature | books |
| Computer Science, Information Technology and Web Technology \| Video Games | games |
| Business, Economy & Industry \| Banking, Insurance, Accountancy and Financial Economics | finance |
| Business, Economy & Industry \| Employment, Unemployment and Labour Economics | jobs |
| Medicine & Health \| Health Organisations and Services; Conditions and Diseases; Mental Health; Medicines, Treatments and Therapies; Personal Experiences of Illness; Alternative Medicine / Complementary Medicine | health |
| Science & Technology \| Life Sciences; Physical Sciences; Popular Science; Mathematics; Engineering; Life Sciences \| Darwin 200; Popular Science \| Darwin 200 | science |
| Science & Technology \| Zoology, Veterinary Science and Animal Health | pets |
| Society & Culture \| Sports and Recreation | sports |
| Society & Culture \| Food and Drink | food |
| Society & Culture \| Travel & Tourism; Travel & Tourism \| British Countryside; Travel & Tourism \| Cornwall | travel |

Considered and left out: Computer Science / IT (mostly IT company sites, not code), Dictionaries / Reference Works
(mixed), Lifelong Learning and the education pairs (institution sites, not courses), the Olympic Games 2012 pair
(many sponsor and council pages).

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
  or a placeholder ("Home", "Index of …", error and parked-domain pages).
- Leakage: a public row is dropped if its title, near-duplicate title form (the seal test's form) or address
  (host + path, lowercased, without scheme, `www.`, query or trailing slash; looser than the seal test's) equals
  that of any row in training/*.json, tests/quality/*.json or tests/benchmark/benchmark.json (13 rows dropped).
  Only counts are printed; map.mjs's own outputs (training/public-*.json) are not part of that set, so a re-run
  reproduces them. Duplicates within the public data are dropped too (1,474).
- Cap: public rows of a label are at most 40% of that label's rows once added to the pool (≤ ⅔ × its pool rows),
  BL first, reddit filling the rest, chosen by a seeded shuffle (`--seed 1`).

## Rows per label (map.mjs --seed 1)

| label | pool rows | BL available | reddit available | cap | BL kept | reddit kept | public share |
|---|---|---|---|---|---|---|---|
| movies | 150 | 56 | – | 100 | 56 | – | 27% |
| tv | 136 | 33 | – | 90 | 33 | – | 20% |
| design | 119 | 434 | – | 79 | 79 | – | 40% |
| news | 161 | 740 | – | 107 | 107 | – | 40% |
| music | 129 | 194 | – | 86 | 86 | – | 40% |
| travel | 140 | 235 | – | 93 | 93 | – | 40% |
| finance | 146 | 260 | – | 97 | 97 | – | 40% |
| health | 155 | 1,052 | – | 103 | 103 | – | 40% |
| games | 121 | 32 | 9,243 | 80 | 32 | 48 | 40% |
| hardware | 214 | – | 1,607 | 142 | – | 142 | 40% |
| science | 216 | 449 | – | 144 | 144 | – | 40% |
| sports | 245 | 675 | – | 163 | 163 | – | 40% |
| food | 258 | 87 | 5,108 | 172 | 87 | 85 | 40% |
| cars | 234 | – | 822 | 156 | – | 156 | 40% |
| pets | 237 | 33 | – | 158 | 33 | – | 12% |
| jobs | 253 | 119 | – | 168 | 119 | – | 32% |
| books | 245 | 807 | – | 163 | 163 | – | 40% |
| photo | 218 | – | 1,796 | 145 | – | 145 | 40% |
| anime | 223 | – | 1,832 | 148 | – | 148 | 40% |
| **total** | | | | | **1,395** | **724** | |

Labels with no public rows: videos, ai, programming, shopping, social, learning, docs, work, home, fashion, family,
realestate, other.

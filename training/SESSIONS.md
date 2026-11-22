# Browsing-session data: brief for writers

You are writing **synthetic, made-up** browser tabs for imagined people. No real user data. Read only this file and
`training/LABELING.md` (the label list, the YouTube rule and the borders). Do not read anything else in the
repository.

## Format

One JSON array. Each row is one open tab:

```json
{ "person": "p07-maker", "title": "…", "url": "https://…", "group": "hardware" }
```

- `person`: the persona id you were given, the same on every row of that person.
- `title`: the tab title as a browser shows it, including site suffixes ("… - YouTube", "… | Hackaday", "(3) …"),
  in the messy form real tabs have: notification counters, hashtags on Shorts, clickbait, conference-talk titles
  ("Title — Speaker (Conf 2025)"), search result pages ("esp32 deep sleep - Google Search"), repo pages
  ("owner/repo: description"), dashboards, sign-in pages.
- `url`: a realistic http(s) address for that title (real or plausible sites; invented paths and ids are fine).
- `group`: one label id from LABELING.md, the label a careful person would give that tab (what it is **about**).

## What a session looks like

- Each person has **30–60 tabs**, clustered around **3–6 interests of their own**, the way a real person's browser
  looks after a few weeks: many tabs on the same board, show, framework, product or site; several searches for the
  same thing worded differently; videos and pages on the same topic side by side.
- Around 20–30% of each person's tabs are YouTube videos (watch or shorts addresses), labelled by the YouTube rule.
- About 10% `other` (sign-in pages, settings, browser tools, truly miscellaneous pages).
- Mix easy tabs with hard ones: titles that only make sense next to the person's other tabs (a part number, a
  show's name without the word "drama", an acronym, a repo name), titles with a misleading word ("Level up your
  …", "Designing …", "Engineering …" used figuratively), and non-English titles where the persona would have them.
- Rows appear in the order the person might have opened them, interests interleaved, not sorted by label.
- No two rows with the same URL. Do not copy rows from any file in the repository.

## Personas

Tune set (`training/sessions-tune.json`):

1. `t01-maker`: builds ESP32 and STM32 gadgets, orders PCBs, reads datasheets; also follows F1 and cooks curries.
2. `t02-drama`: watches Korean and Chinese dramas on streaming and fan sites, follows drama-edit Shorts; also
   skincare and learning Korean.
3. `t03-backend`: Go and Postgres backend developer, system-design interview prep, job hunting; plays chess.
4. `t04-mlstudent`: ML master's student: papers, PyTorch, RAG tutorials, course pages; also anime and budget travel.
5. `t05-parent`: parent of a toddler: sleep schedules, daycare, recipes for kids, home decluttering, buying a car.
6. `t06-photographer`: landscape photographer: lenses, Lightroom, trip planning to Iceland, hiking gear shopping.
7. `t07-trader`: retail investor: markets, ETFs, crypto news, a mortgage refinance, football scores.
8. `t08-gardener`: retired gardener: vegetables, houseplants, birdwatching, crime novels, church music.
9. `t09-gamedev`: indie game developer: Unity, shaders, pixel art, game trailers, Steam pages, synthwave music.
10. `t10-nurse`: nurse: drug references, shift scheduling, fitness, a dog's training, apartment hunting.
11. `t11-robotics`: robotics engineer: ROS 2, control theory, Kalman filters, drones, lab work tools, sci-fi films.
12. `t12-student`: high-school student: homework help, physics explainers, memes and challenge videos, sneakers, K-pop.

Holdout set (`tests/quality/sessions.json`):

1. `h01-woodworker`: woodworking and CNC routers, 3D printing, a home renovation, country music.
2. `h02-cdrama`: Chinese and Thai dramas and their clips, makeup tutorials, online shopping, cooking short videos.
3. `h03-frontend`: React/TypeScript developer, design systems and Figma, a conference talk playlist, cycling.
4. `h04-researcher`: biology researcher: papers, lab protocols, statistics in R, science podcasts, cats.
5. `h05-newdad`: new father: baby products, parenting forums, sleep, a used-car search, football.
6. `h06-traveller`: planning a month in Japan: flights, hotels, rail passes, food guides, anime, language learning.
7. `h07-devops`: DevOps engineer: Kubernetes, Jenkins and CI, cloud billing, on-call tools, heavy-metal music.
8. `h08-llmbuilder`: builds LLM agents: agent frameworks, evals, vector databases, startup news, sci-fi books.
9. `h09-electronics`: electronics hobbyist: power supplies, GaN chargers, oscilloscopes, amateur radio, tea.
10. `h10-fashion`: fashion student: lookbooks, sewing, fabric shops, runway videos, part-time job hunting.
11. `h11-homeowner`: first-time home buyer: listings, mortgages, furniture, gardening, a puppy.
12. `h12-gamer`: PC gamer: game news, walkthroughs, hardware for a gaming PC, streams, anime openings.

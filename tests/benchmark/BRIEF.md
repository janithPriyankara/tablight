# Accuracy benchmark: brief for writers

You are writing **synthetic, made-up** browser tabs for imagined people. They form Tablight's public accuracy
benchmark, so they must look like real browsers, not like easy examples. No real user data. Read only this file and
`training/LABELING.md` (the label list, the YouTube rule and the borders). Do not read anything else in the
repository.

## Format

One JSON array. Each row is one open tab:

```json
{ "person": "b07-nurse", "title": "…", "url": "https://…", "group": "health" }
```

- `person`: the persona id you were given, the same on every row of that person.
- `title`: the tab title as a browser shows it, including site suffixes ("… - YouTube", "… | Reuters", "(3) …"),
  in the messy form real tabs have: notification counters, hashtags on Shorts, clickbait, conference-talk titles,
  search result pages ("cheap flights lisbon - Google Search"), repo pages, dashboards, sign-in pages, docs pages.
- `url`: a realistic http(s) address for that title (real or plausible sites; invented paths and ids are fine).
- `group`: one label id from LABELING.md, the label a careful person would give that tab (what it is **about**).

## What a session looks like

- Each person has **50–70 tabs**, clustered around **3–6 interests of their own**, the way a real browser looks after
  a few weeks: many tabs on the same product, show, framework or site; several searches for the same thing worded
  differently; videos and pages on the same topic side by side.
- Around 20–30% of each person's tabs are YouTube (watch or shorts addresses), labelled by the YouTube rule.
- About 10% `other` (sign-in pages, settings, browser tools, truly miscellaneous pages).
- Mix easy tabs with hard ones: titles that only make sense next to the person's other tabs, misleading words used
  figuratively, and non-English titles where the persona would have them.
- Rows in the order the person might have opened them, interests interleaved, not sorted by label.
- No two rows with the same URL. Do not copy rows from any file.

## Personas

1. `b01-chef`: restaurant line cook: recipes, knife shopping, food-safety rules, a culinary school application, hip-hop.
2. `b02-pilot`: student pilot: flight training, weather briefings, aviation YouTube, budget for lessons, a road trip.
3. `b03-dataeng`: data engineer: Spark, dbt, Airflow, cloud costs, a conference CFP, marathon training.
4. `b04-teacher`: primary-school teacher: lesson plans, classroom crafts, a union newsletter, gardening, true-crime podcasts.
5. `b05-streamer`: Twitch streamer: OBS, game patches, merch store, editing Shorts, a new microphone.
6. `b06-retiree`: retiree: pension and taxes, cruises, grandchildren photos, knitting, local news.
7. `b07-nurse`: ICU nurse in Sri Lanka: drug references, exam prep, Sinhala teledramas, cricket, phone shopping.
8. `b08-lawyer`: junior lawyer: case law, legal tech, a flat renovation, wine, Formula 1.
9. `b09-biohacker`: fitness enthusiast: supplements, gym programs, sleep trackers, keto recipes, crypto.
10. `b10-architect`: architect: Revit, materials, competitions, urban-planning talks, Scandinavian furniture.
11. `b11-indiemusic`: bedroom producer: DAW tutorials, synth shopping, Bandcamp, music theory, anime OSTs.
12. `b12-founder`: startup founder: fundraising, SaaS metrics, hiring, LLM APIs, a newborn.
13. `b13-esports`: esports fan: tournaments, patch notes, team news, gaming chairs, K-pop.
14. `b14-vet`: veterinarian: animal medicine, pet-food recalls, a horse farm, country living, audiobooks.
15. `b15-collegeapp`: senior applying to college: essays, scholarships, campus tours, physics homework, sneakers.
16. `b16-sysadmin`: Linux sysadmin: home lab, self-hosting, networking gear, security advisories, retro games.
17. `b17-designer`: product designer: Figma, UX research, portfolio, type foundries, Japanese city-pop.
18. `b18-expat`: expat moving to Germany: visas, apartment search, learning German, banking, football.
19. `b19-astronomy`: amateur astronomer: telescopes, astrophotography, NASA news, weather apps, sci-fi novels.
20. `b20-shopper`: bargain hunter: deals sites, phone comparisons, coupon codes, fashion hauls, reality TV.

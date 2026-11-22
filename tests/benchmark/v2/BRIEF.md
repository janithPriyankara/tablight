# Accuracy benchmark: brief for writers

You are writing **synthetic, made-up** browser tabs for imagined people. They form Tablight's public accuracy
benchmark, so they must look like real browsers, not like easy examples. No real user data. Read only this file (tests/benchmark/v2/BRIEF.md) and
`training/LABELING.md` (the label list, the YouTube rule and the borders). Do not read anything else in the
repository.

## Format

One JSON array. Each row is one open tab:

```json
{ "person": "c07-midwife", "title": "…", "url": "https://…", "group": "health" }
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
1. `c01-electrician`: apprentice electrician: wiring codes, tool shopping, a solar install, darts, Netflix crime series.
2. `c02-phd-bio`: biology PhD student: papers, lab protocols, R and Python, a thesis deadline, rock climbing.
3. `c03-gamedev`: indie game developer: Godot, pixel art, Steam page, game jams, lo-fi music.
4. `c04-realtor`: real-estate agent: listings, mortgage rates, staging tips, CRM, golf.
5. `c05-mom`: parent of toddlers: sleep training, school applications, birthday party ideas, recipes, a K-drama binge.
6. `c06-trucker`: long-haul truck driver: routes and weather, truck parts, audiobooks, country music, fishing.
7. `c07-midwife`: midwife in the Philippines: clinical guidelines, exam review, Filipino teleseryes, basketball, budget phones.
8. `c08-quant`: quant analyst: options pricing, Python libraries, market news, chess, watches.
9. `c09-maker`: electronics hobbyist: microcontrollers, parts and datasheets, 3D printing, a PCB order, sci-fi films.
10. `c10-student-jp`: student learning Japanese: grammar, anime, manga shopping, a study-abroad plan, J-rock.
11. `c11-nonprofit`: nonprofit fundraiser: grant writing, donor CRM, event planning, volunteering, podcasts.
12. `c12-cyclist`: amateur cyclist: bike parts, training plans, race calendar, nutrition, travel to a gran fondo.
13. `c13-photographer`: wedding photographer: cameras and lenses, Lightroom, client contracts, tax season, travel.
14. `c14-securityeng`: security engineer: CVEs, cloud IAM, CTF writeups, a conference talk, mechanical keyboards.
15. `c15-homecook`: home baker: sourdough, kitchen gear, a farmers market, gardening, a cooking competition show.
16. `c16-carfan`: car enthusiast: a used-car purchase, detailing, motorsport, car parts, synthwave.
17. `c17-pharmacist`: pharmacist: drug interactions, continuing education, a job change, yoga, true crime.
18. `c18-moviebuff`: film lover: reviews and box office, upcoming releases, a streaming service comparison, film cameras, board games.
19. `c19-farmer`: smallholder farmer: crop prices, tractors, weather, livestock health, church events.
20. `c20-retired-eng`: retired mechanical engineer: woodworking, ham radio, grandchildren, history books, investing.

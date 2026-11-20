# Offline name list (`public/names/names.txt`)

`build.mjs` writes the name list the background worker loads for the name step (design:
`docs/superpowers/specs/2026-11-20-names-lookup-design.md`, Part 1). It runs at build time only and is committed;
the extension never queries anything for it.

```
npm run names:build -- --scowl <SCOWL>/final [--cache DIR] [--offline]
```

Then update `NAMES_SHA256` in `scripts/verify-release.mjs` to the SHA-256 the script prints.

## Sources

- **Wikidata** (https://www.wikidata.org), queried through its public SPARQL endpoint
  (https://query.wikidata.org/sparql). Wikidata's data is **CC0 1.0** (public domain dedication); credited in
  `public/third-party-notices.txt`. The script sends one query at a time with the generic User-Agent
  `TablightNamesBuild/1.0 (build script)`, backs off on 429/5xx and timeouts, and caches each raw response under
  `--cache` (default `<os tmpdir>/tablight-names-raw`). The cache is never committed.
- **SCOWL** (Spell Checker Oriented Word Lists) 2020.12.07 by Kevin Atkinson, http://wordlist.aspell.net/,
  downloaded from https://downloads.sourceforge.net/project/wordlist/SCOWL/2020.12.07/scowl-2020.12.07.tar.gz.
  Only `final/english-words.10`, `.20` and `.35` are read (about 48,000 everyday lowercase English words; SCOWL keeps
  proper nouns such as "Toyota" or "Nvidia" in separate files, which are not used). They are the build-time
  common-word filter and are **not shipped** and not committed. Licence: SCOWL's permissive copyright notice
  ("Permission to use, copy, modify, distribute and sell these word lists ... for any purpose is hereby granted
  without fee", Copyright 2000-2018 Kevin Atkinson); its levels 10-35 derive from public-domain sources (Moby Words
  II, Brian Kelk's UK English wordlist, 12dicts). SHA-256 of the three files concatenated is pinned in `build.mjs`
  (`SCOWL_SHA256`).

## What goes in
Per class group (`GROUPS`, `PERSONS` and the hardware queries in `build.mjs`, with their Wikidata QIDs and sitelink
bars): items that have an English Wikipedia article and at least the bar's number of sitelinks, with their English
(or language-neutral `mul`) labels, their English Wikipedia title and their English/`mul` aliases, normalized like
`normName` in `src/classify/names.ts` (`norm.mjs` is the build-time copy, tested equal). A name with an apostrophe
is also offered without it ("baldurs gate 3"). Hardware is chip and board classes, semiconductor makers (industry
P452 = semiconductor industry) and what they make (P176), minus consoles, cameras, phones, vehicles, ships, aircraft
and software.
A name is dropped when:
- it is shorter than 4 or longer than 60 characters, has no letter, or is only digits;
- it is a single word that is a common English word (SCOWL 10-35);
- it is one word (or "the" + one word) that is not the item's own unbracketed English Wikipedia title (Wikipedia
  gives the bare word to another meaning: "Halo", "Titanic", "The Office" lose; "Metallica", "Nvidia", "The Wire"
  stay), or such a short alias;
- it is an everyday phrase (every word common) taken from an alias, from an item whose Wikipedia title is
  bracketed, or (two words) from an item below twice its group's bar;
- it is the bare title of a bracketed article whose bare title belongs to a person ("Ada Lovelace
  (microarchitecture)");
- it belongs to a person who is not the primary topic of their own unbracketed Wikipedia title, is one word, or is an
  alias; people are only musicians (music) and athletes (sports) at a higher bar, and only when their music or sport
  occupations outnumber their acting/political/business ones;
- two labels claim it and the better-known one's best item has fewer than 5x the sitelinks of the other's. Exception:
  the item that owns the bare Wikipedia title keeps it when every other label claims it only by an alias or by the
  label of a bracketed article ("The Shawshank Redemption" the film over the novella's alias; "Cowboy Bebop" the anime
  over "Cowboy Bebop (2021 TV series)").
What survives fills the byte budget (1,450,000, under the 1,500,000 cap) best-known first, ranked by sitelinks
relative to the group's bar.

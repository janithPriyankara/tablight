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
  `--cache` (default `<os tmpdir>/tablight-names-raw`). The cache is never committed. The other-owner check also
  reads, through the same cache, Wikidata's Action API (https://www.wikidata.org/w/api.php: which item owns an English
  Wikipedia title, and sitelink counts) and English Wikipedia's Action API (https://en.wikipedia.org/w/api.php: where
  a title redirects, the target's Wikidata item and its disambiguation flag). Only titles and these facts are used;
  no article text is read or shipped.
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
- it is a single word that is a common English word (SCOWL 10-35), or "the" + such a word ("the music", "the cars"),
  unless the item owns that plain Wikipedia title and has at least 4x its group's bar ("The Godfather", "The Who");
- it is one word (or "the" + one word) that is not the item's own unbracketed English Wikipedia title (Wikipedia
  gives the bare word to another meaning: "Halo", "Titanic", "The Office" lose; "Metallica", "Nvidia" stay), or such
  a short alias;
- it is an everyday phrase (every word common) taken from an alias, from an item whose Wikipedia title is
  bracketed, or (two words) from an item below twice its group's bar;
- the item does not own it as its plain Wikipedia title (a bracketed article's bare title, a label that differs from
  the title, an alias), and the words belong to something outside the list: the English Wikipedia article of that
  title (also with the words after the first in lower case, and following a redirect for a bracketed article's bare
  title) is a disambiguation page, a person, or an item with at least half as many sitelinks ("San Francisco (1936
  film)" loses "san francisco"; "Groundhog Day (film)" loses to the holiday; "American Football (band)" to the sport;
  "Van Gogh (1991 film)" to the painter; "Robert Bosch", a label of "Bosch (company)", to the person; "Peaky Blinders
  (TV series)" keeps its name against the smaller gang article), or another item with that English label has at least
  as many sitelinks. One-word titles with odd capitals are checked against their plainly cased title ("DaDa" the
  album against "Dada");
- it belongs to a person who is not the primary topic of their own unbracketed Wikipedia title, is one word, or is an
  alias. People are only musicians (music, at 40 sitelinks) and athletes (sports, at 60; queried at 40), and only when
  their field's occupations (music also counts record producer, conductor, drummer and other instrument and genre
  occupations) outnumber their other fame: acting, politics, business, film-making, journalism, visual art,
  scholarship, religion, royalty, the military and modelling, plus writing occupations counted at most twice
  (writer, novelist, poet, playwright ...). A tie is enough from four field occupations up (John Lennon, Bob Dylan);
- two labels claim it and the better-known one's best item has fewer than 5x the sitelinks of the other's. Exception:
  the item that owns the bare Wikipedia title keeps it when every other label claims it only by an alias ("The
  Shawshank Redemption" the film over the novella's alias). A rival's label, bracketed or not, goes to the 5x rule
  ("Mortal Kombat" the game against "Mortal Kombat (1995 film)").
People are written in their own sections, `#music.person` and `#sports.person` (a name that any person of its label
claims counts as a person's). The app reads them as their label: it matches every list name, person or not, only on
a search query or a Wikipedia title, never on a plain page title ("David Silva | LinkedIn" is far more likely a
colleague than the footballer).
What survives fills the byte budget (1,450,000, under the 1,500,000 cap) best-known first, ranked by sitelinks
relative to the group's bar.

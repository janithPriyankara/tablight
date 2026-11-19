# Labelling guide

Every row is a browser tab `{ "title", "url", "group" }`, synthetic and made up (no real user data). `group` is one
label from the list below. The label says what the tab is **about**, judged from its title and address only.

## Labels

| id | Group | What goes here |
|---|---|---|
| `movies` | Movies | films: listings, reviews, trailers, streaming pages for a film |
| `tv` | TV Series | series, episodes, K-dramas, anime series pages on streaming sites, show reviews |
| `videos` | YouTube / Videos | video pages with **no clear subject** (see the YouTube rule) |
| `ai` | AI & Agents | AI models, agents, LLM tools, ML research and tutorials |
| `programming` | Programming | code, repos, Q&A, dev tools, programming tutorials |
| `design` | Design | UI/UX, graphic design, fonts, design tools |
| `shopping` | Shopping | product pages, carts, deals, stores (electronics product pages too) |
| `news` | News | news articles and front pages (not sports news, see borders) |
| `social` | Social | social networks, feeds, forums for chatting |
| `music` | Music | songs, albums, playlists, music videos, artists |
| `learning` | Learning / Courses | courses, lessons, MOOCs, general STEM courses |
| `docs` | Docs & Reference | documentation, references, wikis, manuals |
| `work` | Work Tools | email, calendars, docs/sheets editors, project tools |
| `travel` | Travel | flights, hotels, trains, maps for trips, guides |
| `finance` | Finance | banking, investing, budgeting, markets |
| `health` | Health | medical info, fitness, diet and nutrition advice |
| `games` | Games | video games, game stores, walkthroughs, game streams |
| `other` | (Unsorted) | genuinely miscellaneous pages, account/sign-in pages, browser tools |

## The YouTube rule

A YouTube video (a `youtube.com/watch`, `youtube.com/shorts/` or `youtu.be/` address) is labelled by **what the
video is about**, exactly as a web page on the same subject would be:

- a video teaching or discussing a subject goes to that subject's label (a LangGraph tutorial → `ai`, a stock
  market explainer → `finance`, a K-drama clip → `tv`, a song's official video → `music`, a game playthrough →
  `games`, a film trailer → `movies`);
- `videos` is only for videos with **no clear subject**: vlogs, challenges, reactions, pranks, compilations,
  shorts compilations, "day in my life", funny clips, and YouTube channel or home pages (`youtube.com/@name`,
  `youtube.com/`);
- if the subject has no label in the table (for example woodworking or a lathe video while there is no such
  label), the video stays `videos`.

The word "YouTube" in a title never decides the label.

## Borders

- Sports news → sports (when a `sports` label exists; until then → `news`).
- Recipes, restaurants, cooking videos → food (when it exists); diet and nutrition advice → `health`.
- Science explainers and research news → science (when it exists).
- ESP32 / Arduino / PCB / CNC / 3D-printing docs, forums, repos and videos → hardware (when it exists).
- Electronics product pages → `shopping`.
- Maker courses → hardware (when it exists); general STEM courses → `learning`.

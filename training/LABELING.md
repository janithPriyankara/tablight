# Labelling guide

Every row is a browser tab `{ "title", "url", "group" }`, synthetic and made up (no real user data). `group` is one
label from the list below. The label says what the tab is **about**, judged from its title and address only.

## Labels

| id | Group | What goes here |
|---|---|---|
| `movies` | Movies | films: listings, reviews, trailers, streaming pages for a film |
| `tv` | TV Series | series, episodes, K-dramas, show reviews |
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
| `hardware` | Hardware & making | machining, lathes, CNC, 3D printing, woodworking, electronics, PCBs, soldering, microcontrollers (ESP32, Arduino, Raspberry Pi projects), robotics builds, maker forums and repos |
| `science` | Science & engineering | science explainers, research news, physics, chemistry, biology, space, engineering explainers, papers outside AI |
| `sports` | Sports | sports news, scores, fixtures, leagues, teams, athletes, match highlights, fantasy sports |
| `food` | Food & cooking | recipes, cooking videos, restaurants, food delivery menus, baking, food blogs |
| `cars` | Cars & vehicles | car reviews, car listings, repair and maintenance, motorbikes, EVs, car forums |
| `home` | Home & garden | DIY home repair, interior decor, furniture ideas, gardening, plants, cleaning tips |
| `fashion` | Fashion & beauty | clothing style, outfits, skincare, makeup, hair, fashion news and lookbooks |
| `pets` | Pets & animals | pet care, dog/cat training, pet adoption, vets advice for pets, wildlife and animal facts |
| `family` | Parenting & family | parenting advice, babies, pregnancy guides, kids' activities, schools from a parent's view, family planning |
| `jobs` | Jobs & careers | job listings, applications, resumes/CVs, interview prep, salaries, career advice, LinkedIn jobs |
| `books` | Books & reading | book reviews, reading lists, Goodreads-like pages, ebooks, author pages, literature |
| `photo` | Photography | photography techniques, cameras and lenses reviews, photo editing (Lightroom), photo sharing portfolios |
| `anime` | Anime & comics | anime news and reviews, manga, comics, webtoons, anime streaming pages |
| `realestate` | Real estate | property listings, renting and buying homes, mortgages for a home purchase, real-estate market news |
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
- if the subject has no label in the table, the video stays `videos`.

The word "YouTube" in a title never decides the label.

## Borders

- Sports news → sports.
- Recipes, restaurants, cooking videos → food; diet and nutrition advice → `health`.
- Science explainers and research news → science.
- ESP32 / Arduino / PCB / CNC / 3D-printing docs, forums, repos and videos → hardware.
- Electronics product pages → `shopping`.
- Maker courses → hardware; general STEM courses → `learning`.
- Anime series and manga → `anime`; live-action series and K-dramas → `tv`; animated feature films → `movies`.
- Mortgage rates as investing/markets → `finance`; mortgages for buying a home, listings → `realestate`.
- Car purchase product pages on dealer sites → `cars`; car parts on a general store → `shopping`.
- Camera product pages on a store → `shopping`; camera reviews and photo technique → `photo`.
- Job listings for developers → `jobs` (not `programming`); career courses → `learning`.
- Pet food product pages on a store → `shopping`; pet care advice → `pets`.

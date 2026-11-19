# Interests at start, and YouTube videos grouped by topic

## Why

People watch very different things on YouTube, and today a video is grouped by "title — YouTube", so the word
"YouTube" pulls most videos into one "YouTube / Videos" pile whatever they are about (in the owner's export: lathe,
CNC and PCB videos sat in Videos or Unsorted). And the built-in groups are one size for everyone: the owner's
biggest interest (hardware and making) has no group at all. Two changes:

1. **YouTube topic first**: a video goes to the group its title is about; "YouTube / Videos" keeps only videos with
   no clear topic (vlogs, challenges, shorts, funny clips).
2. **Interests at start**: Tablight asks what you browse most and creates only those groups, including new ones
   (e.g. Hardware & making) that are trained like the built-in ones.

Success: on a fresh install, the owner picks their interests and, without moving a single tab by hand, lathe / CNC /
PCB / ESP32 videos and pages land in Hardware & making, AI talks on YouTube land in AI & Agents, and K-drama clips
land in TV Series.

## Goals

- YouTube watch and Shorts pages are classified by their title's topic; Videos only when no topic is clear.
- A first-run interests step: about 20 choices (the built-in groups plus new trained ones) and "Add your own".
- Only picked groups are created on a fresh install; tabs the model would put into an unpicked group go to Unsorted.
- New trained groups (first set below) are real classifier labels, trained on synthetic data like the others.
- Existing users can open the same step from Settings → General ("Choose your interests") and see it once after the
  update; picking adds groups, it never deletes groups or moves tabs a user placed.

## Non-goals

- Reading page content, descriptions, channel names or anything beyond title and address (the privacy promise).
- Sub-groups or nested groups ("YouTube · Software").
- Network calls, accounts or any server-side personalization.

## Anti-goals (a failure even if it works)

- Accuracy on the existing blind holdouts drops below today's gates (≥ 85% top-1 holdout, ≥ 82% holdout2, ≤ 35% of
  `other` auto-assigned).
- Real user tabs used as training data (training data stays synthetic, written blind; see tests/quality/README.md).
- A new user faces a long or blocking questionnaire: the step is one screen, skippable, and "Skip" keeps today's
  behaviour (all built-in groups).

## Constraints

- Classifier: bundled embedding model + trained multinomial head + kNN pool (`src/classify/head.json`,
  `npm run train:head`); exemplars override only above `head.similarity`. A label must exist in the head to be
  assigned without user teaching.
- Model input is `embedText()` = `cleanTitle — readableSource pathWords` (`src/shared/url.ts:201`).
- Starter groups live in `src/classify/seeds.ts`; a head label whose group doesn't exist resolves to Unsorted
  (`classify()` checks `groups.some(g => g.id === label)`).
- Existing installs keep their groups and ids; sync and backups match groups by name.

## Approaches considered

YouTube: **A. topic first** (picked) · B. "YouTube · <topic>" sub-groups (two places per topic, doubles the sidebar)
· C. topic filter chips inside one Videos pile (still one pile).
Interests: **A. pick from a list + add your own** (picked) · B. free-text description only (messy names, hard to get
right) · C. don't ask, learn from suggestions (slow; left the owner's hardware tabs scattered).

## Design

### 1. YouTube topic first

- `embedText` leaves out the source word for YouTube watch and Shorts URLs (kind `watch` on youtube.com), so the model
  reads only the cleaned title (+ path words where meaningful). Other sites unchanged.
- Training data: re-label `videos` rows whose title has a clear topic to that topic, following a written rule:
  *Videos = no clear subject (vlogs, challenges, reactions, pranks, shorts compilations, channel/home pages); a
  video teaching or discussing a subject goes to that subject's group.* Done by a blind agent from the rule, not by
  looking at the holdouts.
- New quality check `youtube-topics.json` (synthetic, blind-written, ~150 YouTube titles with labels) reported by
  `accuracy.test.ts`: share of topic videos landing in their topic group, and share of no-topic videos staying in
  Videos.

### 2. New trained groups (first set)

`hardware` "Hardware & making" (machining, CNC, 3D printing, woodworking, electronics, PCBs, microcontrollers,
robotics builds), `science` "Science & engineering", `sports` "Sports", `food` "Food & cooking". Each gets
starter seeds in `seeds.ts` and ~150–200 synthetic training rows (blind agent, labelling guide updated), then the
head is retrained and must pass the gates above.

### 3. Interests step

- Fresh install: the welcome card gets a first screen "What do you browse most?" with the choices as toggle chips
  (all built-in groups + the new ones), pre-selected: none; buttons **Continue** (creates the picked groups) and
  **Skip** (today's behaviour: all built-in groups, new ones not created).
- "Add your own": a name field (validated like group names) creates a user group; it says plainly that it learns
  from tabs you move into it.
- Existing users: after the update, a one-time card "New: choose your interests" on All tabs; the same screen from
  Settings → General → "Choose your interests". It only adds groups; existing groups, their tabs and user choices
  are untouched. Already existing groups show as selected and can't be unselected there.
- After Continue, unsorted and auto-grouped tabs are re-classified so new groups fill at once (user-placed tabs stay).

## Decisions from the builder check (implementer's calls unless marked)

- **Quality gates.** The existing holdouts stay the regression gate, scored with the default group set (all
  built-in groups, no new ones), which is what Skip gives. The new behaviour is gated by a new blind holdout written
  under the new labelling guide (new groups present, YouTube topic first) plus `youtube-topics.json`.
- **Fresh install lifecycle.** All built-in groups are created at install as today, so tabs sort at once. On
  Continue, unpicked built-in groups are removed only if the user hasn't touched them (no user-placed tab, not
  renamed, not mirrored); their auto-placed tabs go back through the classifier. Skip, or never answering, keeps
  today's set. The picks are stored; "Delete all data" re-seeds the full built-in set and shows the step again.
- **Existing users.** The update itself moves nothing. Topic-first YouTube applies to new tabs from the update on;
  existing auto-placed YouTube tabs are re-classified when the user presses Continue on "Choose your interests"
  (user-placed tabs never move). The embedding cache key includes the new model input, so cached YouTube vectors
  with "— YouTube" are not reused.
- **Names and ids.** A group whose name matches a trained group (case-insensitive) is created or adopted with the
  trained id and `builtIn: true` in sync, import and "Add your own"; an existing user group of that name is adopted,
  never duplicated.
- **Labelling borders** (guide for the blind data agent, applied to the whole training pool, not only `videos`
  rows): sports news → sports; recipes, restaurants, cooking videos → food (diet and nutrition advice → health);
  science explainers and research news → science; ESP32 / Arduino / PCB / CNC / 3D-printing docs, forums, repos and
  videos → hardware; electronics product pages stay shopping (rules run first); maker courses → hardware, general
  STEM courses → learning.
- **Owner's call: topic not picked → Videos first, then the group appears on the fly.** A YouTube video whose
  trained topic group doesn't exist goes to YouTube / Videos (pages go to Unsorted, as today). When a **second**
  auto-placed tab with that same trained topic appears (videos and pages count together), Tablight creates that
  trained group (its trained id, name, colour, icon) and moves those auto-placed tabs into it at once, with a notice
  ("New group: Hardware & making · 2 tabs" + Undo). User-placed tabs never move. A trained group the user deleted is
  not re-created on the fly (remembered like dismissed suggestions); picking it again in the interests step brings it
  back. This applies to every install, Skip included, and replaces the "suggest the trained group" rule above.
- **Owner's call: as many new trained groups as the model can keep apart.** The catalog is broad; groups appear
  only when picked or when browsing shows the topic (rule above), so no one sees empty groups. Proposed first
  catalog (14 new): Hardware & making · Science & engineering · Sports · Food & cooking · Cars & vehicles ·
  Home & garden · Fashion & beauty · Pets & animals · Parenting & family · Jobs & careers · Books & reading ·
  Photography · Anime & comics · Real estate. Any label whose own blind-holdout accuracy is below the gate after
  training is dropped from the release (not shipped half-working); the others ship.

## Left to the builder

Exact chip list order and copy, seed phrases, the training-data rule text, layout of the step (matching the welcome
card), how "re-classify" is triggered (existing regroup path), and the YouTube quality check thresholds (set from
the first measured run, then held).

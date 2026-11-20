/**
 * Maps a Wikidata description to a Tablight label. The entry whose phrase appears earliest in the description wins;
 * on a tie the earlier (more specific) table row wins. Whole words or phrases only.
 */
const TABLE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['music', ['film score', 'soundtrack album', 'soundtrack', 'studio album', 'album', 'rock band', 'band', 'musical group',
    'music group', 'singer', 'rapper', 'musician', 'composer', 'record label', 'song', 'ep']],
  ['hardware', ['video game console', 'semiconductor', 'microcontroller', 'integrated circuit', 'processor',
    'graphics card', 'graphics processing unit', 'single-board computer']],
  ['anime', ['anime', 'manga', 'light novel', 'visual novel']],
  ['games', ['video game', 'computer game', 'board game']],
  ['movies', ['television film', 'film series', 'film']],
  ['tv', ['television series', 'tv series', 'web series', 'miniseries', 'sitcom', 'television program', 'television programme']],
  ['books', ['novel', 'book series', 'short story', 'poetry collection', 'comic book']],
  ['cars', ['automobile', 'car model', 'car manufacturer', 'automobile manufacturer']],
  ['sports', ['football club', 'basketball team', 'sports team', 'national team', 'football player', 'footballer',
    'basketball player', 'tennis player', 'cricketer', 'racing driver', 'boxer', 'athlete', 'formula one']],
];
const compiled = TABLE.map(([label, phrases]) => ({
  label,
  res: phrases.map((p) => new RegExp(`(?<![a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`)),
}));
export function describeLabel(description: string): string | null {
  const d = description.toLowerCase();
  let best: { pos: number; label: string } | null = null;
  for (const { label, res } of compiled) {
    for (const re of res) {
      const m = re.exec(d);
      if (m && (!best || m.index < best.pos)) best = { pos: m.index, label };
    }
  }
  if (best) return best.label;
  return null;
}

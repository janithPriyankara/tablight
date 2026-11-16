/**
 * High-precision domain/path rules, run before embeddings.
 * Only pages whose group is certain from the URL (plus explicit title hints)
 * are decided here; everything else returns null and goes to the model.
 */

/** Title says it is a series/season/episode (IMDb type hints, streaming titles). */
const TV_HINT =
  /\b(?:TV (?:Series|Mini[- ]Series|Episode|Special)|Mini[- ]?Series|Limited Series|Season \d+|S\d{1,2}\s*:?\s*E\d{1,3}|Episode \d+)\b/i;

function parse(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
}

const byHint = (title: string) => (TV_HINT.test(title) ? 'tv' : 'movies');

/** Streaming services: decide movie vs series from the path when it says so, else from the title. */
function streaming(host: string, path: string, title: string): string | null {
  switch (host) {
    case 'netflix.com':
      // Netflix page titles never say "Season" and read the same for a show and a film ("Watch X | Netflix
      // Official Site"), and the model can't tell them apart by name either. Most of Netflix is series: TV.
      return /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:title|watch)\//i.test(path) ? 'tv' : null;
    case 'primevideo.com':
      return /^\/(?:region\/[a-z]+\/)?(?:detail|dp)\//i.test(path) ? byHint(title) : null;
    case 'disneyplus.com':
      if (/^\/(?:[a-z-]+\/)?series\//i.test(path)) return 'tv';
      if (/^\/(?:[a-z-]+\/)?movies\//i.test(path)) return 'movies';
      return null;
    case 'hulu.com':
      if (path.startsWith('/series/')) return 'tv';
      if (path.startsWith('/movie/')) return 'movies';
      return null;
    case 'max.com':
    case 'play.max.com':
      if (/^\/(?:show|shows)\//.test(path)) return 'tv';
      if (/^\/(?:movie|movies)\//.test(path)) return 'movies';
      return null;
    case 'tv.apple.com':
      if (/^\/(?:[a-z]{2}\/)?show\//.test(path)) return 'tv';
      if (/^\/(?:[a-z]{2}\/)?movie\//.test(path)) return 'movies';
      return null;
    default:
      return null;
  }
}

function imdb(path: string, title: string): string | null {
  if (!/^\/title\/tt\d+/.test(path)) return null;
  if (/\(Video Game\b/i.test(title)) return 'games';
  return byHint(title);
}

function music(host: string, path: string): string | null {
  if (host === 'music.youtube.com' || host === 'music.apple.com') return 'music';
  if (host === 'youtube.com' && (path === '/music' || path.startsWith('/music/'))) return 'music';
  if (host === 'open.spotify.com' && /^\/(?:intl-[a-z]+\/)?(?:track|album|playlist|artist)\//.test(path)) return 'music';
  if (host === 'bandcamp.com' || host.endsWith('.bandcamp.com')) return 'music';
  return null;
}

const AMAZON = /^(?:smile\.)?amazon\.(?:com|ca|com\.mx|com\.br|co\.uk|de|fr|it|es|nl|se|pl|com\.tr|ae|sa|in|co\.jp|sg|com\.au|eg)$/;
const EBAY = /^ebay\.(?:com|ca|co\.uk|de|fr|it|es|nl|at|ch|ie|pl|com\.au|com\.sg|com\.my|ph)$/;

function shopping(host: string, path: string): string | null {
  if (AMAZON.test(host) && /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(path)) return 'shopping';
  if (EBAY.test(host) && path.startsWith('/itm/')) return 'shopping';
  if (/^(?:[a-z]{2}\.)?aliexpress\.(?:com|us|ru)$/.test(host) && path.startsWith('/item/')) return 'shopping';
  if (host === 'etsy.com' && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?listing\//.test(path)) return 'shopping';
  return null;
}

/**
 * Single-purpose services: every page on these hosts belongs to one group.
 * A leading dot also matches subdomains (per-team tenants such as acme.slack.com).
 * Topic-neutral hosts are deliberately absent and left to the model: general storage and notes
 * (Google Docs/Drive, Notion), personal task boards, reddit, github, youtube, docs.* sites.
 */
const HOSTS: Record<string, string[]> = {
  work: [
    'mail.google.com', 'calendar.google.com', 'meet.google.com', 'outlook.office.com', 'outlook.office365.com',
    'outlook.live.com', 'teams.microsoft.com', '.slack.com', '.zoom.us', '.atlassian.net', 'linear.app',
    '.okta.com', '.lightning.force.com',
  ],
  social: [
    'x.com', 'twitter.com', 'messenger.com', 'instagram.com', 'tiktok.com', 'threads.net', 'threads.com',
    'bsky.app', 'web.whatsapp.com', 'web.telegram.org',
  ],
  design: ['figma.com', 'dribbble.com', 'behance.net'],
  programming: ['stackoverflow.com'],
  docs: ['developer.mozilla.org'],
  ai: ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'perplexity.ai', 'huggingface.co'],
  learning: [
    'coursera.org', 'udemy.com', 'edx.org', 'khanacademy.org', 'duolingo.com', 'skillshare.com', 'codecademy.com',
  ],
  travel: [
    'booking.com', 'airbnb.com', 'expedia.com', 'skyscanner.net', 'skyscanner.com', 'kayak.com', 'hotels.com',
    'tripadvisor.com',
  ],
  health: ['strava.com', 'connect.garmin.com', 'myfitnesspal.com'],
  games: ['store.playstation.com', 'store.epicgames.com', 'chess.com', 'lichess.org'],
  finance: ['coinmarketcap.com', 'coinbase.com'],
  music: ['soundcloud.com'],
  videos: ['twitch.tv'],
};
const HOST_TABLE = Object.entries(HOSTS).flatMap(([g, hosts]) => hosts.map((h) => [h, g] as const));
function byHost(host: string, path: string): string | null {
  // The LinkedIn feed and inbox are social; profiles, jobs and courses are not decided here.
  if (host === 'linkedin.com') {
    return /^\/(?:feed|posts|messaging|notifications|mynetwork)(?:\/|$)/.test(path) ? 'social' : null;
  }
  if (host === 'discord.com') return path.startsWith('/channels/') ? 'social' : null;
  for (const [h, g] of HOST_TABLE) {
    if (h.startsWith('.') ? host === h.slice(1) || host.endsWith(h) : host === h) return g;
  }
  return null;
}
export function ruleGroup(url: string, title: string): string | null {
  const u = parse(url);
  if (!u) return null;
  const host = hostOf(u);
  const path = u.pathname;
  const t = title ?? '';
  if (host === 'imdb.com') return imdb(path, t);
  if (host === 'store.steampowered.com' && path.startsWith('/app/')) return 'games';
  return streaming(host, path, t) ?? music(host, path) ?? shopping(host, path) ?? byHost(host, path);
}

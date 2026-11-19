import type { Item, Kind } from './types';
const TRACKING = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_eid', 'mc_cid', 'si', 'ref', 'ref_src',
  'igshid', 'spm', '_hsenc', '_hsmi',
]);
const MAX_TITLE = 300;
function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
function webUrl(url: string): URL | null {
  const u = parse(url);
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
}
function bareHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(www|m)\./, '');
}
function isTracking(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith('utm_') || TRACKING.has(k);
}
export function normalizeUrl(url: string): string {
  const u = webUrl(url);
  if (!u) return url;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const isYoutube = host === 'youtube.com' || host === 'm.youtube.com';
  let path = u.pathname;
  const params: [string, string][] = [];
  // The mobile site is the same page: one form, so desktop and mobile copies dedupe and share a sync id.
  let outHost = host === 'm.youtube.com' ? 'youtube.com' : host;
  if (host === 'youtu.be') {
    const id = path.split('/').filter(Boolean)[0];
    if (id) {
      outHost = 'youtube.com';
      path = '/watch';
      params.push(['v', id]);
    }
  }
  for (const [k, v] of u.searchParams) {
    if (isTracking(k)) continue;
    if ((isYoutube || outHost === 'youtube.com') && k === 't') continue;
    params.push([k, v]);
  }
  // Sorted by key; on YouTube `v` leads (the brief's canonical form `?v=abc&list=L1`).
  const yt = outHost === 'youtube.com';
  const rank = (k: string) => (yt && k === 'v' ? 0 : 1);
  params.sort((a, b) => rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // Trailing slashes trimmed with a loop: the regex /\/+$/ is quadratic on a long run of slashes, and any
  // web page can set such a URL (history.replaceState) to stall the background.
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) end--;
  if (end < path.length) path = path.slice(0, end) || '/';
  const q = new URLSearchParams(params).toString();
  // Keep app routes, drop plain anchors: "#/x" and "#!x" (SPA routers) and "#view/id" (Gmail, Keep) name a
  // different page; "#section" only scrolls the same one.
  const hash = /^#.*[/!]/.test(u.hash) ? u.hash : '';
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${outHost}${port}${path}${q ? `?${q}` : ''}${hash}`;
}
/**
 * The start time (seconds) a YouTube link carries (t=754, t=754s, t=12m34s, t=1h2m3s, start=90), or null.
 * Shown as "from 12:34" so a half-watched video shared or resumed at a time is recognisable.
 */
export function startAt(url: string): number | null {
  const u = webUrl(url);
  if (!u) return null;
  const host = bareHost(u);
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;
  const raw = u.searchParams.get('t') ?? u.searchParams.get('start');
  if (!raw) return null;
  const m = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const secs = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return secs > 0 ? secs : null;
}
export function isWebUrl(url: string): boolean {
  return webUrl(url) !== null;
}
export function domainOf(url: string): string {
  if (!isWebUrl(url)) return '';
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}
/** New-tab pages that hold no page of their own. */
const BLANK_TABS = new Set(['', 'about:blank', 'about:newtab', 'chrome://newtab/', 'edge://newtab/', 'chrome://new-tab-page/']);
/**
 * Tabs not worth listing: this extension's own pages (`ownOrigin` is chrome.runtime.getURL('')) and blank
 * new tabs. Other browser pages (settings, files, other extensions) are still the user's tabs and stay.
 */
/** An empty new-tab page (or a tab that hasn't loaded anything yet). */
export function isBlankTab(url: string): boolean {
  return BLANK_TABS.has(url);
}
export function isClutterTab(url: string, ownOrigin: string): boolean {
  return BLANK_TABS.has(url) || (ownOrigin !== '' && url.startsWith(ownOrigin));
}
export function isSafeToOpen(url: string): boolean {
  const u = webUrl(url);
  return u !== null && u.username === '' && u.password === '';
}
const WATCH_HOSTS = [
  'netflix.com', 'primevideo.com', 'disneyplus.com', 'twitch.tv', 'vimeo.com', 'hulu.com', 'max.com',
];
function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
export function kindOf(url: string): Kind {
  const u = webUrl(url);
  if (!u) return 'other';
  const host = bareHost(u);
  if (host === 'youtu.be') return 'watch';
  if (host === 'youtube.com') {
    return u.pathname === '/watch' || u.pathname.startsWith('/shorts/') ? 'watch' : 'read';
  }
  if (host === 'imdb.com') return u.pathname.startsWith('/title/') ? 'watch' : 'read';
  if (WATCH_HOSTS.some((d) => hostIs(host, d))) return 'watch';
  return 'read';
}
export function readableSource(url: string): string {
  const u = webUrl(url);
  if (!u) return '';
  const host = bareHost(u);
  if (host === 'youtube.com' || host === 'youtu.be') return 'YouTube video';
  if (host === 'github.com') {
    const [org, repo] = u.pathname.split('/').filter(Boolean);
    return org && repo ? `GitHub repository ${org} ${repo}` : 'GitHub';
  }
  return host;
}
const SITE_SUFFIX = new RegExp(
  `\\s+[-|\\u2013\\u2014]\\s+(?:${['YouTube', 'Netflix', 'GitHub', 'Twitch', 'Vimeo', 'Hulu', 'IMDb', 'Prime Video', 'Disney\\+', 'Max']
    .join('|')})\\s*$`,
  'i',
);
function words(url: string): string {
  const u = parse(url);
  if (!u || !u.hostname) return '';
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  const pw = path.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return [host, ...pw].join(' ');
}
function cap(s: string): string {
  if (s.length <= MAX_TITLE) return s;
  let out = s.slice(0, MAX_TITLE);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
}
export function cleanTitle(title: string, url: string): string {
  let t = (title ?? '').trim();
  t = t.replace(/^\(\d+\+?\)\s*/, '');
  const stripped = t.replace(SITE_SUFFIX, '').trim();
  if (stripped) t = stripped;
  if (!t || t === url.trim() || /^https?:\/\/\S+$/i.test(t)) t = words(t && /^https?:/i.test(t) ? t : url);
  return cap(t);
}
const PATH_NOISE = new Set([
  'www', 'index', 'html', 'htm', 'shtml', 'php', 'asp', 'aspx', 'jsp', 'cgi', 'watch', 'amp', 'en', 'us', 'gb', 'uk',
]);
const MAX_PATH_WORDS = 8;
function isPathWord(t: string): boolean {
  if (t.length < 2 || t.length > 24 || !/\p{L}/u.test(t)) return false;
  if (PATH_NOISE.has(t.toLowerCase())) return false;
  const digits = (t.match(/\p{N}/gu) ?? []).length;
  if (digits === 0) return true;
  // Ids and hashes: tt15398776, B09XS7JWHH, 3f2a1b0c9d8e…, and UUID fragments such as 1b3c.
  return t.length < 5 && digits < 3 && !(t.length >= 3 && /^[0-9a-f]+$/i.test(t));
}
/** Meaningful words from the URL path (spec 7.3.1): no ids, hashes, file extensions or locale noise. */
export function pathWords(url: string): string {
  const u = webUrl(url);
  if (!u) return '';
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return '';
  }
  let segments = path.split('/');
  // readableSource already names the GitHub org and repo.
  if (bareHost(u) === 'github.com') segments = segments.slice(3);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of segments.join('/').split(/[/\-_.\s]+/u)) {
    const key = t.toLowerCase();
    if (!isPathWord(t) || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === MAX_PATH_WORDS) break;
  }
  return out.join(' ');
}
/** A YouTube watch, Shorts or youtu.be page. */
export function isYouTubeVideo(url: string): boolean {
  const u = webUrl(url);
  if (!u) return false;
  const host = bareHost(u);
  return (host === 'youtube.com' || host === 'youtu.be') && kindOf(url) === 'watch';
}
/** Title and address only. A YouTube video is read by its title alone: the source word would pull every video together. */
export function embedText(item: Pick<Item, 'title' | 'url'>): string {
  if (isYouTubeVideo(item.url)) return cleanTitle(item.title, item.url);
  const words = pathWords(item.url);
  return `${cleanTitle(item.title, item.url)} — ${readableSource(item.url)}${words ? ` ${words}` : ''}`;
}

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
  let outHost = host;
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
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  const q = new URLSearchParams(params).toString();
  // Keep SPA-style routes (#/ or #!), drop plain anchors.
  const hash = /^#[/!]/.test(u.hash) ? u.hash : '';
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${outHost}${port}${path}${q ? `?${q}` : ''}${hash}`;
}
export function isWebUrl(url: string): boolean {
  return webUrl(url) !== null;
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
  // Ids and hashes: tt15398776, B09XS7JWHH, 3f2a1b0c9d8e…
  return digits === 0 || (t.length < 5 && digits < 3);
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
export function embedText(item: Pick<Item, 'title' | 'url'>): string {
  const words = pathWords(item.url);
  return `${cleanTitle(item.title, item.url)} — ${readableSource(item.url)}${words ? ` ${words}` : ''}`;
}

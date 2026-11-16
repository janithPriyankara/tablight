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
export function embedText(item: Pick<Item, 'title' | 'url'>): string {
  return `${cleanTitle(item.title, item.url)} — ${readableSource(item.url)}`;
}

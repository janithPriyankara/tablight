import type { Clue, SuspiciousTab, TabContext } from '../shared/clues';
import type { Item } from '../shared/types';
import { domainOf, isWebUrl } from '../shared/url';
const CLICK_SEGMENTS = new Set(['click', 'redirect', 'go', 'r', 'out']);
const CLICK_KEYS = new Set(['key', 'visitor_id', 'clickid', 'click_id', 'zoneid', 'campaign_id', 'subid', 'cid', 'pubid', 'bid']);
const SPAM_TLDS = new Set(['space', 'top', 'xyz', 'click', 'buzz', 'rest', 'cfd', 'sbs', 'icu']);
/** Loopback, private and link-local hosts: a developer's own machine or router, never an ad network. */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  // IPv6: ::1 and unique-local fc00::/7 (fc.. / fd..); link-local fe80::/10 is private too.
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}
/** An ad-network click or redirect shape, a raw public IP host, a punycode host, or a spam TLD with a click shape. */
export function addressClue(url: string): boolean {
  if (!isWebUrl(url)) return false;
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const clickPath = u.pathname.toLowerCase().split('/').some((s) => CLICK_SEGMENTS.has(s));
  const clickKey = [...u.searchParams.keys()].some((k) => CLICK_KEYS.has(k.toLowerCase()));
  if (clickPath && clickKey) return true;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isIp) return !isPrivateHost(host);
  if (host.split('.').some((l) => l.startsWith('xn--'))) return true;
  const tld = host.slice(host.lastIndexOf('.') + 1);
  return SPAM_TLDS.has(tld) && (clickPath || clickKey);
}
const TITLE_PATTERNS: RegExp[] = [
  // prize
  /you (have )?won(?!['’\w])/i, /you have been selected/i, /claim your (prize|reward|gift)/i, /congratulations.{0,20}(winner|won|selected)/i,
  // gambling
  /deposit bonus/i, /free spins/i, /reveal your .{0,20}bonus/i,
  // fake alert
  /your (pc|computer|device|phone) (is|has been) (infected|locked|hacked)/i, /\d+ viruses/i, /virus(es)? (detected|found)/i,
  /call (microsoft|apple|windows) support/i,
  // fake update
  /update your (flash|browser|video) player/i, /your browser is out of date/i,
];
/** A scam-style phrase in the raw tab title. */
export function titleClue(title: string): boolean {
  return TITLE_PATTERNS.some((re) => re.test(title));
}
export function cluesFor(item: Item, ctx: TabContext | undefined): Clue[] {
  const out: Clue[] = [];
  if (ctx?.openerDomain && ctx.openerDomain !== domainOf(item.url)) out.push('opener');
  if (ctx?.popup) out.push('popup');
  if (item.opened === false) out.push('unseen');
  if (addressClue(item.url)) out.push('address');
  if (titleClue(item.title)) out.push('title');
  return out;
}
/** At least one content clue (address, title) and at least two clues in all. */
export function isSuspicious(clues: Clue[]): boolean {
  return clues.length >= 2 && (clues.includes('address') || clues.includes('title'));
}
/** Open or sleeping web tabs that look suspicious and were not kept, most recently active first. */
export function findSuspicious(items: Item[], ctx: Map<number, TabContext>, kept: Map<number, string>): SuspiciousTab[] {
  const out: SuspiciousTab[] = [];
  for (const item of items) {
    if (!item.classifiable || item.state === 'stashed' || item.tabId === undefined || !isWebUrl(item.url)) continue;
    if (kept.get(item.tabId) === item.domain) continue;
    const clues = cluesFor(item, ctx.get(item.tabId));
    if (isSuspicious(clues)) out.push({ item, clues });
  }
  return out.sort((a, b) => b.item.lastActiveAt - a.item.lastActiveAt);
}

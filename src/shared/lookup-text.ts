import { tabCore } from '../classify/names';
/**
 * Terms that stop a tab from ever being offered for look-up. Matched case-insensitively on word boundaries against the
 * title, the core and the host (on the host, terms of 4+ letters also match inside a name, e.g. "mybank.example").
 * A false refusal is cheap; leaking is not, so this list errs wide.
 */
export const SENSITIVE_TERMS: readonly string[] = [
  // banking and payments
  'bank', 'banking', 'paypal', 'invoice', 'receipt', 'checkout', 'payment', 'billing', 'wallet',
  // accounts
  'sign in', 'signin', 'sign-in', 'log in', 'login', 'password', 'account', '2fa', 'otp', 'verify',
  // health
  'medical', 'clinic', 'hospital', 'diagnosis', 'pregnancy', 'prescription', 'patient', 'therapy',
  // legal
  'legal', 'lawyer', 'divorce', 'court',
  // money and identity
  'salary', 'payslip', 'payroll', 'tax', 'ssn',
  // mail and calendar
  'mail', 'inbox', 'calendar',
];
/** Mail, documents and drive hosts are refused whatever the title says. */
const SENSITIVE_HOSTS = /^(?:mail\.google\.com|docs\.google\.com|drive\.google\.com|(?:[a-z0-9-]+\.)*outlook\.[a-z.]+)$/;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termPattern = (t: string): string => esc(t).replace(/[ -]/g, '[\\s-]+');
const TEXT_SENSITIVE = new RegExp(`(?<![a-z0-9])(?:${SENSITIVE_TERMS.map(termPattern).join('|')})(?![a-z0-9])`, 'i');
const HOST_SENSITIVE = new RegExp(
  `(?:${SENSITIVE_TERMS.filter((t) => /^[a-z]{4,}$/.test(t)).join('|')})|${TEXT_SENSITIVE.source}`,
  'i',
);
const LOCAL_SUFFIX = /\.(?:localhost|local|internal|lan|home|corp|intranet)$/;
function localHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || LOCAL_SUFFIX.test(h)) return true;
  if (h.startsWith('[') || h.includes(':')) return true; // any IPv6 literal, including ::1, fe80::/10 and fc00::/7
  if (/^\d+(?:\.\d+){3}$/.test(h)) return true; // any raw IPv4, private or public
  if (!h.includes('.')) return true; // single label, also an IDN that has no dot
  return false;
}
function sensitiveHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return SENSITIVE_HOSTS.test(h) || HOST_SENSITIVE.test(h.replace(/\./g, ' '));
}
const MAX_WORDS = 8;
const MAX_CHARS = 80;
/** A part number: has a dash and each dash-separated segment alternates letters and digits at most twice. */
function looksLikePartNumber(tok: string): boolean {
  if (!tok.includes('-')) return false;
  const segs = tok.split('-');
  if (segs.some((s) => s === '' || !/^[A-Za-z0-9]+$/.test(s))) return false;
  if (segs.every((x) => /^[0-9a-f]+$/i.test(x))) return false; // dashed hex, such as a UUID
  return segs.every((s) => (s.match(/[A-Za-z]+|\d+/g) ?? []).length - 1 <= 2);
}
function dropTokens(s: string): string {
  return s
    .split(/\s+/)
    .filter((tok) => {
      if (tok.length < 12) return true;
      if (!/^[A-Za-z0-9+/=_-]+$/.test(tok)) return true;
      if (looksLikePartNumber(tok)) return true;
      const letters = /[A-Za-z]/.test(tok);
      const digits = /\d/.test(tok);
      return !((letters && digits) || /[+/=_]/.test(tok) || (digits && !letters));
    })
    .join(' ');
}
/**
 * Cleans text bound for Wikidata: strips URLs and host names, emails, @handles, phone numbers, long digit runs and
 * hex/base64-like tokens, then keeps at most 8 words and 80 characters. Also applied to the user's edit.
 */
export function cleanLookupText(input: string): string {
  let s = input;
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' '); // URLs, including any user:pass@
  s = s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ' '); // emails
  s = s.replace(/\b(?:www\.)\S+/gi, ' ');
  s = s.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?/gi, ' '); // host names
  s = s.replace(/(^|\s)@\w+/g, ' '); // handles
  s = s.replace(/\+\d[\d\s().-]{7,}\d/g, ' '); // phones
  s = s.replace(/\(?\b\d{2,4}\)?[-.\s]\d{3,4}[-.]\d{3,4}\b/g, ' ');
  s = s.replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ');
  // Long tokens go before digit runs, so a hex token is dropped whole instead of leaving its letters behind.
  s = dropTokens(s.replace(/\s+/g, ' ').trim());
  s = s.replace(/\d{6,}/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const words = s.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > MAX_CHARS) break;
    out = next;
  }
  return out;
}
export type LookupRefusal = 'local' | 'sensitive' | 'scheme' | 'empty';
/** The one text that may be offered for look-up, or why nothing may be. Nothing is sent here. */
export function lookupText(url: string, title: string): { text: string } | { refused: LookupRefusal } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { refused: 'scheme' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { refused: 'scheme' };
  if (localHost(u.hostname)) return { refused: 'local' };
  const tc = tabCore(url, title);
  if (TEXT_SENSITIVE.test(title) || (tc && TEXT_SENSITIVE.test(tc.raw)) || sensitiveHost(u.hostname)) {
    return { refused: 'sensitive' };
  }
  const text = tc ? cleanLookupText(tc.raw) : '';
  return text ? { text } : { refused: 'empty' };
}

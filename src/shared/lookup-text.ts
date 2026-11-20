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
  // health, money and sign-up gaps
  'health', 'lab results', 'hiv', 'std', 'abortion', 'pharmacy', 'insurance', 'mortgage', 'loan',
  'credit card', 'debit', 'statement', 'sign up', 'signup', 'register', 'reset', 'security', 'crypto',
];
/**
 * Mail, documents, drive, calendar and cloud-storage hosts are refused whatever the title says. Matched against the
 * lower-cased host without a trailing dot.
 */
export const SENSITIVE_HOST_PATTERNS: readonly RegExp[] = [
  /(?:^|\.)(?:mail|docs|drive|sheets|slides|keep|calendar|contacts|photos|forms|meet|chat)\.google\.com$/,
  /(?:^|\.)outlook\.[a-z0-9.]+$/,
  /(?:^|\.)(?:office365|office|microsoft365|sharepoint)\.com$/,
  /(?:^|\.)(?:onedrive|mail|outlook)\.live\.com$/,
  /(?:^|\.)(?:onedrive\.com|1drv\.ms)$/,
  /(?:^|\.)mail\.yahoo\.[a-z.]+$/,
  /(?:^|\.)(?:proton\.me|protonmail\.com|proton\.ch|pm\.me)$/,
  /(?:^|\.)zoho\.[a-z.]+$/,
  /(?:^|\.)(?:dropbox|box|icloud|evernote|airtable|mega|wetransfer|notion|coda|fastmail|tutanota|tuta|gmx|aol)\.[a-z.]+$/,
  /(?:^|\.)(?:notion\.so|mega\.nz)$/,
];
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termPattern = (t: string): string => esc(t).replace(/[ -]/g, '[\\s-]+');
// Only these compound-prone terms match inside a word (MyBank, NetBanking); all others need word boundaries, with plurals.
const COMPOUND = ['bank', 'banking', 'password', 'login', 'signin', 'invoice', 'payroll', 'payslip', 'checkout', 'paypal'];
const REST = SENSITIVE_TERMS.filter((t) => !COMPOUND.includes(t));
const TEXT_SENSITIVE = new RegExp(
  `(?:${COMPOUND.join('|')})|(?<![a-z0-9])(?:${REST.map(termPattern).join('|')})(?:e?s)?(?![a-z0-9])`,
  'i',
);
const LOCAL_SUFFIX =
  /(?:^|\.)(?:localhost|local|internal|lan|home|corp|intranet|home\.arpa|test|example|invalid|localdomain|localtest\.me|lvh\.me|nip\.io|sslip\.io|xip\.io)$/;
function localHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || LOCAL_SUFFIX.test(h)) return true;
  if (h.startsWith('[') || h.includes(':')) return true; // any IPv6 literal, including ::1, fe80::/10 and fc00::/7
  if (/^\d+(?:\.\d+){3}$/.test(h)) return true; // any raw IPv4, private or public
  if (/(?:^|[.-])\d{1,3}(?:[.-]\d{1,3}){3}(?:[.-]|$)/.test(h)) return true; // a DNS name that wraps an IP
  if (!h.includes('.')) return true; // single label, also an IDN that has no dot
  return false;
}
function sensitiveHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return SENSITIVE_HOST_PATTERNS.some((re) => re.test(h)) || TEXT_SENSITIVE.test(h.replace(/\./g, ' '));
}
const MAX_WORDS = 8;
const MAX_CHARS = 80;
/** A part number: has a dash and each dash-separated segment alternates letters and digits at most twice. */
function looksLikePartNumber(tok: string): boolean {
  if (!tok.includes('-') || /\d{6,}/.test(tok)) return false;
  const segs = tok.split('-');
  if (segs.some((s) => s === '' || !/^[A-Za-z0-9]+$/.test(s))) return false;
  if (segs.every((x) => /^[0-9a-f]+$/i.test(x))) return false; // dashed hex, such as a UUID
  return segs.every((s) => (s.match(/[A-Za-z]+|\d+/g) ?? []).length - 1 <= 2);
}
/** A dashless part number such as STM32F103C8T6: upper-case letters and digits, 2+ leading letters, never hex or a key. */
function dashlessPart(tok: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{4,18}$/.test(tok) || /\d{6,}/.test(tok)) return false;
  if (/^[0-9A-F]+$/.test(tok) || /^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(tok)) return false;
  return true;
}
/** Drops hex/base64-like runs of 12+ characters, wherever they sit, even with punctuation touching them. */
function dropTokens(s: string): string {
  return s.replace(/[A-Za-z0-9+/=_-]{12,}/g, (tok) => {
    if (looksLikePartNumber(tok) || dashlessPart(tok)) return tok;
    const letters = /[A-Za-z]/.test(tok);
    const digits = /\d/.test(tok);
    return (letters && digits) || /[+/=_]/.test(tok) || (digits && !letters) ? ' ' : tok;
  });
}
function cleanOnce(input: string): string {
  let s = input;
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' '); // URLs, including any user:pass@
  s = s.replace(/\S*@\S*/g, ' '); // emails (any domain shape) and @handles
  s = s.replace(/\w+\s?(?:\(at\)|\[at\])\s?[\w.-]+(?:\s?(?:\(dot\)|\[dot\])\s?\w+)*/gi, ' ');
  s = s.replace(/\bwww\.\S+/gi, ' ');
  s = s.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?/gi, ' '); // host names
  s = s.replace(/\+\d[\d\s().-]{7,}\d/g, ' '); // international phones
  s = s.replace(/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,3})?\b/g, (m) => {
    const c = m.replace(/[ -]/g, ''); // an IBAN has 15 to 34 characters, mostly digits
    return c.length >= 15 && c.length <= 34 && (c.match(/\d/g) ?? []).length >= 10 ? ' ' : m;
  });
  s = s.replace(/\b(call|tel|phone|ph)\b([.:]?\s*)\d{3} \d{4}\b/gi, '$1 '); // 3+4 phone next to a phone word
  s = s.replace(/\b\d(?:[\s-]?\d){8,}\b/g, ' '); // grouped card, account and SSN numbers
  s = s.replace(/\(?\b\d{2,4}\)?[-.\s]\d{3,4}[-.]\d{3,4}\b/g, ' ');
  s = s.replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ');
  s = s.replace(/\b\d{2,4}[\s.-]\d{3}[\s.-]\d{4}\b/g, ' ');
  s = s.replace(/\b\d{3}[-.]\d{4}\b/g, ' ');
  // Long tokens go before digit runs, so a hex token is dropped whole instead of leaving its letters behind.
  s = dropTokens(s);
  s = s.replace(/\d{6,}/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
/** Maps a decimal digit of any script to 0-9, so the digit rules see it. */
function asciiDigit(ch: string): string {
  let cp = ch.codePointAt(0) ?? 0;
  const at = cp;
  while (cp > 0 && /\p{Nd}/u.test(String.fromCodePoint(cp - 1))) cp--;
  return String((at - cp) % 10);
}
/**
 * Cleans text bound for Wikidata: strips URLs and host names, emails, @handles, phone numbers, grouped card/IBAN/SSN
 * numbers, long digit runs and hex/base64-like tokens, then keeps at most 8 words and 80 characters. It repeats until
 * nothing changes, so cleaning the cleaned text gives the same text. Also applied to the user's edit.
 */
export function cleanLookupText(input: string): string {
  let s = input.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\p{Nd}/gu, asciiDigit);
  for (let i = 0; i < 10; i++) {
    const next = cleanOnce(s);
    if (next === s) break;
    s = next;
  }
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

import { describe, expect, it } from 'vitest';
import { cleanLookupText, lookupText } from '../../src/shared/lookup-text';
describe('lookupText', () => {
  it('uses the search query', () => {
    expect(lookupText('https://www.google.com/search?q=jack+ryan', 'jack ryan - Google Search')).toEqual({
      text: 'jack ryan',
    });
  });
  it('uses a plain title too', () => {
    expect(lookupText('https://example.org/x', 'Severance | Apple TV+')).toMatchObject({ text: expect.any(String) });
  });
  it.each([
    'http://localhost:3000/x',
    'http://app.localhost/x',
    'http://192.168.1.4/',
    'http://10.0.0.1/',
    'http://100.64.1.1/',
    'http://8.8.8.8/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://jenkins.internal/job',
    'http://nas/',
    'http://printer.local/',
    'http://router.lan/',
    'http://ｌｏｃａｌｈｏｓｔ:3000/',
    'http://xn--nas-9ua/',
    'http://xn--bcher-kva.local/',
  ])('refuses local %s', (u) => {
    expect(lookupText(u, 'Some Show')).toEqual({ refused: 'local' });
  });
  it.each(['chrome://settings', 'file:///x', 'about:blank', 'nonsense'])('refuses scheme %s', (u) => {
    expect(lookupText(u, 'Some Show')).toEqual({ refused: 'scheme' });
  });
  it.each(['Sign in', 'My password', 'Bank statement', 'Invoice 12', 'Local clinic', 'diagnosis', 'Your payslip'])(
    'refuses sensitive title %s',
    (t) => {
      expect(lookupText('https://example.com/x', t)).toEqual({ refused: 'sensitive' });
    },
  );
  it('refuses sensitive hosts', () => {
    expect(lookupText('https://bank.hsbc.com/x', 'Home')).toEqual({ refused: 'sensitive' });
    expect(lookupText('https://mail.google.com/x', 'Home')).toEqual({ refused: 'sensitive' });
    expect(lookupText('https://outlook.live.com/x', 'Home')).toEqual({ refused: 'sensitive' });
    expect(lookupText('https://docs.google.com/x', 'Home')).toEqual({ refused: 'sensitive' });
    expect(lookupText('https://drive.google.com/x', 'Home')).toEqual({ refused: 'sensitive' });
  });
  it('refuses a search query with a sensitive term', () => {
    expect(lookupText('https://www.google.com/search?q=divorce+lawyer', 'x')).toEqual({ refused: 'sensitive' });
  });
  it('a title of only sensitive words is refused', () => {
    expect(lookupText('https://example.com/', 'Login - Password - Account')).toEqual({ refused: 'sensitive' });
  });
  it('checks scheme before local before sensitive before empty', () => {
    expect(lookupText('file:///localhost', 'password')).toEqual({ refused: 'scheme' });
    expect(lookupText('http://localhost/', 'password')).toEqual({ refused: 'local' });
  });
  it('never carries URL credentials', () => {
    const r = lookupText('http://user:pass@example.com/', 'Severance');
    expect(JSON.stringify(r)).not.toMatch(/user|pass/);
  });
  it('refuses with empty when cleaning removes everything', () => {
    expect(lookupText('https://example.com/', 'www.example.org 123456789')).toEqual({ refused: 'empty' });
    expect(lookupText('https://example.com/', '   ')).toEqual({ refused: 'empty' });
  });
});
describe('cleanLookupText', () => {
  it('removes emails, long digits and hex tokens, keeps a short part name', () => {
    const out = cleanLookupText('mail me at a.b@c.com about ACS770 order 123456789 token 9f8e7d6c5b4a3f2e1d0c');
    expect(out).toContain('ACS770');
    expect(out).not.toMatch(/@|123456789|9f8e7d/);
    expect(out.split(' ').length).toBeLessThanOrEqual(8);
    expect(out.length).toBeLessThanOrEqual(80);
  });
  it('keeps a 14-character part number but drops hex and uuid tokens', () => {
    expect(cleanLookupText('ACS770KCB-150B current sensor')).toBe('ACS770KCB-150B current sensor');
    expect(cleanLookupText('id 550e8400-e29b-41d4-a716-446655440000 jack')).toBe('id jack');
    expect(cleanLookupText('abcdef0123456789abcdef x')).toBe('x');
    expect(cleanLookupText('dGhpcyBpcyBiYXNlNjQ= ok')).toBe('ok');
  });
  it('keeps long plain words', () => {
    expect(cleanLookupText('Cinematography basics')).toBe('Cinematography basics');
  });
  it('removes urls, hosts, handles and phones', () => {
    expect(cleanLookupText('see https://a.com/x?y=1 and example.org by @someone call +1 555 123 4567 jack')).toBe(
      'see and by call jack',
    );
    expect(cleanLookupText('call 555-123-4567 now')).toBe('call now');
  });
  it('keeps years and short numbers', () => {
    expect(cleanLookupText('Dune 2021 part 2')).toBe('Dune 2021 part 2');
  });
  it('caps at 8 words and 80 characters on a word boundary', () => {
    expect(cleanLookupText('a b c d e f g h i j')).toBe('a b c d e f g h');
    const out = cleanLookupText('abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij');
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('abcdefghij')).toBe(true);
  });
});

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

describe('round 1 review probes', () => {
  it.each([
    ['token:9f8e7d6c5b4a3f2e1d0c x', 'token: x'],
    ['(9f8e7d6c5b4a3f2e1d0c) x', '( ) x'],
    ['9f8e7d6c5b4a3f2e1d0c, x', ', x'],
    ['key="sk-AbC123dEf456GhI789" x', 'key=" " x'],
    ['ref:550e8400-e29b-41d4-a716-446655440000 x', 'ref: x'],
  ])('drops a token joined to punctuation: %s', (i, o) => {
    const out = cleanLookupText(i);
    expect(out).not.toMatch(/9f8e|AbC123|550e|e29b|446655/);
    expect(out).toBe(o.replace(/\s+/g, ' ').trim());
  });
  it.each(['Manage your passwords', 'Your Accounts', 'Invoices', 'Payments history', 'Receipts', 'Taxes', 'Patients',
    'MyBank Online', 'NetBanking', 'Health records', 'Mortgage statement', 'Sign up'])('refuses %s', (t) => {
    expect(lookupText('https://example.com/x', t)).toEqual({ refused: 'sensitive' });
  });
  it('refuses plural in a search query', () => {
    expect(lookupText('https://www.google.com/search?q=my+passwords', 'x')).toEqual({ refused: 'sensitive' });
  });
  it.each([
    'https://outlook.office365.com/mail/',
    'https://onedrive.live.com/edit?id=1',
    'https://contoso.sharepoint.com/x',
    'https://www.dropbox.com/s/x',
    'https://app.box.com/file/1',
    'https://www.icloud.com/iclouddrive/',
    'https://drive.proton.me/',
    'https://docs.zoho.com/x',
    'https://sheets.google.com/x',
    'https://keep.google.com/',
    'https://www.notion.so/x',
  ])('refuses mail/docs/drive host %s', (u) => {
    expect(lookupText(u, 'Budget 2025 Q3 plan')).toEqual({ refused: 'sensitive' });
  });
  it.each([
    '4111 1111 1111 1111 x',
    '4111-1111-1111-1111 x',
    'GB82 WEST 1234 5698 7654 32 x',
    'DE89 3704 0044 0532 0130 00 x',
    '123-45-6789 x',
    '123 45 6789 x',
  ])('removes grouped numbers: %s', (i) => {
    expect(cleanLookupText(i)).toBe('x');
  });
  it('removes DNS names that wrap an IP and reserved suffixes', () => {
    for (const u of ['http://10.0.0.1.nip.io/', 'http://127.0.0.1.sslip.io/', 'http://localtest.me/', 'http://router.home.arpa/', 'http://app.test/']) {
      expect(lookupText(u, 'Some Show')).toEqual({ refused: 'local' });
    }
  });
  it('handles full-width and other-script digits, zero-width characters and host queries', () => {
    expect(cleanLookupText('Jack １２３４５６７８９')).toBe('Jack');
    expect(cleanLookupText('١٢٣٤٥٦٧٨٩ x')).toBe('x');
    expect(cleanLookupText('12345\u200b67890 x')).toBe('x');
    expect(cleanLookupText('see x.co?token=abc now')).toBe('see now');
  });
  it('removes emails of odd shapes and partial phones', () => {
    expect(cleanLookupText('user@localhost jack')).toBe('jack');
    expect(cleanLookupText('a @ b.com jack')).toBe('a jack');
    expect(cleanLookupText('a(at)b.com jack')).toBe('jack');
    expect(cleanLookupText('77 123 4567 x')).toBe('x');
    expect(cleanLookupText('555-1234 x')).toBe('x');
  });
  it('keeps years and part numbers', () => {
    expect(cleanLookupText('Dune 2021 part 2')).toBe('Dune 2021 part 2');
    expect(cleanLookupText('ACS770KCB-150B')).toBe('ACS770KCB-150B');
  });
  it('is idempotent and bounded over 3000 seeded random inputs', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const frags = ['jack', 'ryan', 'ACS770KCB-150B', '9f8e7d6c5b4a3f2e1d0c', '123456789', '4111 1111 1111 1111', 'a@b.com',
      '@x', '@', '(', ')', ':', ',', '"', 'example.org', 'https://a.com/x?y=1', '+1', '555', '123', '4567', '-', ' ', '  ',
      'x.co?t=1', '550e8400-e29b-41d4-a716-446655440000', 'GB82', 'WEST', '1234', '5698', '１２３', 'Dune', '2021', '=', '_', '/',
      'ACS770KCB-150B-1234567', 'a(at)b.com', '\u200b', 'token'];
    for (let i = 0; i < 3000; i++) {
      const n = 1 + rnd(12);
      let input = '';
      for (let j = 0; j < n; j++) input += frags[rnd(frags.length)] + (rnd(3) === 0 ? '' : ' ');
      const out = cleanLookupText(input);
      expect(cleanLookupText(out), JSON.stringify(input)).toBe(out);
      expect(out.length).toBeLessThanOrEqual(80);
      expect(out.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
      expect(out).not.toMatch(/@|\d{6,}/);
    }
  });
});

describe('round 2 review', () => {
  it.each(['IP68 rated phone case', 'gt86 review', 'HD44780 LCD display module', 'ES2015 features explained',
    'Dune AB12 part one two three', 'MK11 ultimate edition', 'FM24 tactics guide', 'XC90 recharge hybrid'])('keeps %s', (t) => {
    expect(cleanLookupText(t)).toBe(t);
  });
  it('still removes real IBANs', () => {
    expect(cleanLookupText('GB82 WEST 1234 5698 7654 32 x')).toBe('x');
    expect(cleanLookupText('DE89 3704 0044 0532 0130 00 x')).toBe('x');
    expect(cleanLookupText('NL91ABNA0417164300 x')).toBe('x');
  });
  it.each(['Courtney Barnett', 'Mailchimp templates', 'Doctor Who', 'Legally Blonde', 'Patience song'])('allows %s', (t) => {
    expect(lookupText('https://example.com/x', t)).toEqual({ text: t });
  });
  it.each(['MyBank login', 'NetBanking', 'accountant salary', 'Manage your passwords'])('refuses %s', (t) => {
    expect(lookupText('https://example.com/x', t)).toEqual({ refused: 'sensitive' });
  });
  it('keeps dashless part numbers and drops key shapes', () => {
    expect(cleanLookupText('STM32F103C8T6 datasheet')).toBe('STM32F103C8T6 datasheet');
    expect(cleanLookupText('TPS62133RGTR buck')).toBe('TPS62133RGTR buck');
    for (const k of ['sk-proj-AbC123dEf456GhI789', 'ghp_AbC123dEf456GhI789jKl', 'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', '550e8400-e29b-41d4-a716-446655440000',
      '9f8e7d6c5b4a3f2e1d0c', 'ABCDEF0123456789ABCD']) {
      expect(cleanLookupText(`k ${k} x`), k).toBe('k x');
    }
  });
  it('removes a 3+4 phone next to a phone word only', () => {
    expect(cleanLookupText('call 555 1234 now')).toBe('call now');
    expect(cleanLookupText('Dune 555 1234')).toBe('Dune 555 1234');
  });
});

describe('round 3 review', () => {
  it.each(['JBSWY3DPEHPK3PXP', 'GEZDGNBVGY3TQOJQ', 'KRSXG5CTMVRXEZLU', 'JBSWY3DPEHPK3PXPJBSW'])('drops TOTP seed %s', (k) => {
    expect(cleanLookupText(`k ${k} x`)).toBe('k x');
  });
  it.each(['STM32F103C8T6', 'TPS62133RGTR', 'NRF52840QIAA', 'ESP32S3WROOM1', 'SN74HC595N'])('keeps part %s', (p) => {
    expect(cleanLookupText(`${p} x`)).toBe(`${p} x`);
  });
  it('refuses appointments but not Doctor Who', () => {
    expect(lookupText('https://example.com/x', 'My doctor appointment notes')).toEqual({ refused: 'sensitive' });
    expect(lookupText('https://example.com/x', 'Appointments')).toEqual({ refused: 'sensitive' });
    expect(lookupText('https://example.com/x', 'Doctor Who')).toEqual({ text: 'Doctor Who' });
  });
});

// ReDoS guard. Tab titles and URLs come from any web page, so (a) no regex in src/ may backtrack worse than
// quadratically (recheck decides: exponential and 3rd degree or worse fail), and (b) every function that runs regexes on
// page text cuts it to MAX_TEXT first, so even a megabyte of adversarial text is matched in milliseconds.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { checkSync } from 'recheck';
import { describe, expect, it } from 'vitest';
import { nameCluster } from '../../src/classify/cluster';
import { tabCore } from '../../src/classify/names';
import { ruleGroup } from '../../src/classify/rules';
import { titleClue } from '../../src/background/suspicious';
import { MAX_TEXT, clipText } from '../../src/shared/clip';
import { cleanLookupText } from '../../src/shared/lookup-text';
import { cleanTitle } from '../../src/shared/url';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}
function regexLiterals(file: string): { src: string; flags: string; line: number }[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { src: string; flags: string; line: number }[] = [];
  const visit = (n: ts.Node): void => {
    if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const lit = n.getText(sf);
      const end = lit.lastIndexOf('/');
      out.push({ src: lit.slice(1, end), flags: lit.slice(end + 1), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('regexes', () => {
  it('no regex literal in src/ is exponential or worse than 2nd-degree polynomial', () => {
    const bad: string[] = [];
    let n = 0;
    for (const file of sources('src')) {
      for (const r of regexLiterals(file)) {
        n++;
        const res = checkSync(r.src, r.flags, { timeout: 10_000 });
        if (res.status !== 'vulnerable') continue;
        const c = res.complexity;
        if (c.type === 'exponential' || (c.type === 'polynomial' && c.degree > 2)) bad.push(`${file}:${r.line} ${c.summary} /${r.src}/`);
      }
    }
    expect(n).toBeGreaterThan(100); // the walk finds them (there are hundreds)
    expect(bad).toEqual([]);
  }, 120_000);
});

describe('page text is capped before matching', () => {
  it('clipText cuts to MAX_TEXT and never splits a surrogate pair', () => {
    expect(clipText('a'.repeat(MAX_TEXT + 5))).toHaveLength(MAX_TEXT);
    const emoji = 'a'.repeat(MAX_TEXT - 1) + '😀';
    expect(clipText(emoji)).toBe('a'.repeat(MAX_TEXT - 1));
    expect(clipText('short')).toBe('short');
  });
  // Shapes from recheck's attack strings for the quadratic regexes: long runs of spaces, dots, @, digits and
  // near-misses of the suffixes ("on Steam", "(2023)", "- Wikipedia").
  const MB = 1 << 20;
  const attacks = [
    ' '.repeat(MB) + 'x',
    '\t'.repeat(MB) + '(',
    'a.'.repeat(MB / 2) + '!',
    '@'.repeat(MB),
    '1'.repeat(MB) + 'x',
    ' (2023'.repeat(MB / 6),
    ' on Stea'.repeat(MB / 8),
    ' - Wikipedi'.repeat(MB / 11),
    'x(at)y'.repeat(MB / 6),
    "a.'-".repeat(MB / 4) + '!',
  ];
  const url = 'https://en.wikipedia.org/wiki/X';
  const fns: [string, (s: string) => unknown][] = [
    ['tabCore', (s) => tabCore(url, s)],
    ['ruleGroup', (s) => ruleGroup('https://www.imdb.com/title/tt1/', s)],
    ['titleClue', (s) => titleClue(s)],
    ['cleanLookupText', (s) => cleanLookupText(s)],
    ['cleanTitle', (s) => cleanTitle(s, url)],
    ['nameCluster', (s) => nameCluster([s, s], ['a.com', 'b.com'])],
  ];
  for (const [name, fn] of fns) {
    it(`${name} handles a megabyte of adversarial text quickly`, () => {
      for (const a of attacks) {
        const t0 = performance.now();
        fn(a);
        // Uncapped, the worst of these takes minutes; capped, milliseconds. 1 s leaves room for a slow CI host.
        expect(performance.now() - t0, `${name} on ${JSON.stringify(a.slice(0, 12))}…`).toBeLessThan(1000);
      }
    });
  }
});

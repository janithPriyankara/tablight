// Writes scripts/finetune/fixtures/embedtext.json: 200 pool rows with the text the TS embedText gives them, plus
// hand-written edge rows, so test_embedtext.py can check the Python port against the real function.
//
//   node scripts/finetune/gen-fixture.mjs            # the fixture
//   node scripts/finetune/gen-fixture.mjs --all OUT  # every pool row (a full parity check; not committed)
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { runnerImport } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { embedText } = (await runnerImport(join(root, 'src/shared/url.ts'))).module;

// Same files as scripts/train-head.mjs (the pool); never the blind test sets.
const files = [
  'training/train-a.json', 'training/train-b.json', 'training/train-c.json', 'training/train-d.json', 'training/train-e.json', 'training/train-f.json',
  'tests/quality/fixture.json',
];
const seen = new Set();
const pool = [];
for (const f of files) {
  for (const r of JSON.parse(await readFile(join(root, f), 'utf8'))) {
    const key = `${r.url}\n${r.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({ title: r.title, url: r.url });
  }
}

const pair = (row) => ({ row, text: embedText(row) });
const all = process.argv.indexOf('--all');
if (all >= 0) {
  await writeFile(process.argv[all + 1], JSON.stringify(pool.map(pair)));
  process.exit(0);
}

// Rows that exercise the tricky paths first, then an even spread of the rest.
const tricky = [
  (r) => /youtube\.com\/(watch|shorts)|youtu\.be/.test(r.url) && r.title.includes('#'),
  (r) => /youtube\.com\/(watch|shorts)|youtu\.be/.test(r.url),
  (r) => r.url.includes('%'),
  (r) => /[^ -~]/.test(r.url),
  (r) => /[^ -~]/.test(r.title),
  (r) => /github\.com/.test(r.url),
  (r) => /^\(\d+\+?\)/.test(r.title) || /\s[-|–—]\s/.test(r.title),
  (r) => !r.title.trim() || r.title.trim() === r.url.trim() || /^https?:/i.test(r.title),
  (r) => !/^https?:/.test(r.url),
  (r) => /\d/.test(new URL(r.url, 'http://x').pathname),
];
const picked = new Set();
for (const test of tricky) {
  let n = 0;
  for (let i = 0; i < pool.length && n < 12; i++) {
    if (!picked.has(i) && test(pool[i])) {
      picked.add(i);
      n++;
    }
  }
}
const step = pool.length / (200 - picked.size);
for (let x = 0; picked.size < 200; x += step) {
  let i = Math.floor(x) % pool.length;
  while (picked.has(i)) i = (i + 1) % pool.length;
  picked.add(i);
}

const long = 'Ünïcödé \u{1f600} title '.repeat(20);
const edge = [
  { title: '', url: 'https://www.example.com/some-path/to_a.page.html' },
  { title: 'https://news.example.org/2024/05/story', url: 'https://news.example.org/2024/05/story' },
  { title: '(3) Inbox - Mail', url: 'https://mail.example.com/#inbox/abc123' },
  { title: '(12+) Feed', url: 'https://social.example.com/' },
  { title: 'Great video #ClaudeCode #shorts #big_cats', url: 'https://youtu.be/abc123?t=40' },
  { title: '#shorts #viral', url: 'https://m.youtube.com/shorts/xyz' },
  { title: 'Song – YouTube', url: 'https://www.youtube.com/watch?v=q' },
  { title: 'Repo thing · GitHub', url: 'https://github.com/org-name/repo.js/tree/main/src/deep_dir' },
  { title: 'Project - GitHub', url: 'https://github.com/only-org' },
  { title: 'Bücher', url: 'https://www.bücher.de/kategorie/kinder-bücher' },
  { title: 'Broken escape', url: 'https://example.com/a%E0%A4%A/b' },
  { title: 'Encoded', url: 'https://example.com/caf%C3%A9/na%C3%AFve' },
  { title: '', url: 'chrome://settings/privacy' },
  { title: '', url: 'about:blank' },
  { title: 'Local file', url: 'file:///Users/x/Documents/report.pdf' },
  { title: '', url: 'not a url' },
  { title: 'Ids', url: 'https://shop.example.com/dp/B09XS7JWHH/ref=abc/3f2a1b0c9d8e/1b3c/tt15398776/a1' },
  { title: 'Noise', url: 'https://example.com/en/us/index.php/www/amp/watch/x' },
  { title: 'Many words', url: 'https://example.com/one/two/three/four/five/six/seven/eight/nine/ten' },
  { title: 'Dupes', url: 'https://example.com/Foo/foo/FOO/bar' },
  { title: long, url: 'https://example.com/long' },
  { title: '    spaced title 　 ', url: 'https://www.m.example.com/x' },
  { title: 'Netflix show - Netflix', url: 'https://www.netflix.com/title/123' },
  { title: 'IMDb page', url: 'https://m.imdb.com/title/tt0111161/' },
  { title: 'Desc | Disney+', url: 'https://www.disneyplus.com/x' },
  { title: 'Port', url: 'http://localhost:8080/dashboard/main' },
  { title: 'Shorts page', url: 'https://www.youtube.com/@channel/shorts' },
];

const out = {
  generatedBy: 'node scripts/finetune/gen-fixture.mjs',
  pairs: [...picked].sort((a, b) => a - b).map((i) => pair(pool[i])),
  edge: edge.map(pair),
};
await writeFile(join(root, 'scripts/finetune/fixtures/embedtext.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${out.pairs.length} pairs + ${out.edge.length} edge rows`);

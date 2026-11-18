// Release notes from the commits since the previous version tag, grouped by their conventional prefix.
// `feat:` → New, `fix:` → Fixes, `perf:` → Faster, any `type!:` → Breaking changes. ci/test/docs/chore/refactor
// and the "release x.y.z" bump commits are left out: they don't change what users get.
//   node scripts/release-notes.mjs v1.2.0              notes for v1.2.0 (since the tag before it)
//   node scripts/release-notes.mjs HEAD --tag v1.3.0   notes for a version not tagged yet
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPO = 'janithPriyankara/tablight';
const SECTIONS = [
  ['breaking', 'Breaking changes'],
  ['feat', 'New'],
  ['fix', 'Fixes'],
  ['perf', 'Faster'],
];
const HEADER = /^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)$/;

/** The section a commit message belongs to and its one-line summary, or null when users don't need it. */
export function parseCommit(message) {
  const first = message.split('\n')[0].trim();
  const m = HEADER.exec(first);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const section = m[2] ? 'breaking' : type;
  if (!SECTIONS.some(([key]) => key === section)) return null;
  const text = m[3].trim().replace(/\.$/, '');
  return { section, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/** Markdown notes for `commits` ({ sha, message }, newest first) between tags `from` (null: none before) and `to`. */
export function releaseNotes(commits, { from, to, repo = REPO }) {
  const by = new Map();
  for (const c of commits) {
    const p = parseCommit(c.message);
    if (!p) continue;
    const list = by.get(p.section) ?? [];
    list.push(`- ${p.text} ([${c.sha.slice(0, 7)}](https://github.com/${repo}/commit/${c.sha}))`);
    by.set(p.section, list);
  }
  const parts = SECTIONS.flatMap(([key, title]) => (by.has(key) ? [`### ${title}\n\n${by.get(key).reverse().join('\n')}`] : []));
  if (!parts.length) parts.push('Maintenance release: no user-facing changes.');
  if (from) parts.push(`**Full Changelog**: https://github.com/${repo}/compare/${from}...${to}`);
  return `${parts.join('\n\n')}\n`;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** The newest v1.2.3 tag strictly before `ref`, or null for the first release. */
function previousTag(ref) {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', `${ref}^`);
  } catch {
    return null;
  }
}

function commitsBetween(from, ref) {
  const out = git('log', '--format=%H%x1f%B%x1e', from ? `${from}..${ref}` : ref);
  return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [sha, message] = s.split('\x1f');
    return { sha, message: message ?? '' };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const ref = args.find((a) => !a.startsWith('--')) ?? 'HEAD';
  const tagAt = args.indexOf('--tag');
  const to = tagAt >= 0 ? args[tagAt + 1] : ref;
  const from = previousTag(ref);
  process.stdout.write(releaseNotes(commitsBetween(from, ref), { from, to }));
}

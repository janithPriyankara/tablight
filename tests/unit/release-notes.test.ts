import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCommit, releaseNotes } from '../../scripts/release-notes.mjs';

const sha = (n: number) => String(n).repeat(40).slice(0, 40);

describe('release notes', () => {
  it('reads the first line only and keeps feat, fix, perf and breaking changes', () => {
    expect(parseCommit('feat: backups carry each open tab\'s group\n\nThe export now has...')).toEqual(
      { section: 'feat', text: 'Backups carry each open tab\'s group' });
    expect(parseCommit('fix(popup): count paused tabs.')).toEqual({ section: 'fix', text: 'Count paused tabs' });
    expect(parseCommit('perf: faster search')).toEqual({ section: 'perf', text: 'Faster search' });
    expect(parseCommit('refactor!: drop the v0 backup format')).toEqual({ section: 'breaking', text: 'Drop the v0 backup format' });
    for (const m of ['ci: run on Jenkins', 'test: more cases', 'docs: README', 'chore: deps', 'release 1.2.0', 'Merge branch x', '']) {
      expect(parseCommit(m)).toBeNull();
    }
  });
  it('groups by section, oldest first within a section, with commit links and the compare link', () => {
    const notes = releaseNotes([
      { sha: sha(4), message: 'release 1.2.0' },
      { sha: sha(3), message: 'feat: second feature' },
      { sha: sha(2), message: 'ci: pipeline' },
      { sha: sha(1), message: 'fix: a bug' },
      { sha: sha(0), message: 'feat: first feature' },
    ], { from: 'v1.1.0', to: 'v1.2.0', repo: 'o/r' });
    expect(notes).toBe([
      '### New', '',
      `- First feature ([0000000](https://github.com/o/r/commit/${sha(0)}))`,
      `- Second feature ([3333333](https://github.com/o/r/commit/${sha(3)}))`, '',
      '### Fixes', '',
      `- A bug ([1111111](https://github.com/o/r/commit/${sha(1)}))`, '',
      '**Full Changelog**: https://github.com/o/r/compare/v1.1.0...v1.2.0', '',
    ].join('\n'));
  });
  it('says so when nothing user-facing changed; the first release has no compare link', () => {
    expect(releaseNotes([{ sha: sha(1), message: 'ci: x' }], { from: null, to: 'v1.0.0' }))
      .toBe('Maintenance release: no user-facing changes.\n');
  });
  it('the command line finds the previous tag in this repository', () => {
    const tags = execFileSync('git', ['tag', '--list', 'v1.2.0'], { encoding: 'utf8' }).trim();
    if (!tags) return; // a checkout without tags (the release stage fetches them)
    const out = execFileSync('node', [resolve(import.meta.dirname, '../../scripts/release-notes.mjs'), 'v1.2.0'], { encoding: 'utf8' });
    expect(out).toContain('### New\n\n- Backups carry each open tab\'s group');
    expect(out).toContain('### Fixes\n\n- Close duplicates never closes every copy of a page');
    expect(out).toContain('compare/v1.1.0...v1.2.0');
    expect(out).not.toMatch(/release 1\.2\.0|ci:/);
  });
});

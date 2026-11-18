export const REPO: string;
export function parseCommit(message: string): { section: 'breaking' | 'feat' | 'fix' | 'perf'; text: string } | null;
export function releaseNotes(
  commits: { sha: string; message: string }[],
  opts: { from: string | null; to: string; repo?: string },
): string;

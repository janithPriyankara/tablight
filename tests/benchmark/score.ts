// Benchmark scoring, kept apart from the benchmark data so it can be unit-tested on made-up rows.
//
// Headline numbers are over non-`other` tabs only: precision = right / grouped, coverage = grouped / total,
// overall = right / total. An `other` tab is never a "right" in them, wherever it lands; `other` handling is
// reported on its own (left Unsorted vs put in a group). Strict counts a tab right only in its own group;
// lenient also accepts any group in its `also` list.
export interface BenchRow { group: string; also?: string[] }
export interface BenchTally {
  /** Non-`other` tabs. */
  total: number;
  grouped: number;
  strict: number;
  lenient: number;
  /** `other` tabs, and how they were handled. */
  others: number;
  otherUnsorted: number;
  otherGrouped: number;
  /** Strict recall per non-`other` label. */
  perLabel: Map<string, { n: number; right: number }>;
}
export const OTHER = 'other';
export function newTally(): BenchTally {
  return { total: 0, grouped: 0, strict: 0, lenient: 0, others: 0, otherUnsorted: 0, otherGrouped: 0, perLabel: new Map() };
}
/** Adds one placed tab: `groupId` is the group the pipeline chose (null: Unsorted). */
export function tally(t: BenchTally, row: BenchRow, groupId: string | null): void {
  if (row.group === OTHER) {
    t.others++;
    if (groupId === null) t.otherUnsorted++;
    else t.otherGrouped++;
    return;
  }
  t.total++;
  const l = t.perLabel.get(row.group) ?? { n: 0, right: 0 };
  l.n++;
  t.perLabel.set(row.group, l);
  if (groupId === null) return;
  t.grouped++;
  if (groupId === row.group) {
    t.strict++;
    t.lenient++;
    l.right++;
  } else if (row.also?.includes(groupId)) t.lenient++;
}
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
/** Aggregates only: never a row. */
export function report(name: string, t: BenchTally): string {
  return (
    `[benchmark ${name}] non-other tabs ${t.total}, grouped ${t.grouped}: coverage ${pct(t.grouped, t.total)}\n` +
    `  strict:  precision ${pct(t.strict, t.grouped)} (${t.strict}/${t.grouped}), overall ${pct(t.strict, t.total)} (${t.strict}/${t.total})\n` +
    `  lenient: precision ${pct(t.lenient, t.grouped)} (${t.lenient}/${t.grouped}), overall ${pct(t.lenient, t.total)} (${t.lenient}/${t.total})\n` +
    `  other tabs ${t.others}: left Unsorted ${t.otherUnsorted}, put in a group ${t.otherGrouped} (${pct(t.otherGrouped, t.others)}); ` +
    `strict precision counting those as wrong ${pct(t.strict, t.grouped + t.otherGrouped)}\n` +
    `  strict recall per label: ${[...t.perLabel].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ${v.right}/${v.n}`).join(', ')}`
  );
}

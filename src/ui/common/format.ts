/** "1 tab", "3 tabs". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
/** A title for display: the cleaned title, else the URL. */
export function displayTitle(i: { title: string; url: string }): string {
  return i.title.trim() || i.url;
}

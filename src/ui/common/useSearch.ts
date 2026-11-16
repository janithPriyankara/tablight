import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../../shared/rpc';
import type { Item } from '../../shared/types';
export const SEARCH_DEBOUNCE_MS = 150;
/** Same bound the background enforces. */
export const MAX_QUERY = 200;
export interface SearchResults { words: Item[]; meaning: Item[] }
type Reply = SearchResults & { superseded?: true };
export interface SearchHook {
  query: string;
  setQuery: (q: string) => void;
  /** null while the query is blank; the last applied results otherwise (kept while a newer one runs). */
  results: SearchResults | null;
  /** True from typing until the latest query's reply arrives. */
  pending: boolean;
  /** Message of the latest query's failure (never shown as "No matches"); null otherwise. */
  error: string | null;
}
/**
 * Debounced word + meaning search. A client-side sequence number drops replies to older queries. A reply
 * the background marked `superseded` (another page searched meanwhile) still answers this query: its word
 * matches are shown, without meaning results. A failure clears the results, so nothing stale is shown or
 * opened. Whenever `refreshKey` changes (pass the tab state), the current query is asked again at once, so
 * results never offer a tab that has closed since (or miss one that opened).
 */
export function useSearch(delay = SEARCH_DEBOUNCE_MS, refreshKey?: unknown): SearchHook {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const lastQuery = useRef('');
  const setQuery = (q: string) => setQueryState(q.slice(0, MAX_QUERY));
  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (!q) {
      setResults(null);
      setPending(false);
      setError(null);
      lastQuery.current = '';
      return;
    }
    // A refresh of the same query keeps showing the current results and asks again without a debounce.
    const refreshOnly = q === lastQuery.current;
    lastQuery.current = q;
    if (!refreshOnly) setPending(true);
    const timer = setTimeout(() => {
      send<Reply>({ t: 'search', q, semantic: true }).then(
        (r) => {
          if (mine !== seq.current) return;
          setPending(false);
          setResults({ words: r.words, meaning: r.superseded ? [] : r.meaning });
          setError(null);
        },
        (e: unknown) => {
          if (mine !== seq.current) return;
          setPending(false);
          setResults(null);
          setError(e instanceof Error ? e.message : String(e));
        },
      );
    }, refreshOnly ? 0 : delay);
    return () => clearTimeout(timer);
  }, [query, delay, refreshKey]);
  return { query, setQuery, results, pending, error };
}

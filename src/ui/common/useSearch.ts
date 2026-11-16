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
 * Debounced word + meaning search. Latest wins twice over: a client-side sequence number drops replies
 * to older queries, and replies the background marked `superseded` (another page searched meanwhile)
 * never replace the shown results, but they do end the pending state.
 */
export function useSearch(delay = SEARCH_DEBOUNCE_MS): SearchHook {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const setQuery = (q: string) => setQueryState(q.slice(0, MAX_QUERY));
  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current;
    if (!q) {
      setResults(null);
      setPending(false);
      setError(null);
      return;
    }
    setPending(true);
    const timer = setTimeout(() => {
      send<Reply>({ t: 'search', q, semantic: true }).then(
        (r) => {
          if (mine !== seq.current) return;
          setPending(false);
          if (r.superseded) return;
          setResults({ words: r.words, meaning: r.meaning });
          setError(null);
        },
        (e: unknown) => {
          if (mine !== seq.current) return;
          setPending(false);
          setError(e instanceof Error ? e.message : String(e));
        },
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [query, delay]);
  return { query, setQuery, results, pending, error };
}

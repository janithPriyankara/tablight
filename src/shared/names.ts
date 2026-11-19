// The group-name rule, shared by the background (create, rename, import, sync, interests) and the UI's checks.

export const MAX_NAME = 60;

/** A non-empty string of at most MAX_NAME characters after trimming; returns the trimmed name. */
export function parseName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > MAX_NAME) throw new Error(`name must be 1-${MAX_NAME} characters`);
  return name;
}

/** The rule's message for a name it refuses (first letter capitalised, to show on screen); null when it is fine. */
export function nameProblem(v: string): string | null {
  try {
    parseName(v);
    return null;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return m.charAt(0).toUpperCase() + m.slice(1);
  }
}

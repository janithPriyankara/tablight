/** One-time explanations shown under the result of the first Pause and the first Save for later. */
export const HINTS = {
  pause: 'Paused tabs stay in your tab strip and use no memory. Click one to resume it.',
  save: 'Find it in Saved for later; open it from there whenever you want it back.',
} as const;
export type HintKind = keyof typeof HINTS;
/**
 * The hint the first time `kind` is used on this profile, then undefined. Remembered in localStorage (all
 * extension pages share it); if storage is unavailable no hint is shown, rather than one every time.
 */
export function hintOnce(kind: HintKind): string | undefined {
  try {
    const key = `hint.${kind}`;
    if (localStorage.getItem(key)) return undefined;
    localStorage.setItem(key, '1');
    return HINTS[kind];
  } catch {
    return undefined;
  }
}

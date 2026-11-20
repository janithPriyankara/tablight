// Loads the bundled offline name list (public/names/names.txt, scripts/names/build.mjs) for the pipeline's name step.
// It is a file inside the extension package: nothing leaves the device.
import { parseNames, setNameIndex, type NameIndex } from '../classify/names';

export const NAMES_PATH = 'names/names.txt';
let loaded: Promise<NameIndex | null> | undefined;
let warned = false;

/**
 * Reads and parses the name list once and installs it (setNameIndex) for pickGroup. A failed read resolves to null,
 * leaves the name step off and is not kept: the next call (the next batch) tries again.
 */
export function loadNameIndex(): Promise<NameIndex | null> {
  if (!loaded) {
    const p = read();
    loaded = p;
    void p.then((index) => {
      if (index === null && loaded === p) loaded = undefined;
    });
  }
  return loaded;
}
async function read(): Promise<NameIndex | null> {
  try {
    const res = await fetch(chrome.runtime.getURL(NAMES_PATH));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const index = parseNames(await res.text());
    setNameIndex(index);
    return index;
  } catch (e) {
    if (!warned) console.warn('Tablight: name list not loaded', e);
    warned = true;
    return null;
  }
}
/** Forgets the loaded list (tests). */
export function resetNameIndexForTests(): void {
  loaded = undefined;
  warned = false;
  setNameIndex(null);
}

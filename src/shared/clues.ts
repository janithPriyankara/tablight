import type { Item } from './types';
/** Why a tab looks suspicious: how it arrived (opener, popup, unseen) or what it is (address, title). */
export type Clue = 'opener' | 'popup' | 'unseen' | 'address' | 'title';
/** What the background learned when the tab was created. */
export interface TabContext {
  openerDomain?: string;
  popup: boolean;
}
export interface SuspiciousTab {
  item: Item;
  clues: Clue[];
}
export const CLUE_TEXT: Record<Clue, string> = {
  opener: 'Opened by another site',
  popup: 'Opened in a pop-up window',
  unseen: 'Never viewed',
  address: 'Ad-click address',
  title: 'Scam-style title',
};

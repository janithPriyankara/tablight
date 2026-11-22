export const BANNED_CODE: RegExp;
export function bannedName(match: string): string;
export const URL_LITERAL: RegExp;
export function cleanUrl(url: string): string;
export function packageOf(id: string): string | null;
export function urlScopeError(
  entry: { re: RegExp; pkgs: string[]; app?: undefined } | { re: RegExp; app: string[]; pkgs?: undefined },
  name: string,
  chunk:
    | { urls?: { app: Record<string, number>; appIn?: Record<string, string[]>; lib: Record<string, string[]> } }
    | undefined,
): string | null;
export const LOOKUP_SOURCE: string;
export const LOOKUP_IMPORTERS: string[];
export function wikidataMentions(path: string, text: string): string[];
export function importsOf(path: string, text: string): string[];
export function lookupReexports(path: string, text: string): string[];
export const LOOKUP_APIS: { name: string; url: string; re: RegExp }[];
export function lookupApiMentions(path: string, text: string): string[];
export const URL_ALLOWLIST: (
  | { re: RegExp; pkgs: string[]; app?: undefined; why: string }
  | { re: RegExp; app: string[]; pkgs?: undefined; why: string }
)[];

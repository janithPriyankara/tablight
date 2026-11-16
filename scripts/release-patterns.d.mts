export const BANNED_CODE: RegExp;
export function bannedName(match: string): string;
export const URL_LITERAL: RegExp;
export function cleanUrl(url: string): string;
export function packageOf(id: string): string | null;
export function urlScopeError(
  entry: { re: RegExp; pkgs: string[] },
  name: string,
  chunk: { urls?: { app: Record<string, number>; lib: Record<string, string[]> } } | undefined,
): string | null;

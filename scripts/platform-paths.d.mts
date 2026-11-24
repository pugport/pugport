export type OsCheck = 'windows' | 'macos' | 'linux';
export type PlatformClass = {
  name: 'windows' | 'mac' | 'posix' | 'linux' | 'platform-core' | 'docs-only' | 'shared';
  checks: OsCheck[];
  patterns: string[];
  except?: string[];
};
export type Classification = {
  classes: PlatformClass['name'][];
  checks: OsCheck[];
  files: { path: string; class: PlatformClass['name'] }[];
};
export const OS_CHECKS: OsCheck[];
export const CLASSES: PlatformClass[];
export const RESERVED: string[];
export function globToRegExp(glob: string): RegExp;
export function normalizePath(value: string): string;
export function classOf(value: string): PlatformClass['name'];
export function unquote(value: string): string;
export function parseChanges(text: string): string[];
export function classify(paths: string[]): Classification;

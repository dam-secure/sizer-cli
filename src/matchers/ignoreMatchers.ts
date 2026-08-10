import { Minimatch } from 'minimatch';

/**
 * Pure ignore-pattern primitives shared by production indexing and the public
 * sizer CLI. Keep this module narrow so the sizer can copy the matcher logic
 * without pulling in the broader git, Store, logging, diff, or indexing helpers.
 */

/** Minimatch options for gitignore-style matching */
export const MINIMATCH_OPTIONS = {
  matchBase: true, // 'filename' matches '**/filename'
  dot: true, // Match .dotfiles
  nocase: true, // Case-insensitive matching (cross-platform compatibility)
};

/**
 * Parse ignore file content into patterns.
 * Splits by newline, filters out empty lines and comments, then trims.
 */
export function parseIgnorePatterns(content: string): string[] {
  return content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    })
    .map((line) => line.trim());
}

/**
 * Normalize a gitignore-style pattern to minimatch-compatible format.
 * - Strip leading '/' (gitignore root-relative -> minimatch relative)
 * - Convert trailing '/' to '/**' (gitignore directory -> minimatch glob)
 */
export function normalizeGitignorePattern(pattern: string): string {
  let normalized = pattern;

  // Strip leading slash (gitignore root-relative syntax)
  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }

  // Convert trailing slash to /** (gitignore directory syntax)
  if (normalized.endsWith('/')) {
    normalized = normalized + '**';
  }

  return normalized;
}

/**
 * Compiled-matcher cache, keyed by normalized pattern.
 *
 * `minimatch(path, pattern, opts)` builds a fresh `Minimatch` — parsing the glob and compiling a
 * RegExp — on every call. Ignore filtering calls this once per (file, pattern) pair, so a large
 * repository recompiles the same handful of patterns millions of times: WebKit (~450k files)
 * against ~90 patterns is ~40M compiles per project, which pegged the worker's event loop for
 * hours and stalled every BullMQ lock. Compiling once per pattern makes the cost O(patterns)
 * instead of O(files x patterns).
 *
 * Cleared wholesale past the cap: patterns come from bounded sources (global ignorefile, repo
 * `.damsecure-ignore`, project fileExcludes), but a long-lived worker serving many repositories
 * would otherwise accumulate compiled matchers indefinitely.
 */
const MAX_CACHED_MATCHERS = 2000;
const matcherCache = new Map<string, Minimatch>();

/** Takes an already-normalized pattern; callers need the normalized form for the negation check. */
function getMatcher(normalizedPattern: string): Minimatch {
  const cached = matcherCache.get(normalizedPattern);
  if (cached) return cached;

  const matcher = new Minimatch(normalizedPattern, MINIMATCH_OPTIONS);
  if (matcherCache.size >= MAX_CACHED_MATCHERS) matcherCache.clear();
  matcherCache.set(normalizedPattern, matcher);
  return matcher;
}

/**
 * Check if a file path matches any of the given patterns.
 * Returns the first matching pattern, or null if no match.
 *
 * Negation patterns are unsupported and skipped — see the inline note below.
 */
export function findMatchingPattern(filePath: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const normalizedPattern = normalizeGitignorePattern(pattern);

    // minimatch reads a leading '!' as "match everything EXCEPT this" — the exact
    // inverse of gitignore re-inclusion. Passing one through would report a match
    // for nearly every path, excluding almost the whole repository from indexing.
    // Skip instead. Normalizing first catches '/!keep.ts' too, and
    // sparseCheckoutPatterns rejects the same construct (UnsupportedNegation).
    // Skipping before getMatcher also keeps unusable patterns out of the cache.
    if (normalizedPattern.startsWith('!')) continue;

    if (getMatcher(normalizedPattern).match(filePath)) {
      return pattern; // Return original pattern for logging/debugging
    }
  }
  return null;
}

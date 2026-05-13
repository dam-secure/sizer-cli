import { minimatch } from "minimatch";

/** Pure ignore-pattern primitives used by the sizer's vendored exclusions. */

/** Minimatch options for gitignore-style matching */
export const MINIMATCH_OPTIONS = {
  matchBase: true,  // 'filename' matches '**/filename'
  dot: true,        // Match .dotfiles
  nocase: true      // Case-insensitive matching (cross-platform compatibility)
};

/**
 * Parse ignore file content into patterns.
 * Splits by newline, filters out empty lines and comments, then trims.
 */
export function parseIgnorePatterns(content: string): string[] {
  return content
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    })
    .map(line => line.trim());
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
 * Check if a file path matches any of the given patterns.
 * Returns the first matching pattern, or null if no match.
 */
export function findMatchingPattern(filePath: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const normalizedPattern = normalizeGitignorePattern(pattern);
    if (minimatch(filePath, normalizedPattern, MINIMATCH_OPTIONS)) {
      return pattern;  // Return original pattern for logging/debugging
    }
  }
  return null;
}

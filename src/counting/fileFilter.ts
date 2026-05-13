/**
 * File filter — applies BOTH sources of ignore patterns required by the plan:
 *
 *   1. **Global** patterns from the bundled ignorefile.txt (production parity),
 *      embedded into the binary at build time. See `scripts/embed-ignorefile.mjs`.
 *   2. **Per-repo** patterns from `.damsecure-ignore` at HEAD of each repo,
 *      passed in by the caller (or `null` for "no per-repo patterns").
 *
 * Matching primitives are vendored in `src/matchers` so the CLI can be built
 * and published independently without pulling in private monorepo utilities.
 */

import {
  parseIgnorePatterns,
  findMatchingPattern,
} from '../matchers/index.js';
import { GLOBAL_IGNORE_FILE_CONTENT } from '../generated/ignoreFileContent.js';

/**
 * Parsed once at module init — the embedded global content does not change
 * across the lifetime of the process.
 */
const GLOBAL_PATTERNS: readonly string[] = Object.freeze(
  parseIgnorePatterns(GLOBAL_IGNORE_FILE_CONTENT)
);

export interface FilterResult {
  /** Files that survive both filters (lexicographically as-given). */
  kept: string[];
  /** Count of files matched by the global ignorefile.txt patterns. */
  excludedGlobal: number;
  /**
   * Count of files matched ONLY by the per-repo `.damsecure-ignore`
   * (i.e., not already excluded by the global set). Preserves the
   * semantic that `excluded_global + excluded_repo + counted = total`.
   */
  excludedRepo: number;
}

/**
 * Return the global pattern list (defensive copy). Useful for diagnostic
 * printers (e.g., a future `--explain` flag that shows which patterns matched).
 */
export function getGlobalPatterns(): readonly string[] {
  return GLOBAL_PATTERNS;
}

/**
 * Apply both global and per-repo ignore filters to a list of paths.
 *
 * @param files            POSIX-style relative paths from `git ls-tree -r HEAD --name-only`.
 * @param damsecureIgnore  Verbatim contents of the repo's `.damsecure-ignore`
 *                         (typically the result of `git show HEAD:.damsecure-ignore`),
 *                         or `null` when the file does not exist at the analysed
 *                         commit (the common case — not an error).
 */
export function filterFiles(
  files: readonly string[],
  damsecureIgnore: string | null
): FilterResult {
  const repoPatterns = damsecureIgnore
    ? parseIgnorePatterns(damsecureIgnore)
    : [];

  const result: FilterResult = {
    kept: [],
    excludedGlobal: 0,
    excludedRepo: 0,
  };

  for (const file of files) {
    if (findMatchingPattern(file, GLOBAL_PATTERNS as string[]) !== null) {
      result.excludedGlobal++;
      continue;
    }
    if (
      repoPatterns.length > 0 &&
      findMatchingPattern(file, repoPatterns) !== null
    ) {
      result.excludedRepo++;
      continue;
    }
    result.kept.push(file);
  }

  return result;
}

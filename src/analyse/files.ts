/**
 * File-count analysis for a partially-cloned repo.
 *
 * Inputs are kept narrow on purpose — a `SimpleGit` handle bound to the clone
 * directory is enough. We never read working-tree files (the clone uses
 * `--no-checkout`); everything goes through `git ls-tree` and `git show`.
 *
 * Returns the four columns the sized CSV needs:
 *   - total_files          — count from git ls-tree
 *   - excluded_global      — matched the bundled ignorefile.txt
 *   - excluded_repo        — matched .damsecure-ignore (and not already global)
 *   - counted_files        — kept after both filters
 *   - has_damsecure_ignore — was the file present at HEAD?
 *   - damsecure_ignore_lines — non-comment, non-blank pattern count
 *   - truncated            — best-effort flag (always false for git ls-tree;
 *                             the API path was the only one that truncated)
 */

import type { SimpleGit } from 'simple-git';
import { filterFiles, type FilterResult } from '../counting/fileFilter.js';
import { parseIgnorePatterns } from '../matchers/index.js';

export interface AnalyseFilesResult {
  totalFiles: number;
  excludedGlobal: number;
  excludedRepo: number;
  countedFiles: number;
  truncated: boolean;
  hasDamsecureIgnore: boolean;
  damsecureIgnoreLines: number;
}

export interface AnalyseFilesOptions {
  /**
   * Override the ref to analyse. Defaults to `HEAD`. Tests can pass a fixed
   * commit SHA for determinism.
   */
  ref?: string;
}

/**
 * Run `git ls-tree -r <ref> --name-only` and apply both global and per-repo
 * ignore filters.
 */
export async function analyseFiles(
  git: SimpleGit,
  options: AnalyseFilesOptions = {}
): Promise<AnalyseFilesResult> {
  const ref = options.ref ?? 'HEAD';

  const commitSha = (await git.revparse([ref])).trim();

  const lsTreeRaw = await git.raw(['ls-tree', '-r', '--name-only', commitSha]);
  const allFiles = lsTreeRaw.split('\n').map((s) => s.trim()).filter(Boolean);

  const damsecureIgnoreContent = await readDamsecureIgnore(git, commitSha);

  const filterResult: FilterResult = filterFiles(allFiles, damsecureIgnoreContent);

  const damsecureIgnoreLines = damsecureIgnoreContent
    ? parseIgnorePatterns(damsecureIgnoreContent).length
    : 0;

  return {
    totalFiles: allFiles.length,
    excludedGlobal: filterResult.excludedGlobal,
    excludedRepo: filterResult.excludedRepo,
    countedFiles: filterResult.kept.length,
    truncated: false,
    hasDamsecureIgnore: damsecureIgnoreContent !== null,
    damsecureIgnoreLines,
  };
}

/**
 * Try to read `.damsecure-ignore` at the given commit. Missing file is the
 * COMMON case (most repos don't have one) — we return `null` instead of
 * throwing.
 */
async function readDamsecureIgnore(
  git: SimpleGit,
  commitSha: string
): Promise<string | null> {
  try {
    const out = await git.raw([
      'show',
      `${commitSha}:.damsecure-ignore`,
    ]);
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // git's "not found" path: "exists on disk, but not in <commit>" /
    // "fatal: path '.damsecure-ignore' does not exist in '<sha>'" /
    // "fatal: invalid object name". All harmless — repo simply has none.
    if (
      /does not exist in/.test(msg) ||
      /exists on disk/.test(msg) ||
      /invalid object name/.test(msg) ||
      /unknown revision or path/.test(msg) ||
      /not in the working tree/.test(msg) ||
      /Path '\.damsecure-ignore'/i.test(msg)
    ) {
      return null;
    }
    throw err;
  }
}

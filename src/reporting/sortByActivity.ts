/**
 * Default sort order shared by table / CSV / JSON output:
 *
 *   1. Errored rows go to the bottom (visible but out of the way).
 *   2. Among non-errored rows, sort by `prs_last_4w` desc (primary sizing model).
 *   3. Tiebreak by `commits_last_4w` desc.
 *   4. Tiebreak by `prs_last_12m` then `commits_last_52w` desc.
 *   5. Tiebreak by `last_pr_at` desc.
 *   6. Final tiebreak alphabetical for determinism.
 *
 * Unavailable activity/PR rows are treated as 0 for that signal so they
 * sink below repos with real activity but stay above hard errors.
 *
 * Lifted to its own module so both `csv.ts` and `table.ts` can apply the
 * exact same ordering without a circular import.
 */

import type { RepoSizedRow } from './csv.js';

export function sortByActivity(rows: readonly RepoSizedRow[]): RepoSizedRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const aErr = a.error.length > 0 ? 1 : 0;
    const bErr = b.error.length > 0 ? 1 : 0;
    if (aErr !== bErr) return aErr - bErr;

    const aPr4 = prActivityFor(a, 'prs_last_4w');
    const bPr4 = prActivityFor(b, 'prs_last_4w');
    if (aPr4 !== bPr4) return bPr4 - aPr4;

    const a4 = commitActivityFor(a, 'commits_last_4w');
    const b4 = commitActivityFor(b, 'commits_last_4w');
    if (a4 !== b4) return b4 - a4;

    const aPr12 = prActivityFor(a, 'prs_last_12m');
    const bPr12 = prActivityFor(b, 'prs_last_12m');
    if (aPr12 !== bPr12) return bPr12 - aPr12;

    const a52 = commitActivityFor(a, 'commits_last_52w');
    const b52 = commitActivityFor(b, 'commits_last_52w');
    if (a52 !== b52) return b52 - a52;

    const aPr = a.last_pr_at;
    const bPr = b.last_pr_at;
    if (aPr !== bPr) return bPr.localeCompare(aPr);

    return a.full_name.localeCompare(b.full_name);
  });
  return copy;
}

function prActivityFor(
  row: RepoSizedRow,
  key: 'prs_last_4w' | 'prs_last_12m'
): number {
  const v = row[key];
  return v < 0 ? 0 : v;
}

function commitActivityFor(
  row: RepoSizedRow,
  key: 'commits_last_4w' | 'commits_last_52w'
): number {
  if (row.activity_unavailable) return 0;
  const v = row[key];
  return v < 0 ? 0 : v;
}

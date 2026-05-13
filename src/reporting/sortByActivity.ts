/**
 * Default sort order shared by table / CSV / JSON output:
 *
 *   1. Errored rows go to the bottom (visible but out of the way).
 *   2. Among non-errored rows, sort by `commits_last_4w` desc (the most
 *      common "is this repo alive right now" signal).
 *   3. Tiebreak by `commits_last_52w` desc (dead-but-recently-active wins
 *      over totally-dead).
 *   4. Tiebreak by `pushed_at` desc (so the timestamp wins when both
 *      windows show 0).
 *   5. Final tiebreak alphabetical for determinism.
 *
 * `activity_unavailable` rows are treated as having activity 0 so they
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

    const a4 = activityFor(a, 'commits_last_4w');
    const b4 = activityFor(b, 'commits_last_4w');
    if (a4 !== b4) return b4 - a4;

    const a52 = activityFor(a, 'commits_last_52w');
    const b52 = activityFor(b, 'commits_last_52w');
    if (a52 !== b52) return b52 - a52;

    const aPush = a.pushed_at;
    const bPush = b.pushed_at;
    if (aPush !== bPush) return bPush.localeCompare(aPush);

    return a.full_name.localeCompare(b.full_name);
  });
  return copy;
}

function activityFor(
  row: RepoSizedRow,
  key: 'commits_last_4w' | 'commits_last_52w'
): number {
  if (row.activity_unavailable) return 0;
  const v = row[key];
  return v < 0 ? 0 : v;
}

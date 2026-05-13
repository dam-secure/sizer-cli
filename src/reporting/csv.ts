/**
 * CSV schemas + writers for list inspection and sizing output.
 *
 * Two distinct shapes:
 *  - `RepoListRow`  — output of `--list-only`; useful for inspection.
 *    Customer-facing columns are `included` (default sizing decision) and
 *    `note` (free-form).
 *  - `RepoSizedRow` — output of `size`. Identity columns + sizing +
 *    activity. NEVER contains tier / credits / pricing columns; that's
 *    a deliberate v1 boundary.
 *
 */

import Papa from 'papaparse';
import { sortByActivity } from './sortByActivity.js';

// ---------------------------------------------------------------------------
// List CSV
// ---------------------------------------------------------------------------

export interface RepoListRow {
  full_name: string;
  default_branch: string;
  size_kb: number;
  pushed_at: string;
  is_archived: boolean;
  is_fork: boolean;
  is_empty: boolean;
  /** Customer-editable. Default per decision D-B (see plan). */
  included: boolean;
  /** Customer-editable free-form annotation; preserved into sized CSV. */
  note: string;
}

const LIST_COLUMNS: ReadonlyArray<keyof RepoListRow> = Object.freeze([
  'full_name',
  'default_branch',
  'size_kb',
  'pushed_at',
  'is_archived',
  'is_fork',
  'is_empty',
  'included',
  'note',
]);

export function writeListCsv(rows: readonly RepoListRow[]): string {
  return Papa.unparse(
    {
      fields: [...LIST_COLUMNS],
      data: rows.map((r) => [
        r.full_name,
        r.default_branch,
        r.size_kb,
        r.pushed_at,
        r.is_archived,
        r.is_fork,
        r.is_empty,
        r.included,
        r.note,
      ]),
    },
    { newline: '\n' }
  );
}

// ---------------------------------------------------------------------------
// Sized CSV
// ---------------------------------------------------------------------------

/**
 * Sized CSV row schema. **No tier, no credits, no pricing.** That's a
 * deliberate v1 boundary — sales applies pricing math on its side.
 */
export interface RepoSizedRow {
  // identity (copied from RepoListRow)
  full_name: string;
  default_branch: string;
  size_kb: number;
  pushed_at: string;
  note: string;

  // sizing
  commit_sha: string;
  total_files: number;
  excluded_global: number;
  excluded_repo: number;
  counted_files: number;
  truncated: boolean;
  has_damsecure_ignore: boolean;
  damsecure_ignore_lines: number;

  // activity (-1 if --no-activity or unavailable)
  last_commit_at: string;
  commits_last_4w: number;
  commits_last_13w: number;
  commits_last_52w: number;
  committers_last_4w: number;
  committers_last_13w: number;
  committers_last_52w: number;
  /** "alice:42;bob:17;..." (top 5). */
  top_contributors: string;
  activity_unavailable: boolean;

  // diagnostics
  /** Empty unless something went wrong (network error, partial clone failure, ...). */
  error: string;
}

export const SIZED_COLUMNS: ReadonlyArray<keyof RepoSizedRow> = Object.freeze([
  'full_name',
  'default_branch',
  'size_kb',
  'pushed_at',
  'note',
  'commit_sha',
  'total_files',
  'excluded_global',
  'excluded_repo',
  'counted_files',
  'truncated',
  'has_damsecure_ignore',
  'damsecure_ignore_lines',
  'last_commit_at',
  'commits_last_4w',
  'commits_last_13w',
  'commits_last_52w',
  'committers_last_4w',
  'committers_last_13w',
  'committers_last_52w',
  'top_contributors',
  'activity_unavailable',
  'error',
]);

export function writeSizedCsv(rows: readonly RepoSizedRow[]): string {
  const sorted = sortByActivity(rows);
  return Papa.unparse(
    {
      fields: [...SIZED_COLUMNS],
      data: sorted.map((r) =>
        SIZED_COLUMNS.map((c) => {
          const v = r[c];
          if (typeof v === 'boolean') return v ? 'true' : 'false';
          return v;
        })
      ),
    },
    { newline: '\n' }
  );
}

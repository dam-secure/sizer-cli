/**
 * CSV schemas + I/O for `list` and `size`.
 *
 * Two distinct shapes:
 *  - `RepoListRow`  — output of `list`, edited by the customer in
 *    Excel/Sheets, consumed by `size --from`. Customer-editable columns
 *    are `included` (bool) and `note` (free-form).
 *  - `RepoSizedRow` — output of `size`. Identity columns + sizing +
 *    activity. NEVER contains tier / credits / pricing columns; that's
 *    a deliberate v1 boundary.
 *
 * Validation rules for `readListCsv` (locked in plan):
 *   - all required columns must be present
 *   - `included` accepts Excel-friendly literals: true/false/1/0/yes/no
 *   - `full_name` must match `owner/repo`
 *   - malformed rows are reported by name, not by index
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

const FULL_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export class ListCsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListCsvParseError';
  }
}

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

export function readListCsv(content: string): RepoListRow[] {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new ListCsvParseError(
      `CSV parse error at row ${first.row ?? '?'}: ${first.message}`
    );
  }

  const headers = (parsed.meta.fields ?? []).map((f) => f.trim());
  const missing = LIST_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    throw new ListCsvParseError(
      `List CSV is missing required column(s): ${missing.join(', ')}. Expected: ${LIST_COLUMNS.join(', ')}.`
    );
  }

  const rows: RepoListRow[] = [];
  for (const raw of parsed.data) {
    const fullName = (raw['full_name'] ?? '').trim();
    if (!fullName) {
      // Tolerate fully-blank rows that Excel sometimes leaves at the bottom.
      continue;
    }
    if (!FULL_NAME_RE.test(fullName)) {
      throw new ListCsvParseError(
        `Row "${fullName}": full_name must match "owner/repo" (got "${fullName}").`
      );
    }

    rows.push({
      full_name: fullName,
      default_branch: (raw['default_branch'] ?? '').trim(),
      size_kb: parseIntegerColumn(raw['size_kb'], 'size_kb', fullName),
      pushed_at: (raw['pushed_at'] ?? '').trim(),
      is_archived: parseBoolColumn(raw['is_archived'], 'is_archived', fullName),
      is_fork: parseBoolColumn(raw['is_fork'], 'is_fork', fullName),
      is_empty: parseBoolColumn(raw['is_empty'], 'is_empty', fullName),
      included: parseBoolColumn(raw['included'], 'included', fullName),
      note: raw['note'] ?? '',
    });
  }
  return rows;
}

function parseBoolColumn(
  raw: string | undefined,
  column: string,
  rowName: string
): boolean {
  const normalised = (raw ?? '').trim().toLowerCase();
  if (
    normalised === 'true' ||
    normalised === '1' ||
    normalised === 'yes' ||
    normalised === 'y' ||
    normalised === 't'
  ) {
    return true;
  }
  if (
    normalised === 'false' ||
    normalised === '0' ||
    normalised === 'no' ||
    normalised === 'n' ||
    normalised === 'f' ||
    normalised === ''
  ) {
    return false;
  }
  throw new ListCsvParseError(
    `Row "${rowName}", column "${column}": expected a true/false value (accepts true/false/1/0/yes/no), got "${raw}".`
  );
}

function parseIntegerColumn(
  raw: string | undefined,
  column: string,
  rowName: string
): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ListCsvParseError(
      `Row "${rowName}", column "${column}": expected an integer, got "${raw}".`
    );
  }
  return n;
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

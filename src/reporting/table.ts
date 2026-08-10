/**
 * Pretty-printed terminal table for sized rows.
 *
 * Columns and order match {@link SIZED_COLUMNS} / the sized CSV exactly so
 * table and CSV are the same fact sheet. Ordering matches CSV via
 * `sortByActivity`.
 */

import { SIZED_COLUMNS, type RepoSizedRow } from './csv.js';
import { sortByActivity } from './sortByActivity.js';

export interface TableRenderOptions {
  /** Force colour off (e.g., when not writing to a TTY). */
  noColor?: boolean;
}

const RIGHT_ALIGN = new Set<keyof RepoSizedRow>([
  'size_kb',
  'prs_last_1w',
  'prs_last_4w',
  'prs_last_3m',
  'prs_last_12m',
  'prs_last_24m',
  'pr_authors_last_1w',
  'pr_authors_last_4w',
  'pr_authors_last_3m',
  'pr_authors_last_12m',
  'pr_authors_last_24m',
  'total_files',
  'excluded_global',
  'excluded_repo',
  'counted_files',
  'damsecure_ignore_lines',
  'commits_last_4w',
  'commits_last_13w',
  'commits_last_52w',
  'committers_last_4w',
  'committers_last_13w',
  'committers_last_52w',
]);

export function renderSizedTable(
  rows: readonly RepoSizedRow[],
  _options: TableRenderOptions = {}
): string {
  if (rows.length === 0) {
    return 'No repositories were sized. (Did all rows have included=false?)\n';
  }

  const sorted = sortByActivity(rows);

  const cols = SIZED_COLUMNS.map((key) => ({
    name: key,
    align: (RIGHT_ALIGN.has(key) ? 'right' : 'left') as 'left' | 'right',
    pick: (r: RepoSizedRow) => formatCell(key, r),
  }));

  const widths = cols.map((c) =>
    Math.max(c.name.length, ...sorted.map((r) => c.pick(r).length))
  );

  const renderRow = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i], cols[i].align)).join('  ');

  const headerLine = renderRow(cols.map((c) => c.name));
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  const dataLines = sorted.map((r) => renderRow(cols.map((c) => c.pick(r))));

  const totalsCells = SIZED_COLUMNS.map((key) => {
    if (key === 'full_name') return 'TOTAL';
    if (key === 'prs_last_24m') {
      return fmtNum(
        sorted.reduce((s, r) => s + (r.prs_last_24m < 0 ? 0 : r.prs_last_24m), 0)
      );
    }
    if (key === 'total_files') {
      return fmtNum(sorted.reduce((s, r) => s + Math.max(0, r.total_files), 0));
    }
    if (key === 'excluded_global') {
      return fmtNum(sorted.reduce((s, r) => s + Math.max(0, r.excluded_global), 0));
    }
    if (key === 'excluded_repo') {
      return fmtNum(sorted.reduce((s, r) => s + Math.max(0, r.excluded_repo), 0));
    }
    if (key === 'counted_files') {
      return fmtNum(sorted.reduce((s, r) => s + Math.max(0, r.counted_files), 0));
    }
    return '—';
  });
  const totalsLine = renderRow(totalsCells);

  return [headerLine, separator, ...dataLines, separator, totalsLine].join('\n') + '\n';
}

function formatCell(key: keyof RepoSizedRow, row: RepoSizedRow): string {
  const value = row[key];
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (
      row.activity_unavailable &&
      (key.startsWith('commits_') || key.startsWith('committers_'))
    ) {
      return '—';
    }
    return fmtNum(value);
  }
  if (key === 'last_pr_at' || key === 'last_commit_at') {
    return isoDate(value);
  }
  return value === '' ? '—' : value;
}

function pad(s: string, width: number, align: 'left' | 'right'): string {
  if (s.length >= width) return s;
  const fill = ' '.repeat(width - s.length);
  return align === 'left' ? s + fill : fill + s;
}

function fmtNum(n: number): string {
  if (n < 0) return '—';
  return n.toLocaleString('en-US');
}

function isoDate(iso: string): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

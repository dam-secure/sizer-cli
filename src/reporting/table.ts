/**
 * Pretty-printed terminal table for sized rows.
 *
 * The CSV is the deliverable; the table is for the customer to sanity-check
 * the report before sharing. Keep columns wide enough for typical org-scale
 * numbers but narrow enough to fit ~120 columns.
 *
 * Default ordering (see `sortByActivity` below): most-recently-active repos
 * at the top, dead repos at the bottom, errored rows last. Same ordering is
 * applied to CSV / JSON output so all three formats agree.
 */

import type { RepoSizedRow } from './csv.js';
import { sortByActivity } from './sortByActivity.js';

export interface TableRenderOptions {
  /** Force colour off (e.g., when not writing to a TTY). */
  noColor?: boolean;
}

export function renderSizedTable(
  rows: readonly RepoSizedRow[],
  _options: TableRenderOptions = {}
): string {
  if (rows.length === 0) {
    return 'No repositories were sized. (Did all rows have included=false?)\n';
  }

  const sorted = sortByActivity(rows);

  const cols: Array<{
    name: string;
    align: 'left' | 'right';
    pick: (r: RepoSizedRow) => string;
  }> = [
    { name: 'REPO', align: 'left', pick: (r) => r.full_name },
    { name: 'FILES', align: 'right', pick: (r) => fmtNum(r.total_files) },
    { name: 'EXCL_GLOBAL', align: 'right', pick: (r) => fmtNum(r.excluded_global) },
    { name: 'EXCL_REPO', align: 'right', pick: (r) => fmtNum(r.excluded_repo) },
    { name: 'COUNTED', align: 'right', pick: (r) => fmtNum(r.counted_files) },
    { name: 'COMMITS_4W', align: 'right', pick: (r) => fmtMaybeMissing(r.commits_last_4w, r.activity_unavailable) },
    { name: 'COMMITS_13W', align: 'right', pick: (r) => fmtMaybeMissing(r.commits_last_13w, r.activity_unavailable) },
    { name: 'COMMITS_52W', align: 'right', pick: (r) => fmtMaybeMissing(r.commits_last_52w, r.activity_unavailable) },
    { name: 'COMMITTERS_4W', align: 'right', pick: (r) => fmtMaybeMissing(r.committers_last_4w, r.activity_unavailable) },
    { name: 'COMMITTERS_13W', align: 'right', pick: (r) => fmtMaybeMissing(r.committers_last_13w, r.activity_unavailable) },
    { name: 'COMMITTERS_52W', align: 'right', pick: (r) => fmtMaybeMissing(r.committers_last_52w, r.activity_unavailable) },
    { name: 'PUSHED', align: 'left', pick: (r) => isoDate(r.pushed_at) },
  ];

  // Compute widths against the sorted rows so the column widths fit the
  // values that will actually be displayed.
  const widths = cols.map((c) =>
    Math.max(c.name.length, ...sorted.map((r) => c.pick(r).length))
  );

  const renderRow = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i], cols[i].align)).join('  ');

  const headerLine = renderRow(cols.map((c) => c.name));
  const separator = widths
    .map((w) => '-'.repeat(w))
    .join('  ');
  const dataLines = sorted.map((r) =>
    renderRow(cols.map((c) => c.pick(r)))
  );

  // Totals row (only over rows whose values are available, to avoid mixing -1).
  const totalCounted = sorted.reduce((s, r) => s + Math.max(0, r.counted_files), 0);
  const totalGlobal = sorted.reduce((s, r) => s + Math.max(0, r.excluded_global), 0);
  const totalRepo = sorted.reduce((s, r) => s + Math.max(0, r.excluded_repo), 0);
  const totalFiles = sorted.reduce((s, r) => s + Math.max(0, r.total_files), 0);

  const totalsLine = renderRow([
    'TOTAL',
    fmtNum(totalFiles),
    fmtNum(totalGlobal),
    fmtNum(totalRepo),
    fmtNum(totalCounted),
    '—',
    '—',
    '—',
    '—',
    '—',
    '—',
    '—',
  ]);

  const note = [
    '',
    'Note: counted_files is the worst case before AI per-project exclusions',
    '(typically 30-60% additional reduction in production).',
    '',
  ].join('\n');

  return (
    [headerLine, separator, ...dataLines, separator, totalsLine].join('\n') + '\n' + note
  );
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

function fmtMaybeMissing(n: number, unavailable: boolean): string {
  if (unavailable || n < 0) return '—';
  return fmtNum(n);
}

function isoDate(iso: string): string {
  if (!iso) return '—';
  // Show only the date portion (YYYY-MM-DD) — the full timestamp is in the CSV.
  return iso.slice(0, 10);
}

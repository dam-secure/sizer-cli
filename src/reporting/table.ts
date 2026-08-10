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
    { name: 'PRS_1W', align: 'right', pick: (r) => fmtNum(r.prs_last_1w) },
    { name: 'PRS_4W', align: 'right', pick: (r) => fmtNum(r.prs_last_4w) },
    { name: 'PRS_3M', align: 'right', pick: (r) => fmtNum(r.prs_last_3m) },
    { name: 'PRS_12M', align: 'right', pick: (r) => fmtNum(r.prs_last_12m) },
    { name: 'PRS_24M', align: 'right', pick: (r) => fmtNum(r.prs_last_24m) },
    { name: 'AUTHORS_4W', align: 'right', pick: (r) => fmtNum(r.pr_authors_last_4w) },
    { name: 'COUNTED', align: 'right', pick: (r) => fmtNum(r.counted_files) },
    {
      name: 'COMMITTERS_4W',
      align: 'right',
      pick: (r) => fmtMaybeMissing(r.committers_last_4w, r.activity_unavailable),
    },
    { name: 'LAST_PR', align: 'left', pick: (r) => isoDate(r.last_pr_at) },
  ];

  const widths = cols.map((c) =>
    Math.max(c.name.length, ...sorted.map((r) => c.pick(r).length))
  );

  const renderRow = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i], cols[i].align)).join('  ');

  const headerLine = renderRow(cols.map((c) => c.name));
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  const dataLines = sorted.map((r) => renderRow(cols.map((c) => c.pick(r))));

  const totalPrs24 = sorted.reduce(
    (s, r) => s + (r.prs_last_24m < 0 ? 0 : r.prs_last_24m),
    0
  );
  const totalCounted = sorted.reduce((s, r) => s + Math.max(0, r.counted_files), 0);

  const totalsLine = renderRow([
    'TOTAL',
    '—',
    '—',
    '—',
    '—',
    fmtNum(totalPrs24),
    '—',
    fmtNum(totalCounted),
    '—',
    '—',
  ]);

  const note = [
    '',
    'Note: PR windows are cumulative (created in the last 1w / 4w / 3m / 12m / 24m).',
    'Month windows use 30-day months (90 / 365 / 730 days).',
    'counted_files is the worst-case file count before AI per-project exclusions.',
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
  return iso.slice(0, 10);
}

/**
 * CSV reporter tests.
 *
 *  - List CSV writer: stable column order for `--list-only`.
 *  - Sized CSV writer: stable column order, NO tier/credits/pricing columns
 *    anywhere.
 */

import { describe, expect, it } from 'vitest';
import {
  writeListCsv,
  writeSizedCsv,
  SIZED_COLUMNS,
  type RepoListRow,
  type RepoSizedRow,
} from '../reporting/csv.js';
import { renderSizedTable } from '../reporting/table.js';

function makeListRow(overrides: Partial<RepoListRow> = {}): RepoListRow {
  return {
    full_name: 'acme/api',
    default_branch: 'main',
    size_kb: 1234,
    pushed_at: '2026-05-10T12:34:56Z',
    is_archived: false,
    is_fork: false,
    is_empty: false,
    included: true,
    note: '',
    ...overrides,
  };
}

function makeSizedRow(overrides: Partial<RepoSizedRow> = {}): RepoSizedRow {
  return {
    full_name: 'acme/api',
    default_branch: 'main',
    size_kb: 1234,
    pushed_at: '2026-05-10T12:34:56Z',
    note: '',
    commit_sha: '0'.repeat(40),
    total_files: 100,
    excluded_global: 30,
    excluded_repo: 10,
    counted_files: 60,
    truncated: false,
    has_damsecure_ignore: true,
    damsecure_ignore_lines: 5,
    last_commit_at: '2026-05-10T12:34:56Z',
    commits_last_4w: 12,
    commits_last_13w: 40,
    commits_last_52w: 130,
    committers_last_4w: 3,
    committers_last_13w: 6,
    committers_last_52w: 12,
    top_contributors: 'alice:42;bob:17',
    activity_unavailable: false,
    error: '',
    ...overrides,
  };
}

describe('writeListCsv', () => {
  it('emits the list column order and rows', () => {
    const rows: RepoListRow[] = [
      makeListRow({ full_name: 'acme/api' }),
      makeListRow({ full_name: 'acme/web', size_kb: 5678 }),
      makeListRow({
        full_name: 'acme/old',
        is_archived: true,
        included: false,
      }),
    ];

    const csv = writeListCsv(rows);
    expect(csv.split('\n')[0]).toBe(
      'full_name,default_branch,size_kb,pushed_at,is_archived,is_fork,is_empty,included,note'
    );
    expect(csv).toContain('acme/api');
    expect(csv).toContain('acme/old');
  });
});

describe('writeSizedCsv', () => {
  it('emits the documented column order', () => {
    const csv = writeSizedCsv([makeSizedRow()]);
    const headerLine = csv.split('\n')[0];
    expect(headerLine).toBe(SIZED_COLUMNS.join(','));
  });

  it('does NOT contain any tier / credits / pricing column', () => {
    const csv = writeSizedCsv([makeSizedRow()]);
    expect(csv).not.toMatch(/\btier\b/i);
    expect(csv).not.toMatch(/\bcredits?\b/i);
    expect(csv).not.toMatch(/\bprice\b/i);
    expect(csv).not.toMatch(/\bcost\b/i);
  });

  it('serialises booleans as "true"/"false"', () => {
    const csv = writeSizedCsv([makeSizedRow({ truncated: true, has_damsecure_ignore: false })]);
    const dataLine = csv.split('\n')[1];
    // truncated is index 10, has_damsecure_ignore is index 11
    const cells = dataLine.split(',');
    expect(cells[SIZED_COLUMNS.indexOf('truncated')]).toBe('true');
    expect(cells[SIZED_COLUMNS.indexOf('has_damsecure_ignore')]).toBe('false');
  });
});

describe('renderSizedTable', () => {
  it('renders a header, the data row, and a worst-case footnote', () => {
    const out = renderSizedTable([
      makeSizedRow({ full_name: 'acme/api' }),
      makeSizedRow({ full_name: 'acme/web', total_files: 9012, counted_files: 5811 }),
    ]);
    expect(out).toMatch(/REPO\s+FILES/);
    expect(out).toContain('acme/api');
    expect(out).toContain('acme/web');
    expect(out).toContain('TOTAL');
    expect(out).toContain('worst case');
  });

  it('handles an empty input gracefully', () => {
    const out = renderSizedTable([]);
    expect(out).toMatch(/No repositories/);
  });

  it('renders "—" for unavailable activity instead of -1', () => {
    const out = renderSizedTable([
      makeSizedRow({
        activity_unavailable: true,
        commits_last_4w: -1,
        committers_last_4w: -1,
        pushed_at: '2026-05-10T12:00:00Z',
      }),
    ]);
    expect(out).toContain('—');
    // We test for a NUMERIC -1 (whitespace-bordered) rather than `-1` as a
    // substring, because dates like `2026-05-10` contain `5-1`.
    expect(out).not.toMatch(/(^|\s)-1(\s|$)/);
  });
});


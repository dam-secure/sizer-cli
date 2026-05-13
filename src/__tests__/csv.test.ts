/**
 * CSV reporter tests.
 *
 *  - Round-trip: list CSV → simulate Excel-style edit → re-parse, decisions
 *    survive.
 *  - Schema validation: missing columns, malformed full_name, malformed
 *    boolean literals.
 *  - Excel-friendly bool literals (true/false/1/0/yes/no).
 *  - Sized CSV writer: stable column order, NO tier/credits/pricing columns
 *    anywhere.
 */

import { describe, expect, it } from 'vitest';
import {
  ListCsvParseError,
  readListCsv,
  writeListCsv,
  writeSizedCsv,
  SIZED_COLUMNS,
  type RepoListRow,
  type RepoSizedRow,
} from '../reporting/csv.js';
import { renderSizedTable } from '../reporting/table.js';
import { renderSizedJson } from '../reporting/json.js';

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

describe('writeListCsv / readListCsv round-trip', () => {
  it('round-trips an unmodified list CSV', () => {
    const before: RepoListRow[] = [
      makeListRow({ full_name: 'acme/api' }),
      makeListRow({ full_name: 'acme/web', size_kb: 5678 }),
      makeListRow({
        full_name: 'acme/old',
        is_archived: true,
        included: false,
      }),
    ];
    const csv = writeListCsv(before);
    const after = readListCsv(csv);
    expect(after).toEqual(before);
  });

  it('preserves customer edits to `included` (Excel-style flip to false)', () => {
    const initial = [
      makeListRow({ full_name: 'acme/keep1' }),
      makeListRow({ full_name: 'acme/keep2' }),
      makeListRow({ full_name: 'acme/dropme' }),
    ];
    const csv = writeListCsv(initial);
    // Simulate Excel edit: flip `included` to false on the third row.
    // (The `included` column is followed by a trailing `,note` so the row
    // ends in `,true,`; match that and replace.)
    const edited = csv.replace(/^acme\/dropme,(.*),true,(.*)$/m, 'acme/dropme,$1,false,$2');
    expect(edited).not.toBe(csv); // sanity: edit applied
    const parsed = readListCsv(edited);
    expect(parsed.find((r) => r.full_name === 'acme/dropme')?.included).toBe(false);
    expect(
      parsed.filter((r) => r.included).map((r) => r.full_name)
    ).toEqual(['acme/keep1', 'acme/keep2']);
  });

  it('preserves customer edits to `note`', () => {
    const initial = [makeListRow({ full_name: 'acme/api', note: '' })];
    const csv = writeListCsv(initial);
    // Replace the trailing empty note (after the last `,`) with text.
    const edited = csv.replace(/^acme\/api,(.*),$/m, 'acme/api,$1,decommissioning soon');
    expect(edited).not.toBe(csv);
    const parsed = readListCsv(edited);
    expect(parsed[0].note).toBe('decommissioning soon');
  });
});

describe('readListCsv — Excel-friendly booleans', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['TRUE', true],
    ['False', false],
    ['1', true],
    ['0', false],
    ['yes', true],
    ['no', false],
    ['Y', true],
    ['n', false],
    ['', false],
  ] as Array<[string, boolean]>)(
    'parses included="%s" as %s',
    (input, expected) => {
      const csv = [
        'full_name,default_branch,size_kb,pushed_at,is_archived,is_fork,is_empty,included,note',
        `acme/api,main,1,2026-01-01T00:00:00Z,false,false,false,${input},`,
      ].join('\n');
      expect(readListCsv(csv)[0].included).toBe(expected);
    }
  );

  it('rejects unrecognised boolean literals with a row-named error', () => {
    const csv = [
      'full_name,default_branch,size_kb,pushed_at,is_archived,is_fork,is_empty,included,note',
      'acme/api,main,1,2026-01-01T00:00:00Z,false,false,false,sortof,',
    ].join('\n');
    expect(() => readListCsv(csv)).toThrow(ListCsvParseError);
    expect(() => readListCsv(csv)).toThrow(/acme\/api.*sortof/s);
  });
});

describe('readListCsv — schema validation', () => {
  it('rejects a CSV missing required columns', () => {
    const csv = ['full_name,default_branch', 'acme/api,main'].join('\n');
    expect(() => readListCsv(csv)).toThrow(/missing required column/i);
  });

  it('rejects a row whose full_name does not match owner/repo', () => {
    const csv = [
      'full_name,default_branch,size_kb,pushed_at,is_archived,is_fork,is_empty,included,note',
      'acme,main,1,2026-01-01T00:00:00Z,false,false,false,true,',
    ].join('\n');
    expect(() => readListCsv(csv)).toThrow(/acme/);
    expect(() => readListCsv(csv)).toThrow(/owner\/repo/);
  });

  it('rejects a non-integer size_kb with the row name', () => {
    const csv = [
      'full_name,default_branch,size_kb,pushed_at,is_archived,is_fork,is_empty,included,note',
      'acme/api,main,big,2026-01-01T00:00:00Z,false,false,false,true,',
    ].join('\n');
    expect(() => readListCsv(csv)).toThrow(/acme\/api/);
    expect(() => readListCsv(csv)).toThrow(/size_kb/);
  });

  it('tolerates fully-blank trailing rows that Excel sometimes inserts', () => {
    const csv = [
      'full_name,default_branch,size_kb,pushed_at,is_archived,is_fork,is_empty,included,note',
      'acme/api,main,1,2026-01-01T00:00:00Z,false,false,false,true,',
      ',,,,,,,,',
      ',,,,,,,,',
    ].join('\n');
    const result = readListCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0].full_name).toBe('acme/api');
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

describe('renderSizedJson', () => {
  it('emits a versioned report with rows and generatedAt', () => {
    const json = renderSizedJson([makeSizedRow()], {
      generatorVersion: '0.1.0',
      now: new Date('2026-05-13T12:00:00Z'),
    });
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.generatedAt).toBe('2026-05-13T12:00:00.000Z');
    expect(parsed.generator).toEqual({ name: '@damsecure/sizer', version: '0.1.0' });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].full_name).toBe('acme/api');
  });
});

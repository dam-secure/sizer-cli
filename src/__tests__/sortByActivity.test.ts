/**
 * Tests for the default sort order applied to table / CSV / JSON output.
 */

import { describe, expect, it } from 'vitest';
import { sortByActivity } from '../reporting/sortByActivity.js';
import type { RepoSizedRow } from '../reporting/csv.js';

function row(overrides: Partial<RepoSizedRow>): RepoSizedRow {
  return {
    full_name: 'acme/x',
    size_kb: 0,
    pushed_at: '2026-01-01T00:00:00Z',
    note: '',
    total_files: 10,
    excluded_global: 0,
    excluded_repo: 0,
    counted_files: 10,
    truncated: false,
    has_damsecure_ignore: false,
    damsecure_ignore_lines: 0,
    last_commit_at: '',
    commits_last_4w: 0,
    commits_last_13w: 0,
    commits_last_52w: 0,
    committers_last_4w: 0,
    committers_last_13w: 0,
    committers_last_52w: 0,
    activity_unavailable: false,
    error: '',
    ...overrides,
  };
}

describe('sortByActivity', () => {
  it('orders by commits_last_4w desc as the primary key', () => {
    const out = sortByActivity([
      row({ full_name: 'a/quiet', commits_last_4w: 0 }),
      row({ full_name: 'a/busy', commits_last_4w: 200 }),
      row({ full_name: 'a/medium', commits_last_4w: 50 }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual(['a/busy', 'a/medium', 'a/quiet']);
  });

  it('uses commits_last_52w as the secondary key when 4w is tied', () => {
    const out = sortByActivity([
      row({ full_name: 'a/old-but-active', commits_last_4w: 0, commits_last_52w: 100 }),
      row({ full_name: 'a/dead', commits_last_4w: 0, commits_last_52w: 0 }),
      row({ full_name: 'a/middling', commits_last_4w: 0, commits_last_52w: 30 }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual([
      'a/old-but-active',
      'a/middling',
      'a/dead',
    ]);
  });

  it('uses pushed_at desc as the tertiary key', () => {
    const out = sortByActivity([
      row({ full_name: 'a/older', pushed_at: '2025-01-01T00:00:00Z' }),
      row({ full_name: 'a/newer', pushed_at: '2026-05-01T00:00:00Z' }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual(['a/newer', 'a/older']);
  });

  it('falls back to alphabetical for total ties', () => {
    const out = sortByActivity([
      row({ full_name: 'a/zeta', pushed_at: '2026-01-01T00:00:00Z' }),
      row({ full_name: 'a/alpha', pushed_at: '2026-01-01T00:00:00Z' }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual(['a/alpha', 'a/zeta']);
  });

  it('sinks errored rows below all non-errored rows', () => {
    const out = sortByActivity([
      row({ full_name: 'a/error', commits_last_4w: 1000, error: 'boom' }),
      row({ full_name: 'a/quiet', commits_last_4w: 0 }),
      row({ full_name: 'a/busy', commits_last_4w: 50 }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual([
      'a/busy',
      'a/quiet',
      'a/error',
    ]);
  });

  it('treats activity_unavailable rows as activity 0 (sinks below real activity, above errors)', () => {
    const out = sortByActivity([
      row({
        full_name: 'a/unavailable',
        activity_unavailable: true,
        commits_last_4w: -1,
        commits_last_52w: -1,
      }),
      row({ full_name: 'a/dead', commits_last_4w: 0, commits_last_52w: 0 }),
      row({ full_name: 'a/error', error: 'failed' }),
      row({ full_name: 'a/busy', commits_last_4w: 5 }),
    ]);
    // Tie between 'dead' and 'unavailable' on activity → fall to pushed_at
    // (both '2026-01-01...') → fall to name asc.
    expect(out.map((r) => r.full_name)).toEqual([
      'a/busy',
      'a/dead',
      'a/unavailable',
      'a/error',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [
      row({ full_name: 'b' }),
      row({ full_name: 'a' }),
    ];
    const beforeNames = input.map((r) => r.full_name);
    sortByActivity(input);
    expect(input.map((r) => r.full_name)).toEqual(beforeNames);
  });
});

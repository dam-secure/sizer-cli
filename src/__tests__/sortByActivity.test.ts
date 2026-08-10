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
    last_pr_at: '2026-01-01T00:00:00Z',
    prs_last_1w: 0,
    prs_last_4w: 0,
    prs_last_3m: 0,
    prs_last_12m: 0,
    prs_last_24m: 0,
    pr_authors_last_1w: 0,
    pr_authors_last_4w: 0,
    pr_authors_last_3m: 0,
    pr_authors_last_12m: 0,
    pr_authors_last_24m: 0,
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
  it('orders by prs_last_4w desc as the primary key', () => {
    const out = sortByActivity([
      row({ full_name: 'a/quiet', prs_last_4w: 0 }),
      row({ full_name: 'a/busy', prs_last_4w: 200 }),
      row({ full_name: 'a/medium', prs_last_4w: 50 }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual(['a/busy', 'a/medium', 'a/quiet']);
  });

  it('uses commits_last_4w when PR activity is tied', () => {
    const out = sortByActivity([
      row({ full_name: 'a/quiet', prs_last_4w: 0, commits_last_4w: 0 }),
      row({ full_name: 'a/busy', prs_last_4w: 0, commits_last_4w: 200 }),
      row({ full_name: 'a/medium', prs_last_4w: 0, commits_last_4w: 50 }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual(['a/busy', 'a/medium', 'a/quiet']);
  });

  it('uses prs_last_12m as a later tiebreak', () => {
    const out = sortByActivity([
      row({ full_name: 'a/old-but-active', prs_last_4w: 0, commits_last_4w: 0, prs_last_12m: 100 }),
      row({ full_name: 'a/dead', prs_last_4w: 0, commits_last_4w: 0, prs_last_12m: 0 }),
      row({ full_name: 'a/middling', prs_last_4w: 0, commits_last_4w: 0, prs_last_12m: 30 }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual([
      'a/old-but-active',
      'a/middling',
      'a/dead',
    ]);
  });

  it('uses last_pr_at desc as a later tiebreak', () => {
    const out = sortByActivity([
      row({ full_name: 'a/older', last_pr_at: '2025-01-01T00:00:00Z' }),
      row({ full_name: 'a/newer', last_pr_at: '2026-05-01T00:00:00Z' }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual(['a/newer', 'a/older']);
  });

  it('falls back to alphabetical for total ties', () => {
    const out = sortByActivity([
      row({ full_name: 'a/zeta', last_pr_at: '2026-01-01T00:00:00Z' }),
      row({ full_name: 'a/alpha', last_pr_at: '2026-01-01T00:00:00Z' }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual(['a/alpha', 'a/zeta']);
  });

  it('sinks errored rows below all non-errored rows', () => {
    const out = sortByActivity([
      row({ full_name: 'a/error', prs_last_4w: 1000, error: 'boom' }),
      row({ full_name: 'a/quiet', prs_last_4w: 0 }),
      row({ full_name: 'a/busy', prs_last_4w: 50 }),
    ]);
    expect(out.map((r) => r.full_name)).toEqual([
      'a/busy',
      'a/quiet',
      'a/error',
    ]);
  });

  it('treats negative PR/activity values as 0 for those signals', () => {
    const out = sortByActivity([
      row({
        full_name: 'a/unavailable',
        activity_unavailable: true,
        prs_last_4w: -1,
        commits_last_4w: -1,
        commits_last_52w: -1,
      }),
      row({ full_name: 'a/dead', prs_last_4w: 0, commits_last_4w: 0, commits_last_52w: 0 }),
      row({ full_name: 'a/error', error: 'failed' }),
      row({ full_name: 'a/busy', prs_last_4w: 5 }),
    ]);
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

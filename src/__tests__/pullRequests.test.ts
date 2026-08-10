/**
 * Unit tests for PR aggregation + GitHub GraphQL pagination.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregatePullRequests,
  EMPTY_PR_STATS,
  PullRequestFetchError,
  type PullRequestNode,
} from '../analyse/pullRequests.js';
import { GitHubEnumerator } from '../scm/github.js';

const NOW = new Date('2026-08-01T00:00:00Z');

function pr(overrides: Partial<PullRequestNode>): PullRequestNode {
  return {
    number: 1,
    state: 'MERGED',
    createdAt: '2026-07-20T00:00:00Z',
    authorLogin: 'alice',
    ...overrides,
  };
}

describe('aggregatePullRequests', () => {
  it('returns empty stats for no PRs', () => {
    expect(aggregatePullRequests([], { now: NOW })).toEqual(EMPTY_PR_STATS);
  });

  it('aggregates window counts and authors', () => {
    const stats = aggregatePullRequests(
      [
        pr({
          number: 1,
          createdAt: '2026-07-28T00:00:00Z', // within 1w
          authorLogin: 'alice',
        }),
        pr({
          number: 2,
          createdAt: '2026-07-10T00:00:00Z', // within 4w, outside 1w
          authorLogin: 'bob',
        }),
        pr({
          number: 3,
          createdAt: '2026-05-15T00:00:00Z', // within 3m
          authorLogin: 'carol',
        }),
        pr({
          number: 4,
          createdAt: '2025-10-01T00:00:00Z', // within 12m
          authorLogin: 'dave',
        }),
        pr({
          number: 5,
          createdAt: '2024-10-01T00:00:00Z', // within 24m
          authorLogin: 'erin',
        }),
        pr({
          number: 6,
          createdAt: '2023-01-01T00:00:00Z', // older than 24m
          authorLogin: 'frank',
        }),
      ],
      { now: NOW }
    );

    expect(stats.lastPrAt).toBe('2026-07-28T00:00:00Z');
    expect(stats.prsLast1w).toBe(1);
    expect(stats.prsLast4w).toBe(2);
    expect(stats.prsLast3m).toBe(3);
    expect(stats.prsLast12m).toBe(4);
    expect(stats.prsLast24m).toBe(5);
    expect(stats.prAuthorsLast1w).toBe(1);
    expect(stats.prAuthorsLast4w).toBe(2);
    expect(stats.prAuthorsLast3m).toBe(3);
    expect(stats.prAuthorsLast12m).toBe(4);
    expect(stats.prAuthorsLast24m).toBe(5);
  });
});

describe('GitHubEnumerator.fetchPullRequestStats', () => {
  it('paginates GraphQL PR pages and aggregates', async () => {
    const pages: Array<{ after: string | null; body: unknown }> = [
      {
        after: null,
        body: {
          data: {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                nodes: [
                  {
                    number: 1,
                    state: 'MERGED',
                    createdAt: '2026-07-20T00:00:00Z',
                    author: { login: 'alice' },
                  },
                ],
              },
            },
          },
        },
      },
      {
        after: 'cursor-1',
        body: {
          data: {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 2,
                    state: 'OPEN',
                    createdAt: '2026-07-28T00:00:00Z',
                    author: { login: 'bob' },
                  },
                ],
              },
            },
          },
        },
      },
    ];

    const fetchMock = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!url.includes('/graphql')) {
        throw new Error(`unexpected URL ${url}`);
      }
      const payload = JSON.parse(String(init.body ?? '{}')) as {
        variables?: { cursor?: string | null };
      };
      const cursor = payload.variables?.cursor ?? null;
      const page = pages.find((p) => p.after === cursor);
      if (!page) throw new Error(`no GraphQL page for cursor ${String(cursor)}`);
      pages.splice(pages.indexOf(page), 1);
      return new Response(JSON.stringify(page.body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const enumerator = new GitHubEnumerator('ghp_test', { request: { fetch: fetchMock } });
    const stats = await enumerator.fetchPullRequestStats('acme/api', { now: NOW });

    expect(stats.prsLast4w).toBe(2);
    expect(stats.prsLast1w).toBe(1);
    expect(stats.prAuthorsLast4w).toBe(2);
  });

  it('throws a loud PullRequestFetchError when GraphQL fails', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const enumerator = new GitHubEnumerator('ghp_bad', { request: { fetch: fetchMock } });
    await expect(enumerator.fetchPullRequestStats('acme/api')).rejects.toBeInstanceOf(
      PullRequestFetchError
    );
    await expect(enumerator.fetchPullRequestStats('acme/api')).rejects.toThrow(
      /Pull requests: Read-only/
    );
  });
});

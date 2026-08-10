/**
 * Pull-request sizing facts derived from GitHub PR metadata.
 *
 * Aggregation is pure so unit tests can pin window math without Octokit.
 * Fetching lives on {@link GitHubEnumerator.fetchPullRequestStats}.
 *
 * Window semantics: a PR counts in a window when its `createdAt` is on or
 * after (now - window). Month windows use 30-day months (90 / 365 / 730 days
 * for 3m / 12m / 24m).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

/** Minimal PR node shape from the GitHub GraphQL `pullRequests` connection. */
export interface PullRequestNode {
  number: number;
  state: PullRequestState;
  createdAt: string;
  authorLogin: string | null;
}

export interface PullRequestStats {
  /** ISO timestamp of the most recently created PR, or empty. */
  lastPrAt: string;
  prsLast1w: number;
  prsLast4w: number;
  prsLast3m: number;
  prsLast12m: number;
  prsLast24m: number;
  prAuthorsLast1w: number;
  prAuthorsLast4w: number;
  prAuthorsLast3m: number;
  prAuthorsLast12m: number;
  prAuthorsLast24m: number;
}

/** Placeholder for errored rows that never reached a successful PR fetch. */
export const UNAVAILABLE_PR_STATS: PullRequestStats = Object.freeze({
  lastPrAt: '',
  prsLast1w: -1,
  prsLast4w: -1,
  prsLast3m: -1,
  prsLast12m: -1,
  prsLast24m: -1,
  prAuthorsLast1w: -1,
  prAuthorsLast4w: -1,
  prAuthorsLast3m: -1,
  prAuthorsLast12m: -1,
  prAuthorsLast24m: -1,
});

export const EMPTY_PR_STATS: PullRequestStats = Object.freeze({
  lastPrAt: '',
  prsLast1w: 0,
  prsLast4w: 0,
  prsLast3m: 0,
  prsLast12m: 0,
  prsLast24m: 0,
  prAuthorsLast1w: 0,
  prAuthorsLast4w: 0,
  prAuthorsLast3m: 0,
  prAuthorsLast12m: 0,
  prAuthorsLast24m: 0,
});

export interface AggregatePullRequestsOptions {
  now?: Date;
}

/**
 * Thrown when PR metadata cannot be loaded. Callers should surface this as a
 * hard failure — missing Pull requests: Read (or equivalent) must not soft-fail.
 */
export class PullRequestFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullRequestFetchError';
  }
}

export function aggregatePullRequests(
  nodes: readonly PullRequestNode[],
  options: AggregatePullRequestsOptions = {}
): PullRequestStats {
  if (nodes.length === 0) {
    return { ...EMPTY_PR_STATS };
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const cutoff1w = nowMs - 7 * MS_PER_DAY;
  const cutoff4w = nowMs - 28 * MS_PER_DAY;
  const cutoff3m = nowMs - 90 * MS_PER_DAY;
  const cutoff12m = nowMs - 365 * MS_PER_DAY;
  const cutoff24m = nowMs - 730 * MS_PER_DAY;

  let lastPrAt = '';
  let lastPrMs = Number.NEGATIVE_INFINITY;

  let prsLast1w = 0;
  let prsLast4w = 0;
  let prsLast3m = 0;
  let prsLast12m = 0;
  let prsLast24m = 0;
  const authors1w = new Set<string>();
  const authors4w = new Set<string>();
  const authors3m = new Set<string>();
  const authors12m = new Set<string>();
  const authors24m = new Set<string>();

  for (const pr of nodes) {
    const createdMs = Date.parse(pr.createdAt);
    if (!Number.isNaN(createdMs) && createdMs >= lastPrMs) {
      lastPrMs = createdMs;
      lastPrAt = pr.createdAt;
    }

    if (Number.isNaN(createdMs)) continue;

    if (createdMs >= cutoff24m) {
      prsLast24m += 1;
      if (pr.authorLogin) authors24m.add(pr.authorLogin);
    }
    if (createdMs >= cutoff12m) {
      prsLast12m += 1;
      if (pr.authorLogin) authors12m.add(pr.authorLogin);
    }
    if (createdMs >= cutoff3m) {
      prsLast3m += 1;
      if (pr.authorLogin) authors3m.add(pr.authorLogin);
    }
    if (createdMs >= cutoff4w) {
      prsLast4w += 1;
      if (pr.authorLogin) authors4w.add(pr.authorLogin);
    }
    if (createdMs >= cutoff1w) {
      prsLast1w += 1;
      if (pr.authorLogin) authors1w.add(pr.authorLogin);
    }
  }

  return {
    lastPrAt,
    prsLast1w,
    prsLast4w,
    prsLast3m,
    prsLast12m,
    prsLast24m,
    prAuthorsLast1w: authors1w.size,
    prAuthorsLast4w: authors4w.size,
    prAuthorsLast3m: authors3m.size,
    prAuthorsLast12m: authors12m.size,
    prAuthorsLast24m: authors24m.size,
  };
}

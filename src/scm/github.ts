/**
 * GitHub repo enumerator (v1).
 *
 * Uses Octokit + `@octokit/plugin-throttling` (handles primary/secondary rate
 * limits with backoff) + `@octokit/plugin-retry` (transient 5xx). Pagination
 * goes through `octokit.paginate` so we naturally consume every page without
 * leaking the cursor outside this file.
 *
 * Pull-request sizing uses GraphQL so each page returns createdAt + author
 * without an N+1 REST get-PR loop.
 */

import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import {
  aggregatePullRequests,
  EMPTY_PR_STATS,
  PullRequestFetchError,
  type PullRequestNode,
  type PullRequestStats,
  type PullRequestState,
} from '../analyse/pullRequests.js';
import type {
  EnumerateOptions,
  RepoListing,
  ScmEnumerator,
  ScmScope,
} from './types.js';

const ThrottledOctokit = Octokit.plugin(throttling, retry);

const PR_PAGE_SIZE = 100;

const PULL_REQUESTS_QUERY = `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: ${PR_PAGE_SIZE}, after: $cursor, states: [OPEN, CLOSED, MERGED], orderBy: {field: CREATED_AT, direction: DESC}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          state
          createdAt
          author {
            login
          }
        }
      }
    }
  }
`;

export interface GitHubEnumeratorOptions {
  /** Optional override for testing (e.g., to point at a local mock). */
  baseUrl?: string;
  /** Optional UA suffix; we always prepend `damsecure-sizer/<version>`. */
  userAgent?: string;
  /** Override for tests — forwarded to `Octokit.request.fetch`. */
  request?: { fetch: typeof fetch };
}

/**
 * GitHub-specific PAT-injected clone URL.
 * Result: `https://x-access-token:<token>@github.com/<owner>/<repo>.git`.
 *
 * **NEVER log the return value.** The preflight log redactor scrubs the token
 * if it leaks, but the calling layer should not rely on that.
 */
export function buildAuthenticatedCloneUrl(
  httpsUrl: string,
  token: string
): string {
  const u = new URL(httpsUrl);
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}

export class GitHubEnumerator implements ScmEnumerator {
  private readonly client: InstanceType<typeof ThrottledOctokit>;

  constructor(
    private readonly token: string,
    options: GitHubEnumeratorOptions = {}
  ) {
    this.client = new ThrottledOctokit({
      auth: token,
      baseUrl: options.baseUrl ?? 'https://api.github.com',
      userAgent: options.userAgent ?? 'damsecure-sizer',
      request: options.request,
      throttle: {
        // We swallow up to one retry for both primary and secondary rate
        // limits; the user sees a warning to stderr instead of a hard fail.
        // (The plugin's type definitions don't always flow through here, so
        // we annotate the relevant params explicitly.)
        onRateLimit: (
          retryAfter: number,
          opts: { method?: string; url?: string },
          _octokit: unknown,
          retryCount: number
        ) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[github] rate limited (${opts.method} ${opts.url}); retrying after ${retryAfter}s`
          );
          return retryCount < 1;
        },
        onSecondaryRateLimit: (
          retryAfter: number,
          opts: { method?: string; url?: string },
          _octokit: unknown,
          retryCount: number
        ) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[github] secondary rate limit (${opts.method} ${opts.url}); retrying after ${retryAfter}s`
          );
          return retryCount < 1;
        },
      },
    });
  }

  async enumerate(
    scope: ScmScope,
    opts: EnumerateOptions
  ): Promise<RepoListing[]> {
    if (scope.provider !== 'github') {
      throw new Error(
        `GitHubEnumerator received non-github scope: ${scope.provider}`
      );
    }

    let raw: unknown[];
    try {
      raw = await this.client.paginate(this.client.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
        affiliation: 'owner,collaborator,organization_member',
      });
    } catch (err) {
      throw mapGitHubError(err, scope);
    }

    return raw
      .map((repo) => this.toListing(repo as GitHubRepo))
      .filter((listing) => {
        if (
          scope.provider === 'github' &&
          scope.type === 'owner' &&
          ownerOf(listing.fullName) !== scope.owner.toLowerCase()
        ) {
          return false;
        }
        if (!opts.includeArchived && listing.isArchived) {
          // Archived repos are still ENUMERATED (so the customer sees they
          // exist in the list CSV with `included=false`); only swallow
          // them entirely when the caller explicitly asks to drop them.
          //
          // Default is `includeArchived=true` so the row appears with
          // `included=false`. Callers wanting a strict drop pass
          // `includeArchived=false`.
          return false;
        }
        if (!opts.includeForks && listing.isFork) {
          return false;
        }
        return true;
      });
  }

  /**
   * Paginate every PR on `owner/repo` via GraphQL and aggregate sizing facts.
   * Requires a fine-grained PAT with **Pull requests: Read** (or classic `repo`).
   */
  async fetchPullRequestStats(
    fullName: string,
    options: { now?: Date } = {}
  ): Promise<PullRequestStats> {
    const slash = fullName.indexOf('/');
    if (slash <= 0 || slash === fullName.length - 1) {
      throw new PullRequestFetchError(
        `Cannot fetch pull requests for invalid repository name "${fullName}".`
      );
    }
    const owner = fullName.slice(0, slash);
    const name = fullName.slice(slash + 1);

    try {
      const nodes: PullRequestNode[] = [];
      let cursor: string | null = null;
      let hasNextPage = true;

      while (hasNextPage) {
        const data = (await this.client.graphql(PULL_REQUESTS_QUERY, {
          owner,
          name,
          cursor,
        })) as PullRequestsQueryResult;

        const repo = data.repository;
        if (!repo) {
          return { ...EMPTY_PR_STATS };
        }

        for (const node of repo.pullRequests.nodes) {
          if (!node) continue;
          nodes.push({
            number: node.number,
            state: normalizePrState(node.state),
            createdAt: node.createdAt,
            authorLogin: node.author?.login ?? null,
          });
        }

        hasNextPage = repo.pullRequests.pageInfo.hasNextPage;
        cursor = repo.pullRequests.pageInfo.endCursor;
      }

      return aggregatePullRequests(nodes, { now: options.now });
    } catch (err) {
      if (err instanceof PullRequestFetchError) throw err;
      throw mapPullRequestFetchError(err, fullName);
    }
  }

  private toListing(repo: GitHubRepo): RepoListing {
    const cloneUrl = buildAuthenticatedCloneUrl(
      repo.clone_url ?? repo.html_url ?? `https://github.com/${repo.full_name}.git`,
      this.token
    );
    return {
      fullName: repo.full_name,
      cloneUrl,
      defaultBranch: repo.default_branch ?? '',
      sizeKb: repo.size ?? 0,
      pushedAt: repo.pushed_at ?? '',
      isArchived: Boolean(repo.archived),
      isFork: Boolean(repo.fork),
      // GitHub's API doesn't directly mark "empty"; the strongest indicator
      // is the absence of a default_branch (size=0 is too noisy — a repo
      // with `.gitkeep` has size 0).
      isEmpty: !repo.default_branch,
    };
  }
}

function ownerOf(fullName: string): string {
  return fullName.split('/')[0]?.toLowerCase() ?? '';
}

interface GitHubRepo {
  full_name: string;
  clone_url?: string;
  html_url?: string;
  default_branch?: string | null;
  size?: number;
  pushed_at?: string | null;
  archived?: boolean;
  fork?: boolean;
}

interface PullRequestsQueryResult {
  repository: {
    pullRequests: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: Array<{
        number: number;
        state: string;
        createdAt: string;
        author: { login: string } | null;
      } | null>;
    };
  } | null;
}

function normalizePrState(state: string): PullRequestState {
  if (state === 'OPEN' || state === 'MERGED' || state === 'CLOSED') return state;
  return 'CLOSED';
}

function mapPullRequestFetchError(err: unknown, fullName: string): PullRequestFetchError {
  const message = err instanceof Error ? err.message : String(err);
  return new PullRequestFetchError(
    `Failed to fetch pull requests for ${fullName}. ` +
      `Check that the PAT has Repository permission "Pull requests: Read-only" ` +
      `(see README Authentication).\n` +
      `Underlying error: ${message.split('\n')[0]}`
  );
}

/**
 * Translate raw Octokit failures into user-facing errors. Mapping kept here
 * so commands/list.ts can `try/catch` on a single error type if we add one
 * later.
 */
function mapGitHubError(err: unknown, scope: ScmScope): Error {
  const e = err as { status?: number; message?: string };
  if (e.status === 401) {
    return new Error(
      'GitHub rejected the token (401). Check that the PAT has not expired and has the right scopes — see README for the click-path.'
    );
  }
  if (e.status === 404) {
    return new Error('GitHub returned 404 enumerating repos.');
  }
  if (e.status === 403) {
    return new Error(
      'GitHub denied the request (403). The token likely lacks read access to the requested scope, or you have hit a secondary rate limit.'
    );
  }
  return new Error(
    `GitHub enumeration failed${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message ?? 'unknown error'}`
  );
}

/**
 * Provider-agnostic types for the repo-enumeration layer.
 *
 * Provider differences live ENTIRELY in this layer; everything downstream
 * (clone, analyse, CSV) consumes `RepoListing[]` and is identical across
 * GitHub / GitLab / Bitbucket / Azure.
 */

/**
 * The minimal per-repo metadata the rest of the pipeline depends on. Anything
 * provider-specific (e.g., GitHub's `pushed_at` granularity, GitLab's `default_branch`
 * shape) is normalised by the enumerator before this struct is returned.
 */
export interface RepoListing {
  /** Canonical name used as display + CSV identity, e.g. `"acme/api"`. */
  fullName: string;
  /**
   * HTTPS clone URL with PAT credentials already injected, ready for
   * `git clone`. Format: `https://x-access-token:<token>@<host>/<path>.git`.
   *
   * **MUST NEVER BE LOGGED.** The preflight log redactor scrubs the token,
   * but defence in depth: callers should treat this as a secret.
   */
  cloneUrl: string;
  /** Default branch name (e.g. `"main"`). Empty string for empty repos. */
  defaultBranch: string;
  /** Provider-reported size in KB (informational; used for the list CSV). */
  sizeKb: number;
  /** ISO 8601 of last push to default branch (empty for empty repos). */
  pushedAt: string;
  isArchived: boolean;
  isFork: boolean;
  /** True when the provider reports no default branch / zero commits. */
  isEmpty: boolean;
}

/**
 * Scope to enumerate. v1 only implements GitHub; the other variants are
 * placeholders so the interface is part of the codebase from day 1 (and
 * callers don't have to be retro-fitted when GitLab/Bitbucket/Azure land).
 */
export type ScmScope =
  | { provider: 'github'; type: 'org'; name: string }
  | { provider: 'github'; type: 'user'; name?: string }
  | { provider: 'gitlab'; group: string }
  | { provider: 'bitbucket'; workspace: string }
  | { provider: 'azure'; organization: string; project?: string };

export interface EnumerateOptions {
  /**
   * When true, archived repos are still enumerated; the `included=` column
   * default is the caller's concern (see {@link defaultIncluded}).
   */
  includeArchived: boolean;
  /** When true, fork repos are still enumerated. */
  includeForks: boolean;
}

export interface ScmEnumerator {
  /**
   * List all repos in the given scope, applying provider-specific pagination.
   * Implementations MUST throw a friendly Error on auth/scope failures (the
   * CLI maps those to user-facing messages in `commands/list.ts`).
   */
  enumerate(scope: ScmScope, opts: EnumerateOptions): Promise<RepoListing[]>;
}

/**
 * Decision D-B (locked in the plan): `included=true` for active non-archived
 * non-fork non-empty repos; `false` for archived/fork/empty by default.
 *
 * The customer can flip the `included` column in Excel/Sheets before
 * `size --from`; this function only computes the default.
 */
export function defaultIncluded(repo: RepoListing): boolean {
  if (repo.isArchived) return false;
  if (repo.isFork) return false;
  if (repo.isEmpty) return false;
  return true;
}

/**
 * Partial clone helper.
 *
 * Strategy (decision D1):
 *   `git clone --filter=blob:none --no-checkout <auth-url> <dest>`
 *   - `--filter=blob:none` — fetch trees + commits but no blob contents.
 *     Typical 5,000-file repo: ~5–20 MB on disk.
 *   - `--no-checkout` — skip materialising the working directory; we only
 *     need `git ls-tree` and `git log`.
 *
 * Fallback (decision D6):
 *   On older self-hosted servers (rare for GitHub.com; possible for
 *   Bitbucket / Azure servers in v2) the partial-clone protocol can be
 *   rejected. We catch the failure, print a one-line warning to stderr,
 *   and retry with a full clone. The repo still gets sized — just slower.
 *
 * Returns: a `SimpleGit` instance bound to `dest`, plus a `usedFallback`
 * flag the caller can surface in diagnostics.
 */

import { rm } from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';

export interface PartialCloneResult {
  /** simple-git handle bound to the clone directory. */
  git: SimpleGit;
  /** True iff we fell back to a full clone (decision D6). */
  usedFullCloneFallback: boolean;
}

export interface PartialCloneOptions {
  /**
   * Override the warning sink. Defaults to `console.warn`. Tests pass a
   * spy here.
   */
  warn?: (msg: string) => void;
  /**
   * Inject a clone runner for tests. The default invokes `simpleGit().clone`.
   * Two arguments: (cloneUrl, destination, opts). If `opts.fullCloneFallback`
   * is true, the runner must perform a full clone.
   */
  runner?: CloneRunner;
}

export interface CloneRunOptions {
  destination: string;
  partialFilter: boolean; // false ⇒ full clone (fallback path)
  noCheckout: boolean;
}

export type CloneRunner = (
  cloneUrl: string,
  opts: CloneRunOptions
) => Promise<void>;

/**
 * Default runner: shells out to `git clone` via simple-git in the current
 * directory and clones into `destination`.
 *
 * `simple-git`'s `.clone()` accepts a remote, a destination, and an array of
 * extra args appended after the destination — we put the protocol filter
 * BEFORE the URL and dest in a single args array because simple-git
 * positions them correctly.
 */
const defaultRunner: CloneRunner = async (cloneUrl, opts) => {
  const args: string[] = [];
  if (opts.partialFilter) {
    args.push('--filter=blob:none');
  }
  if (opts.noCheckout) {
    args.push('--no-checkout');
  }

  // simple-git's clone(repoPath, localPath, options): the third arg can be a
  // string array of additional flags placed before the URL.
  await simpleGit().clone(cloneUrl, opts.destination, args);
};

/**
 * Returns true if the error string suggests the partial-clone protocol is
 * unsupported by the remote. We're conservative: only retry on these
 * well-known signals; everything else bubbles up.
 *
 * Strings observed in the wild for `--filter=blob:none` rejection:
 *  - "filtering not recognized by server"
 *  - "server does not support filter"
 *  - "filter ... not supported"
 *  - "fatal: protocol error: bad pack header"
 *  - "object filtering"
 */
export function looksLikePartialCloneRejection(message: string): boolean {
  const m = message.toLowerCase();
  if (
    m.includes('filtering not recognized by server') ||
    m.includes('server does not support filter') ||
    m.includes('filter not supported') ||
    m.includes('object filtering') ||
    m.includes('does not support --filter')
  ) {
    return true;
  }
  return false;
}

export async function partialClone(
  cloneUrl: string,
  destination: string,
  options: PartialCloneOptions = {}
): Promise<PartialCloneResult> {
  const warn = options.warn ?? ((msg: string) => console.warn(msg));
  const runner = options.runner ?? defaultRunner;

  try {
    await runner(cloneUrl, {
      destination,
      partialFilter: true,
      noCheckout: true,
    });
    return {
      git: simpleGit(destination),
      usedFullCloneFallback: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!looksLikePartialCloneRejection(msg)) {
      throw err;
    }
    // Decision D6: fall back to a full clone with a warning.
    warn(
      `[sizer] partial clone (--filter=blob:none) was rejected by the remote; falling back to a full clone. This is slower but produces identical sizing output.`
    );
    // Wipe any partial scaffolding the failed attempt may have left behind.
    await rm(destination, { recursive: true, force: true });

    await runner(cloneUrl, {
      destination,
      partialFilter: false,
      noCheckout: true,
    });
    return {
      git: simpleGit(destination),
      usedFullCloneFallback: true,
    };
  }
}

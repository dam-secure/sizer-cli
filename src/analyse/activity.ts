/**
 * Activity analysis for a partially-cloned repo.
 *
 * Strategy: ONE `git log --since=52w --pretty=%H%x09%an%x09%cI` pass, then
 * client-side bucket into 4w / 13w / 52w windows. We deliberately avoid
 * three separate `git log` calls (and `git shortlog`) — each subprocess on
 * a 5,000-commit repo is ~150ms; one pass is enough.
 *
 * Window semantics (decision D9 in the original spec, locked):
 *   "commits in the last Nw" = commits with committer-date strictly newer
 *   than (now - N*7 days). Inclusive of the boundary.
 *
 * Output columns mirror the sized CSV:
 *   - last_commit_at
 *   - commits_last_{4w,13w,52w}
 *   - committers_last_{4w,13w,52w}
 *   - top_contributors  (top 5: "name:count;...", semicolon-joined)
 *   - activity_unavailable  (true iff git log threw; the row's other
 *                            activity numbers are -1 in that case)
 */

import type { SimpleGit } from 'simple-git';
import { debugLog } from '../debugLog.js';

export interface ActivitySummary {
  /** ISO 8601 of the most recent commit on HEAD, or empty string if unavailable. */
  lastCommitAt: string;
  commitsLast4w: number;
  commitsLast13w: number;
  commitsLast52w: number;
  committersLast4w: number;
  committersLast13w: number;
  committersLast52w: number;
  /** Top 5 contributors over the full 52w window, ordered by count desc. */
  topContributors: Array<{ name: string; commits: number }>;
  activityUnavailable: boolean;
}

export interface AnalyseActivityOptions {
  /** Override "now" for deterministic tests. */
  now?: Date;
  /**
   * Window in weeks for the `--since` flag passed to git. Defaults to 52,
   * matching the largest window we report. Useful in tests to keep `git log`
   * output bounded.
   */
  sinceWeeks?: number;
}

/**
 * Single record parsed out of `git log --pretty=%H%x09%an%x09%cI`.
 */
export interface ActivityRecord {
  sha: string;
  author: string;
  /** Committer date (ISO 8601), parseable by Date. */
  committedAt: string;
}

const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;

const UNAVAILABLE_SUMMARY: ActivitySummary = Object.freeze({
  lastCommitAt: '',
  commitsLast4w: -1,
  commitsLast13w: -1,
  commitsLast52w: -1,
  committersLast4w: -1,
  committersLast13w: -1,
  committersLast52w: -1,
  topContributors: [],
  activityUnavailable: true,
});

export async function analyseActivity(
  git: SimpleGit,
  options: AnalyseActivityOptions = {}
): Promise<ActivitySummary> {
  const now = options.now ?? new Date();
  const sinceWeeks = options.sinceWeeks ?? 52;

  let logRaw: string;
  try {
    // Caveat: `git log --since=<date>` uses a traversal optimisation that
    // stops walking past old commits in the chain, so a repo whose HEAD has
    // an old committer date (e.g., someone fast-forwarded a backport branch
    // to HEAD) can return zero commits even though newer commits exist as
    // ancestors. Real-world repos have HEAD at the newest commit and aren't
    // affected; for v1 we accept the caveat and document it in the README.
    logRaw = await git.raw([
      'log',
      `--since=${sinceWeeks}.weeks.ago`,
      '--pretty=%H%x09%an%x09%cI',
    ]);
  } catch (err) {
    // Rule-3 requirement: don't suppress silently. The user-facing semantics
    // are unchanged (activity_unavailable=true), but `--debug` now reveals
    // the underlying error.
    debugLog('analyseActivity.gitLog', err);
    return { ...UNAVAILABLE_SUMMARY };
  }

  const records = parseGitLog(logRaw);
  return summariseActivity(records, await getLastCommitAt(git), now);
}

/**
 * Pure function — exposed for tests. Bucketing logic lives here so it can be
 * exercised without spawning git.
 */
export function summariseActivity(
  records: readonly ActivityRecord[],
  lastCommitAt: string,
  now: Date
): ActivitySummary {
  const fourWeeksAgo = subtractWeeks(now, 4);
  const thirteenWeeksAgo = subtractWeeks(now, 13);
  const fiftyTwoWeeksAgo = subtractWeeks(now, 52);

  let commits4 = 0;
  let commits13 = 0;
  let commits52 = 0;
  const committers4 = new Set<string>();
  const committers13 = new Set<string>();
  const committers52 = new Set<string>();
  const totals52 = new Map<string, number>();

  for (const rec of records) {
    const t = Date.parse(rec.committedAt);
    if (Number.isNaN(t)) continue;
    if (t < fiftyTwoWeeksAgo) continue;
    commits52++;
    committers52.add(rec.author);
    totals52.set(rec.author, (totals52.get(rec.author) ?? 0) + 1);

    if (t >= thirteenWeeksAgo) {
      commits13++;
      committers13.add(rec.author);
    }
    if (t >= fourWeeksAgo) {
      commits4++;
      committers4.add(rec.author);
    }
  }

  const topContributors = Array.from(totals52.entries())
    .sort((a, b) => {
      // Primary: count desc. Secondary: name asc (deterministic tie-break).
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 5)
    .map(([name, commits]) => ({ name, commits }));

  return {
    lastCommitAt,
    commitsLast4w: commits4,
    commitsLast13w: commits13,
    commitsLast52w: commits52,
    committersLast4w: committers4.size,
    committersLast13w: committers13.size,
    committersLast52w: committers52.size,
    topContributors,
    activityUnavailable: false,
  };
}

/**
 * Format the topContributors array as a single CSV-friendly string:
 * `"alice:42;bob:17;..."`. Names with `:` or `;` are escaped — those
 * characters are forbidden in committer.name by git anyway, but defence in
 * depth: we replace them with `_`.
 */
export function formatTopContributors(
  top: readonly { name: string; commits: number }[]
): string {
  return top
    .map(
      ({ name, commits }) =>
        `${name.replace(/[:;]/g, '_')}:${commits}`
    )
    .join(';');
}

/**
 * Parse the raw output of `git log --pretty=%H%x09%an%x09%cI`. Lines with
 * fewer than 3 tab-separated fields are skipped (defensive — should never
 * happen with the format we ask for).
 */
export function parseGitLog(raw: string): ActivityRecord[] {
  const records: ActivityRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    records.push({
      sha: parts[0],
      author: parts[1],
      committedAt: parts[2],
    });
  }
  return records;
}

async function getLastCommitAt(git: SimpleGit): Promise<string> {
  try {
    const out = await git.raw(['log', '-1', '--format=%cI', 'HEAD']);
    return out.trim();
  } catch (err) {
    debugLog('analyseActivity.lastCommitAt', err);
    return '';
  }
}

function subtractWeeks(now: Date, weeks: number): number {
  return now.getTime() - weeks * SECONDS_PER_WEEK * 1000;
}

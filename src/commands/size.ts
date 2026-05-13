/**
 * `size` command pipeline.
 *
 *   parse args                           →  preflight (token, git, redactor)
 *                                         →  enumerate repos via SCM
 *   apply default included + ignored repos + optional interactive deselect
 *                                         →  pLimit(5) per repo:
 *                                              partialClone
 *                                              analyseFiles
 *                                              analyseActivity (skipped if --no-activity)
 *                                              releaseRepo (always)
 *   render to --format (csv | table)
 *
 * Concurrency default = 5 (decision D5). Per-repo `try/finally` cleanup. The
 * workspace is destroyed on success, on error, and on SIGINT/SIGTERM.
 */

import { writeFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import { simpleGit } from 'simple-git';
import { preflight } from '../preflight.js';
import { createEnumerator, parseScope } from '../scm/factory.js';
import type { RepoListing } from '../scm/types.js';
import { listingToRow } from './list.js';
import { writeSizedCsv, type RepoListRow, type RepoSizedRow } from '../reporting/csv.js';
import { renderSizedTable } from '../reporting/table.js';
import { partialClone } from '../clone/partialClone.js';
import {
  createWorkspace,
  registerProcessCleanup,
  type WorkspaceHandle,
} from '../clone/workspace.js';
import { analyseFiles } from '../analyse/files.js';
import {
  analyseActivity,
  formatTopContributors,
} from '../analyse/activity.js';
import {
  QUIET_REPORTER,
  createStderrReporter,
  type ProgressReporter,
} from '../progress.js';
import { interactiveDeselect } from '../filtering/interactive.js';

const DEFAULT_CONCURRENCY = 5;
const FULL_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type SizeOutputFormat = 'csv' | 'table';

export interface SizeCommandOptions {
  /** Scope to enumerate before sizing. */
  scope: string;

  token?: string;
  output?: string;
  format?: SizeOutputFormat;
  concurrency?: number;
  noActivity?: boolean;
  interactive?: boolean;
  /** Comma-separated exact full names to skip before cloning, e.g. "acme/a,acme/b". */
  ignoreRepos?: string;

  /** Forwarded to enumerator when --scope is used. */
  includeArchived?: boolean;
  includeForks?: boolean;

  /**
   * When true, suppress the per-repo progress lines on stderr. Default
   * `false` — silent CLIs are a UX trap on a 30-second run.
   */
  quiet?: boolean;

  /** Test override — replaces the live timer for activity windows. */
  now?: Date;

}

export interface SizeCommandResult {
  rows: RepoSizedRow[];
  /** Rendered output (CSV/JSON/table) — what was written to --output or stdout. */
  output: string;
}

export async function runSizeCommand(
  options: SizeCommandOptions
): Promise<SizeCommandResult> {
  if (!options.scope) {
    throw new Error('size: provide --scope <spec>.');
  }

  const ignoredRepos = parseIgnoredRepos(options.ignoreRepos);
  const { token } = await preflight({ tokenFlag: options.token });

  // 1. Enumerate and resolve list rows.
  const scope = parseScope(options.scope);
  const enumerator = createEnumerator(scope, token);
  const repos = await enumerator.enumerate(scope, {
    includeArchived: options.includeArchived ?? true,
    includeForks: options.includeForks ?? true,
  });
  const listingsByName = new Map(repos.map((r) => [r.fullName, r]));
  const enumeratedNames = new Set(repos.map((r) => normaliseRepoName(r.fullName)));

  warnForUnknownIgnoredRepos(ignoredRepos, enumeratedNames, options.quiet ?? false);

  let listRows = repos
    .map(listingToRow)
    .filter((r) => {
      if (!options.includeArchived && r.is_archived) return false;
      if (!options.includeForks && r.is_fork) return false;
      return !ignoredRepos.has(normaliseRepoName(r.full_name));
    });

  if (options.interactive) {
    listRows = await interactiveDeselect(listRows);
  }

  const included = listRows.filter((r) => r.included);
  if (included.length === 0) {
    return await finalise(
      [],
      options.format ?? defaultFormatFor(options.output),
      options
    );
  }

  // 2. Workspace + cleanup wiring.
  const workspace = await createWorkspace();
  registerProcessCleanup(workspace);

  const reporter: ProgressReporter = options.quiet
    ? QUIET_REPORTER
    : createStderrReporter();
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  reporter.start(workspace.rootDir, included.length, concurrency);

  const startedAt = Date.now();
  // Atomic counter incremented as each repo enters/leaves the work pool —
  // matches the "[ 1/N]" / "[ 2/N]" sequence the user sees on stderr. We
  // hand out indices as repos START, so a fast-clone-but-slow-analyse
  // repo doesn't appear out of order.
  let nextIndex = 0;

  try {
    const limiter = pLimit(concurrency);

    const results = await Promise.all(
      included.map((row) =>
        limiter(() =>
          sizeOneRepo(row, listingsByName, workspace, options, {
            reporter,
            takeIndex: () => ++nextIndex,
            total: included.length,
          })
        )
      )
    );

    const erroredCount = results.filter((r) => r.error.length > 0).length;
    reporter.end(Date.now() - startedAt, results.length, erroredCount);

    const format = options.format ?? defaultFormatFor(options.output);
    return await finalise(results, format, options);
  } finally {
    await workspace.destroy();
  }
}

interface ProgressContext {
  reporter: ProgressReporter;
  takeIndex: () => number;
  total: number;
}

interface FinalOptions {
  output?: string;
  now?: Date;
}

async function finalise(
  rows: RepoSizedRow[],
  format: SizeOutputFormat,
  options: FinalOptions
): Promise<SizeCommandResult> {
  let output: string;
  switch (format) {
    case 'csv':
      output = writeSizedCsv(rows);
      break;
    case 'table':
      output = renderSizedTable(rows);
      break;
  }

  if (options.output) {
    await writeFile(options.output, output, 'utf8');
  } else {
    process.stdout.write(output);
    if (!output.endsWith('\n')) process.stdout.write('\n');
  }
  return { rows, output };
}

function defaultFormatFor(outputPath: string | undefined): SizeOutputFormat {
  if (!outputPath) return 'table';
  return 'csv';
}

export function parseIgnoredRepos(raw: string | undefined): Set<string> {
  if (!raw || raw.trim() === '') return new Set();

  const parts = raw.split(',');
  const repos = new Set<string>();
  for (const part of parts) {
    const repo = part.trim();
    if (!repo) {
      throw new Error(
        '--ignore-repos contains an empty entry. Use comma-separated owner/repo names, e.g. "acme/api,acme/web".'
      );
    }
    if (!FULL_NAME_RE.test(repo)) {
      throw new Error(
        `--ignore-repos entries must be full repository names like "owner/repo" (got "${repo}").`
      );
    }
    repos.add(normaliseRepoName(repo));
  }
  return repos;
}

function normaliseRepoName(name: string): string {
  return name.toLowerCase();
}

function warnForUnknownIgnoredRepos(
  ignoredRepos: Set<string>,
  enumeratedNames: Set<string>,
  quiet: boolean
): void {
  if (quiet || ignoredRepos.size === 0) return;
  const unknown = [...ignoredRepos].filter((repo) => !enumeratedNames.has(repo));
  if (unknown.length === 0) return;
  process.stderr.write(
    `[sizer] warning: ignored repo${unknown.length === 1 ? '' : 's'} not found in enumeration: ${unknown.join(', ')}\n`
  );
}

async function sizeOneRepo(
  row: RepoListRow,
  listingsByName: Map<string, RepoListing>,
  workspace: WorkspaceHandle,
  options: SizeCommandOptions,
  progress: ProgressContext
): Promise<RepoSizedRow> {
  const index = progress.takeIndex();
  const startedAt = Date.now();
  progress.reporter.repoStart(index, progress.total, row.full_name);

  const reportDone = (
    result: RepoSizedRow,
    summary: string
  ): RepoSizedRow => {
    progress.reporter.repoDone(
      index,
      progress.total,
      row.full_name,
      summary,
      Date.now() - startedAt
    );
    return result;
  };

  const listing = listingsByName.get(row.full_name);
  if (!listing) {
    return reportDone(
      errorRow(row, 'Could not resolve a clone URL for this repo (was it deleted between list and size?).'),
      'ERROR: clone URL not resolvable'
    );
  }
  if (!listing.defaultBranch) {
    return reportDone(
      errorRow(row, 'Repository has no default branch (empty repo).'),
      'ERROR: empty repo (no default branch)'
    );
  }

  const repoDir = await workspace.reserveRepo(row.full_name);
  try {
    const cloneRes = await partialClone(listing.cloneUrl, repoDir);
    void cloneRes; // usedFullCloneFallback isn't surfaced in v1 CSV output.

    const git = simpleGit(repoDir);
    const filesResult = await analyseFiles(git);

    const activity = options.noActivity
      ? null
      : await analyseActivity(git, options.now ? { now: options.now } : {});

    const result: RepoSizedRow = {
      full_name: row.full_name,
      default_branch: row.default_branch || listing.defaultBranch,
      size_kb: row.size_kb,
      pushed_at: row.pushed_at,
      note: row.note,

      commit_sha: filesResult.commitSha,
      total_files: filesResult.totalFiles,
      excluded_global: filesResult.excludedGlobal,
      excluded_repo: filesResult.excludedRepo,
      counted_files: filesResult.countedFiles,
      truncated: filesResult.truncated,
      has_damsecure_ignore: filesResult.hasDamsecureIgnore,
      damsecure_ignore_lines: filesResult.damsecureIgnoreLines,

      last_commit_at: activity?.lastCommitAt ?? '',
      commits_last_4w: activity?.commitsLast4w ?? -1,
      commits_last_13w: activity?.commitsLast13w ?? -1,
      commits_last_52w: activity?.commitsLast52w ?? -1,
      committers_last_4w: activity?.committersLast4w ?? -1,
      committers_last_13w: activity?.committersLast13w ?? -1,
      committers_last_52w: activity?.committersLast52w ?? -1,
      top_contributors: activity ? formatTopContributors(activity.topContributors) : '',
      activity_unavailable: activity ? activity.activityUnavailable : false,

      error: '',
    };

    const summary = formatRepoSummary(result);
    return reportDone(result, summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isEmptyHeadError(message)) {
      return reportDone(emptyRepoRow(row), '0 files (empty repo)');
    }
    // Single-line variant for the progress sink so multi-line git fatals
    // don't blow out the terminal — the full message still lands in the
    // CSV's `error` column.
    const oneLine = message.split('\n')[0].slice(0, 120);
    return reportDone(errorRow(row, message), `ERROR: ${oneLine}`);
  } finally {
    await workspace.releaseRepo(repoDir);
  }
}

function isEmptyHeadError(message: string): boolean {
  return (
    /ambiguous argument 'HEAD'/.test(message) ||
    /unknown revision or path in the working tree/.test(message) ||
    /not a valid object name HEAD/.test(message)
  );
}

function emptyRepoRow(row: RepoListRow): RepoSizedRow {
  return {
    full_name: row.full_name,
    default_branch: row.default_branch,
    size_kb: row.size_kb,
    pushed_at: row.pushed_at,
    note: row.note,
    commit_sha: '',
    total_files: 0,
    excluded_global: 0,
    excluded_repo: 0,
    counted_files: 0,
    truncated: false,
    has_damsecure_ignore: false,
    damsecure_ignore_lines: 0,
    last_commit_at: '',
    commits_last_4w: -1,
    commits_last_13w: -1,
    commits_last_52w: -1,
    committers_last_4w: -1,
    committers_last_13w: -1,
    committers_last_52w: -1,
    top_contributors: '',
    activity_unavailable: true,
    error: '',
  };
}

/**
 * One-line summary for the progress sink. Format:
 *   `97 files (10 excl_global, 0 excl_repo, 87 counted), 0 commits/4w`
 *
 * When activity is unavailable or `--no-activity`, the activity portion is
 * dropped.
 */
function formatRepoSummary(row: RepoSizedRow): string {
  const filePart = `${row.total_files.toLocaleString('en-US')} files (${row.excluded_global.toLocaleString('en-US')} excl_global, ${row.excluded_repo.toLocaleString('en-US')} excl_repo, ${row.counted_files.toLocaleString('en-US')} counted)`;
  if (row.activity_unavailable || row.commits_last_4w < 0) {
    return filePart;
  }
  return `${filePart}, ${row.commits_last_4w.toLocaleString('en-US')} commits/4w`;
}

function errorRow(row: RepoListRow, message: string): RepoSizedRow {
  return {
    full_name: row.full_name,
    default_branch: row.default_branch,
    size_kb: row.size_kb,
    pushed_at: row.pushed_at,
    note: row.note,
    commit_sha: '',
    total_files: -1,
    excluded_global: -1,
    excluded_repo: -1,
    counted_files: -1,
    truncated: false,
    has_damsecure_ignore: false,
    damsecure_ignore_lines: 0,
    last_commit_at: '',
    commits_last_4w: -1,
    commits_last_13w: -1,
    commits_last_52w: -1,
    committers_last_4w: -1,
    committers_last_13w: -1,
    committers_last_52w: -1,
    top_contributors: '',
    activity_unavailable: true,
    error: message,
  };
}

/**
 * Convenience for cli.ts: write the rendered output to disk if `--output`
 * was supplied. Returns nothing; caller has the result already.
 */
export async function writeSizeOutput(
  options: { output?: string },
  rendered: string
): Promise<void> {
  if (!options.output) return;
  await writeFile(options.output, rendered, 'utf8');
}

/**
 * `size` command pipeline.
 *
 *   parse args                           →  preflight (token, git, redactor)
 *   if --from <csv>: readListCsv(...)    →  in-memory list rows
 *   else:           runListCommand(...)  →  in-memory list rows
 *   filter by included= (after edit)     →  pLimit(5) per repo:
 *                                              partialClone
 *                                              analyseFiles
 *                                              analyseActivity (skipped if --no-activity)
 *                                              releaseRepo (always)
 *   render to --format (csv | json | table)
 *
 * Concurrency default = 5 (decision D5). Per-repo `try/finally` cleanup. The
 * workspace is destroyed on success, on error, and on SIGINT/SIGTERM.
 */

import { readFile, writeFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import { simpleGit } from 'simple-git';
import { preflight } from '../preflight.js';
import { createEnumerator, parseScope } from '../scm/factory.js';
import {
  defaultIncluded,
  type RepoListing,
  type ScmEnumerator,
  type ScmScope,
} from '../scm/types.js';
import { listingToRow } from './list.js';
import {
  readListCsv,
  writeSizedCsv,
  type RepoListRow,
  type RepoSizedRow,
} from '../reporting/csv.js';
import { renderSizedTable } from '../reporting/table.js';
import { renderSizedJson } from '../reporting/json.js';
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

const DEFAULT_CONCURRENCY = 5;
const VERSION = '0.1.0';

export type SizeOutputFormat = 'csv' | 'json' | 'table';

export interface SizeCommandOptions {
  /** Source: list CSV or auto-enumerate. EXACTLY ONE of these is required. */
  from?: string;
  scope?: string;

  token?: string;
  output?: string;
  format?: SizeOutputFormat;
  concurrency?: number;
  noActivity?: boolean;

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

  /**
   * Pre-computed list rows to size, instead of enumerating via --scope/--from.
   *
   * When set, the enumeration step is skipped entirely and these rows are
   * used directly (after the standard `included=true` filter). Required to
   * be paired with {@link listingsOverride} so per-repo clone URLs are
   * resolvable without a fresh round-trip to the SCM.
   *
   * Used by `runAllCommand` to hand its already-enumerated rows (post
   * interactive deselect, if any) into the size pipeline, avoiding the
   * double-enumeration + double-render bug. Mutually exclusive with
   * `from` and `scope`.
   */
  listRowsOverride?: RepoListRow[];
  /**
   * Pre-computed clone listings for the rows in {@link listRowsOverride},
   * keyed by `fullName`. Required when `listRowsOverride` is set.
   */
  listingsOverride?: Map<string, RepoListing>;
}

export interface SizeCommandResult {
  rows: RepoSizedRow[];
  /** Rendered output (CSV/JSON/table) — what was written to --output or stdout. */
  output: string;
}

export async function runSizeCommand(
  options: SizeCommandOptions
): Promise<SizeCommandResult> {
  // The override path is used by `runAllCommand` to hand a pre-enumerated
  // (and possibly interactively-deselected) row set straight into sizing
  // without touching the SCM again. Validate up-front so misuse fails loud
  // before we burn a preflight or a network call.
  const hasRowsOverride = options.listRowsOverride !== undefined;
  const hasListingsOverride = options.listingsOverride !== undefined;
  if (hasRowsOverride !== hasListingsOverride) {
    throw new Error(
      'size: listRowsOverride and listingsOverride must be supplied together.'
    );
  }
  if (hasRowsOverride && (options.from || options.scope)) {
    throw new Error(
      'size: listRowsOverride is mutually exclusive with --from and --scope.'
    );
  }
  if (!hasRowsOverride && !options.from && !options.scope) {
    throw new Error('size: provide either --from <csv> or --scope <spec>.');
  }
  if (options.from && options.scope) {
    throw new Error('size: --from and --scope are mutually exclusive.');
  }

  const { token } = await preflight({ tokenFlag: options.token });

  // 1. Resolve list rows.
  let listRows: RepoListRow[];
  let listingsByName: Map<string, RepoListing> = new Map();
  if (hasRowsOverride) {
    // Pre-enumerated path: caller already did the SCM round-trip and (in
    // the `all --interactive` case) applied the user's deselections. Use
    // the supplied rows verbatim — re-enumerating here would clobber the
    // `included=` edits and double the work.
    listRows = options.listRowsOverride!;
    listingsByName = options.listingsOverride!;
  } else if (options.from) {
    const csv = await readFile(options.from, 'utf8');
    listRows = readListCsv(csv);
    // We don't have RepoListing for --from; we'll need to enumerate to get
    // cloneUrl. That defeats "cheap" — but it's required because the CSV
    // doesn't (and shouldn't) carry an authenticated clone URL.
    const scopeFromRows = inferScopeFromListRows(listRows);
    listingsByName = await freshEnumerationByName(
      scopeFromRows,
      token,
      options.includeArchived ?? true,
      options.includeForks ?? true
    );
  } else {
    const scope = parseScope(options.scope!);
    const enumerator = createEnumerator(scope, token);
    const repos = await enumerator.enumerate(scope, {
      includeArchived: options.includeArchived ?? true,
      includeForks: options.includeForks ?? true,
    });
    listingsByName = new Map(repos.map((r) => [r.fullName, r]));
    listRows = repos
      .map(listingToRow)
      .filter((r) => {
        if (!options.includeArchived && r.is_archived) return false;
        if (!options.includeForks && r.is_fork) return false;
        return true;
      });
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
    case 'json':
      output = renderSizedJson(rows, {
        generatorVersion: VERSION,
        now: options.now,
      });
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
  if (outputPath.endsWith('.json')) return 'json';
  return 'csv';
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
    // Single-line variant for the progress sink so multi-line git fatals
    // don't blow out the terminal — the full message still lands in the
    // CSV's `error` column.
    const oneLine = message.split('\n')[0].slice(0, 120);
    return reportDone(errorRow(row, message), `ERROR: ${oneLine}`);
  } finally {
    await workspace.releaseRepo(repoDir);
  }
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
 * When `size --from <csv>` is used, the CSV doesn't carry clone URLs, so we
 * must re-enumerate. We assume all rows belong to the same GitHub
 * org/user (true today; v2 might widen this).
 *
 * Heuristic: take the first row's `full_name` owner as the org name. If the
 * CSV mixes orgs, the customer is on their own — they can split the file.
 */
function inferScopeFromListRows(rows: readonly RepoListRow[]): ScmScope {
  if (rows.length === 0) {
    throw new Error('Cannot infer scope from an empty list CSV.');
  }
  const owners = new Set(rows.map((r) => r.full_name.split('/')[0]));
  if (owners.size > 1) {
    throw new Error(
      `--from CSV mixes multiple owners (${[...owners].join(', ')}). Run with one --from per owner, or split the CSV.`
    );
  }
  const owner = [...owners][0];
  return { provider: 'github', type: 'org', name: owner };
}

async function freshEnumerationByName(
  scope: ScmScope,
  token: string,
  includeArchived: boolean,
  includeForks: boolean
): Promise<Map<string, RepoListing>> {
  const enumerator: ScmEnumerator = createEnumerator(scope, token);
  try {
    const repos = await enumerator.enumerate(scope, {
      includeArchived,
      includeForks,
    });
    return new Map(repos.map((r) => [r.fullName, r]));
  } catch (err) {
    // If the scope happens to be a user — fall back: try `user` enumerator.
    if (scope.provider === 'github' && scope.type === 'org') {
      const userScope: ScmScope = { provider: 'github', type: 'user' };
      const userEnumerator = createEnumerator(userScope, token);
      const repos = await userEnumerator.enumerate(userScope, {
        includeArchived,
        includeForks,
      });
      return new Map(repos.map((r) => [r.fullName, r]));
    }
    throw err;
  }
}

/**
 * Re-export so `runAllCommand` can call this without re-implementing
 * defaulting logic.
 */
export { defaultIncluded };

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

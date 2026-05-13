/**
 * `list` command pipeline.
 *
 *   parse args  →  preflight (token, git, redactor)
 *               →  enumerate repos via SCM
 *               →  classify default `included=` per decision D-B
 *               →  writeListCsv to stdout
 *
 * No clones, no tree fetches, no contents — cheap and fast even on 5k repos.
 */

import { preflight } from '../preflight.js';
import { createEnumerator, parseScope } from '../scm/factory.js';
import { defaultIncluded, type RepoListing } from '../scm/types.js';
import { writeListCsv, type RepoListRow } from '../reporting/csv.js';

export interface ListCommandOptions {
  scope: string;
  token?: string;
  /** When true, archived repos are still ENUMERATED but `included=false` by default. */
  includeArchived?: boolean;
  /** When true, fork repos are still ENUMERATED but `included=false` by default. */
  includeForks?: boolean;
}

export interface ListCommandResult {
  rows: RepoListRow[];
  csv: string;
}

export function listingToRow(repo: RepoListing): RepoListRow {
  return {
    full_name: repo.fullName,
    default_branch: repo.defaultBranch,
    size_kb: repo.sizeKb,
    pushed_at: repo.pushedAt,
    is_archived: repo.isArchived,
    is_fork: repo.isFork,
    is_empty: repo.isEmpty,
    included: defaultIncluded(repo),
    note: '',
  };
}

export async function runListCommand(
  options: ListCommandOptions
): Promise<ListCommandResult> {
  const { token } = await preflight({ tokenFlag: options.token });
  const scope = parseScope(options.scope);
  const enumerator = createEnumerator(scope, token);

  const repos = await enumerator.enumerate(scope, {
    // Default to enumerating everything; the CSV's `included=` column
    // is how archived/fork get communicated to the buyer.
    includeArchived: true,
    includeForks: true,
  });

  const rows = repos.map(listingToRow);

  // If the caller asked us to drop archived/fork entirely (rather than show
  // them as included=false), apply that filter here.
  const filtered = rows.filter((r) => {
    if (!options.includeArchived && r.is_archived) return false;
    if (!options.includeForks && r.is_fork) return false;
    return true;
  });

  const csv = writeListCsv(filtered);

  process.stdout.write(csv);
  if (!csv.endsWith('\n')) process.stdout.write('\n');

  return { rows: filtered, csv };
}

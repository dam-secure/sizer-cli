/**
 * `all` command — convenience: list (in-memory) → optional interactive
 * deselect → size. No intermediate CSV file is written unless `--output` is
 * set.
 *
 * Decision D-A: `all` is non-interactive by default; pass `--interactive`
 * to add the checkbox prompt between list and size.
 *
 * Orchestration contract: the enumeration done here is the ONLY enumeration
 * for this run. We hand the resulting rows + clone listings into
 * `runSizeCommand` via its `listRowsOverride` / `listingsOverride` fields,
 * so `size` skips its own `--scope` enumeration. That means a single render
 * path inside `runSizeCommand`, and (critically) interactive deselections
 * are honoured rather than silently rebuilt from `defaultIncluded()`.
 */

import { preflight } from '../preflight.js';
import { createEnumerator, parseScope } from '../scm/factory.js';
import { interactiveDeselect } from '../filtering/interactive.js';
import { listingToRow } from './list.js';
import { runSizeCommand, type SizeOutputFormat } from './size.js';
import type { RepoListRow } from '../reporting/csv.js';
import type { RepoListing } from '../scm/types.js';

export interface AllCommandOptions {
  scope: string;
  token?: string;
  output?: string;
  format?: SizeOutputFormat;
  concurrency?: number;
  noActivity?: boolean;
  quiet?: boolean;
  interactive?: boolean;
  includeArchived?: boolean;
  includeForks?: boolean;
}

export async function runAllCommand(options: AllCommandOptions): Promise<void> {
  const { token } = await preflight({ tokenFlag: options.token });
  const scope = parseScope(options.scope);
  const enumerator = createEnumerator(scope, token);

  const repos = await enumerator.enumerate(scope, {
    includeArchived: options.includeArchived ?? true,
    includeForks: options.includeForks ?? true,
  });
  let rows: RepoListRow[] = repos
    .map(listingToRow)
    .filter((r) => {
      if (!options.includeArchived && r.is_archived) return false;
      if (!options.includeForks && r.is_fork) return false;
      return true;
    });

  if (options.interactive) {
    rows = await interactiveDeselect(rows);
  }

  const listingsByName: Map<string, RepoListing> = new Map(
    repos.map((r) => [r.fullName, r])
  );

  // Hand the in-memory rows + listings straight to size — no second
  // enumeration, no second render. `runSizeCommand` writes to --output or
  // stdout itself, so we don't post-process here.
  await runSizeCommand({
    listRowsOverride: rows,
    listingsOverride: listingsByName,
    token: options.token,
    output: options.output,
    format: options.format,
    concurrency: options.concurrency,
    noActivity: options.noActivity,
    quiet: options.quiet,
    includeArchived: options.includeArchived,
    includeForks: options.includeForks,
  });
}

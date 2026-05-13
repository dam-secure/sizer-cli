/**
 * Interactive deselect prompt for `all --interactive`. Shown after `list` and
 * before `size`, lets the buyer remove repos they don't want measured
 * (decision D-A in the plan).
 *
 * Default selection mirrors the `included=` column already on the list rows.
 */

import { checkbox } from '@inquirer/prompts';
import type { RepoListRow } from '../reporting/csv.js';

export interface InteractiveDeselectOptions {
  /** Override the prompt for tests. */
  promptCheckbox?: typeof checkbox;
}

/**
 * Prompt the user to confirm which repos to size. Returns a NEW array of
 * `RepoListRow` with `included` updated; the input is not mutated.
 */
export async function interactiveDeselect(
  rows: readonly RepoListRow[],
  options: InteractiveDeselectOptions = {}
): Promise<RepoListRow[]> {
  if (rows.length === 0) return [];
  const prompt = options.promptCheckbox ?? checkbox;

  const selectedNames = await prompt({
    message:
      'Select repositories to size (space toggles, enter confirms; defaults match the `included` column):',
    choices: rows.map((r) => ({
      name: `${r.full_name}  (${formatBadges(r)}${r.size_kb} KB)`,
      value: r.full_name,
      checked: r.included,
    })),
    pageSize: 20,
  });

  const selected = new Set(selectedNames);
  return rows.map((r) => ({ ...r, included: selected.has(r.full_name) }));
}

function formatBadges(r: RepoListRow): string {
  const tags: string[] = [];
  if (r.is_archived) tags.push('archived');
  if (r.is_fork) tags.push('fork');
  if (r.is_empty) tags.push('empty');
  if (tags.length === 0) return '';
  return `${tags.join(',')}; `;
}

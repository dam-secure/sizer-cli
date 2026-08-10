/**
 * Interactive deselect prompt for `all --interactive`. Shown after `list` and
 * before `size`, lets the buyer remove repos they don't want measured
 * (decision D-A in the plan).
 *
 * Only repos that are already `included=true` appear in the prompt (active
 * non-archived / non-fork / non-empty by default). Archived, forks, and empty
 * repos stay excluded and are omitted so checkbox invert (`i`) cannot
 * accidentally select them.
 */

import { checkbox } from '@inquirer/prompts';
import type { RepoListRow } from '../reporting/csv.js';

export interface InteractiveDeselectOptions {
  /** Override the prompt for tests. */
  promptCheckbox?: typeof checkbox;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
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
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;

  assertInteractiveTty(input, output);

  // Only default-included repos are choosable. Leaving archived/fork/empty in
  // the list (unchecked) makes Inquirer's invert select exactly those.
  const choosable = [...rows]
    .filter((r) => r.included)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  if (choosable.length === 0) {
    return rows.map((r) => ({ ...r, included: false }));
  }

  const choices = choosable.map((r) => ({
    name: `${r.full_name}  (${formatBadges(r)}${r.size_kb} KB)`,
    value: r.full_name,
    checked: true,
  }));

  const selectedNames = await prompt({
    message:
      'Select repositories to size (space toggles, `i` inverts, enter confirms). Archived/fork/empty repos are omitted and stay excluded:',
    choices,
    pageSize: 20,
    loop: false,
  }, {
    input,
    output,
  });

  const selected = new Set(selectedNames);
  return rows.map((r) => ({
    ...r,
    // Non-choosable rows (archived/fork/empty) remain excluded.
    included: r.included && selected.has(r.full_name),
  }));
}

function assertInteractiveTty(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream
): void {
  if (input.isTTY && output.isTTY) return;

  throw new Error(
    'Interactive mode requires a TTY. When running with Docker, use `docker run --rm -it ...`; otherwise omit --interactive or use --ignore-repos.'
  );
}

function formatBadges(r: RepoListRow): string {
  const tags: string[] = [];
  if (r.is_archived) tags.push('archived');
  if (r.is_fork) tags.push('fork');
  if (r.is_empty) tags.push('empty');
  if (tags.length === 0) return '';
  return `${tags.join(',')}; `;
}

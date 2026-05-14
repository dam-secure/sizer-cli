import { checkbox } from '@inquirer/prompts';
import { describe, expect, it, vi } from 'vitest';

import { interactiveDeselect } from '../filtering/interactive.js';
import type { RepoListRow } from '../reporting/csv.js';

const rows: RepoListRow[] = [
  {
    full_name: 'acme/api',
    default_branch: 'main',
    size_kb: 123,
    pushed_at: '',
    is_archived: false,
    is_fork: false,
    is_empty: false,
    included: true,
    note: '',
  },
  {
    full_name: 'acme/archive',
    default_branch: 'main',
    size_kb: 45,
    pushed_at: '',
    is_archived: true,
    is_fork: false,
    is_empty: false,
    included: false,
    note: '',
  },
];

function fakePrompt(selected: string[] = []): typeof checkbox {
  return vi.fn(async () => selected) as unknown as typeof checkbox;
}

function fakeInput(isTTY: boolean): NodeJS.ReadStream {
  return { isTTY } as NodeJS.ReadStream;
}

function fakeOutput(isTTY: boolean): NodeJS.WriteStream {
  return { isTTY } as NodeJS.WriteStream;
}

describe('interactiveDeselect', () => {
  it('requires an interactive TTY before prompting', async () => {
    const promptCheckbox = fakePrompt(['acme/api']);

    await expect(
      interactiveDeselect(rows, {
        promptCheckbox,
        input: fakeInput(false),
        output: fakeOutput(true),
      })
    ).rejects.toThrow(/docker run --rm -it/);
    expect(promptCheckbox).not.toHaveBeenCalled();
  });

  it('uses stderr for prompt output and mirrors included defaults', async () => {
    const input = fakeInput(true);
    const output = fakeOutput(true);
    const promptCheckbox = fakePrompt(['acme/archive']);

    const result = await interactiveDeselect(rows, {
      promptCheckbox,
      input,
      output,
    });

    expect(promptCheckbox).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: [
          expect.objectContaining({
            value: 'acme/api',
            checked: true,
          }),
          expect.objectContaining({
            name: 'acme/archive  (archived; 45 KB)',
            value: 'acme/archive',
            checked: false,
          }),
        ],
      }),
      { input, output }
    );
    expect(result.map((r) => [r.full_name, r.included])).toEqual([
      ['acme/api', false],
      ['acme/archive', true],
    ]);
  });
});

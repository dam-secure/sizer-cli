import { checkbox } from '@inquirer/prompts';
import { describe, expect, it, vi } from 'vitest';

import { interactiveDeselect } from '../filtering/interactive.js';
import type { RepoListRow } from '../reporting/csv.js';

const rows: RepoListRow[] = [
  {
    full_name: 'acme/z-api',
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
    full_name: 'acme/a-web',
    default_branch: 'main',
    size_kb: 67,
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
  {
    full_name: 'acme/forked',
    default_branch: 'main',
    size_kb: 10,
    pushed_at: '',
    is_archived: false,
    is_fork: true,
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
    const promptCheckbox = fakePrompt(['acme/z-api']);

    await expect(
      interactiveDeselect(rows, {
        promptCheckbox,
        input: fakeInput(false),
        output: fakeOutput(true),
      })
    ).rejects.toThrow(/docker run --rm -it/);
    expect(promptCheckbox).not.toHaveBeenCalled();
  });

  it('omits archived/fork defaults so invert cannot select them', async () => {
    const input = fakeInput(true);
    const output = fakeOutput(true);
    // Simulate invert: none of the (previously checked) active repos selected.
    const promptCheckbox = fakePrompt([]);

    const result = await interactiveDeselect(rows, {
      promptCheckbox,
      input,
      output,
    });

    expect(promptCheckbox).toHaveBeenCalledWith(
      expect.objectContaining({
        loop: false,
        pageSize: 20,
        choices: [
          expect.objectContaining({
            value: 'acme/a-web',
            checked: true,
          }),
          expect.objectContaining({
            value: 'acme/z-api',
            checked: true,
          }),
        ],
      }),
      { input, output }
    );
    // Archived/fork never appear as choices and stay excluded.
    const choiceValues = (
      vi.mocked(promptCheckbox).mock.calls[0][0] as {
        choices: Array<{ value: string }>;
      }
    ).choices.map((c) => c.value);
    expect(choiceValues).not.toContain('acme/archive');
    expect(choiceValues).not.toContain('acme/forked');

    expect(result.map((r) => [r.full_name, r.included])).toEqual([
      ['acme/z-api', false],
      ['acme/a-web', false],
      ['acme/archive', false],
      ['acme/forked', false],
    ]);
  });

  it('keeps selected active repos included', async () => {
    const result = await interactiveDeselect(rows, {
      promptCheckbox: fakePrompt(['acme/a-web']),
      input: fakeInput(true),
      output: fakeOutput(true),
    });

    expect(result.map((r) => [r.full_name, r.included])).toEqual([
      ['acme/z-api', false],
      ['acme/a-web', true],
      ['acme/archive', false],
      ['acme/forked', false],
    ]);
  });
});

/**
 * CLI surface smoke tests — assert commander wiring, not behaviour.
 *
 * Behaviour is covered by the per-command tests; what we want to pin here is
 * that `--help` works, that the three subcommands exist, and that flag names
 * stay stable.
 */

import { describe, expect, it } from 'vitest';
import { makeProgram } from '../cli.js';

describe('makeProgram (commander wiring)', () => {
  it('declares list / size / all subcommands', () => {
    const program = makeProgram();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['all', 'list', 'size']);
  });

  it('list requires --scope', () => {
    const program = makeProgram();
    const list = program.commands.find((c) => c.name() === 'list')!;
    const opts = list.options;
    const scopeOpt = opts.find((o) => o.long === '--scope')!;
    expect(scopeOpt).toBeDefined();
    expect(scopeOpt.required).toBe(true);
  });

  it('size has --from and --scope as optional, --no-activity wired up', () => {
    const program = makeProgram();
    const size = program.commands.find((c) => c.name() === 'size')!;
    const longs = size.options.map((o) => o.long);
    expect(longs).toContain('--from');
    expect(longs).toContain('--scope');
    expect(longs).toContain('--no-activity');
    expect(longs).toContain('--format');
    expect(longs).toContain('--concurrency');
  });

  it('all has --interactive', () => {
    const program = makeProgram();
    const all = program.commands.find((c) => c.name() === 'all')!;
    const longs = all.options.map((o) => o.long);
    expect(longs).toContain('--interactive');
    expect(longs).toContain('--scope');
  });

  it('renders help text for the root command', () => {
    const program = makeProgram();
    const help = program.helpInformation();
    expect(help).toContain('damsecure-sizer');
    expect(help).toContain('list');
    expect(help).toContain('size');
    expect(help).toContain('all');
  });

  it('--format choices are csv | json | table on size', () => {
    const program = makeProgram();
    const size = program.commands.find((c) => c.name() === 'size')!;
    const fmt = size.options.find((o) => o.long === '--format')!;
    expect(fmt.argChoices?.sort()).toEqual(['csv', 'json', 'table']);
  });
});

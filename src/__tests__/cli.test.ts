/**
 * CLI surface smoke tests — assert commander wiring, not behaviour.
 *
 * Behaviour is covered by the command tests; what we want to pin here is that
 * `--help` works and the root-command flag names stay stable.
 */

import { describe, expect, it } from 'vitest';
import { makeProgram } from '../cli.js';

describe('makeProgram (commander wiring)', () => {
  it('declares no subcommands', () => {
    const program = makeProgram();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual([]);
  });

  it('root command accepts optional --scope', () => {
    const program = makeProgram();
    const opts = program.options;
    const scopeOpt = opts.find((o) => o.long === '--scope')!;
    expect(scopeOpt).toBeDefined();
    expect(scopeOpt.mandatory).toBe(false);
  });

  it('root command wires sizing and inspection options', () => {
    const program = makeProgram();
    const longs = program.options.map((o) => o.long);
    expect(longs).toContain('--scope');
    expect(longs).toContain('--list-only');
    expect(longs).toContain('--no-activity');
    expect(longs).toContain('--format');
    expect(longs).toContain('--concurrency');
    expect(longs).toContain('--interactive');
    expect(longs).toContain('--ignore-repos');
    expect(longs).not.toContain('--from');
  });

  it('renders help text for the root command', () => {
    const program = makeProgram();
    const help = program.helpInformation();
    expect(help).toContain('damsecure-sizer');
    expect(help).toContain('--list-only');
    expect(help).toContain('--ignore-repos');
    expect(help).not.toContain('Commands:');
  });

  it('--format choices are csv | table on the root command', () => {
    const program = makeProgram();
    const fmt = program.options.find((o) => o.long === '--format')!;
    expect(fmt.argChoices?.sort()).toEqual(['csv', 'table']);
  });
});

#!/usr/bin/env node
// Suppress Node's DEP0040 (punycode) deprecation warning, emitted at
// import time by a transitive dep (likely Octokit / simple-git). The
// api/worker packages use NODE_OPTIONS='--disable-warning=DEP0040' on
// their npm scripts (mirrored on our dev/test scripts in package.json);
// we also need a runtime filter that travels with the compiled
// `dist/cli.js` and Bun static-binary install paths. Targets DEP0040 by
// code — every other warning still surfaces via the saved default
// listeners. Must run before any imports so the filter is installed
// before transitive deps trigger the warning at load time.
const defaultWarningListeners = process.listeners('warning');
for (const listener of defaultWarningListeners) {
  process.removeListener('warning', listener);
}
process.on('warning', (warning) => {
  if ((warning as Error & { code?: string }).code === 'DEP0040') return;
  for (const listener of defaultWarningListeners) listener(warning);
});

/**
 * @damsecure/sizer entry point — registers the `list`, `size`, and `all`
 * subcommands. Each subcommand calls `preflight` to install the log
 * redactor and resolve the token before doing anything else.
 *
 * Friendly errors: any thrown `Error` reaches the caller via commander; we
 * wrap the top level in a small `try/catch` to print a concise message and
 * a non-zero exit code, suppressing stack traces unless `--debug` is set.
 */

import { Command, Option } from 'commander';
import { runListCommand } from './commands/list.js';
import { runSizeCommand } from './commands/size.js';
import { runAllCommand } from './commands/all.js';
import { enableDebugLog } from './debugLog.js';

const VERSION = '0.1.0';

function makeProgram(): Command {
  const program = new Command();
  program
    .name('damsecure-sizer')
    .description(
      'Produce a sizing + activity fact sheet for your repositories that Dam Secure can quote against — without giving us access to your code. No pricing logic; the output CSV is the deliverable.'
    )
    .version(VERSION)
    // Top-level --debug: enables stderr emission of caught-and-suppressed
    // errors via debugLog(), AND prints the stack of any thrown error in
    // the top-level catch below. Off by default — Rule 3 requires we never
    // leak internal details to a user who didn't ask.
    .option('--debug', 'verbose error output to stderr (caught error details + stack traces)', false)
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts() as { debug?: boolean };
      if (opts.debug) enableDebugLog();
    });

  // ----- list -----
  program
    .command('list')
    .description('Enumerate a GitHub org/user\'s repos and write an editable list CSV.')
    .requiredOption(
      '-s, --scope <spec>',
      '"org=acme" or "user" (or "github:org=acme" explicitly)'
    )
    .option('-t, --token <pat>', 'GitHub PAT (or env DAMSECURE_SIZER_GITHUB_TOKEN)')
    .option('-o, --output <path>', 'write CSV to this file (default: stdout)')
    .option('--include-archived', 'enumerate archived repos as included=false (default true)', true)
    .option('--no-include-archived', 'drop archived repos from the list entirely')
    .option('--include-forks', 'enumerate fork repos as included=false (default true)', true)
    .option('--no-include-forks', 'drop fork repos from the list entirely')
    .action(async (opts) => {
      await runListCommand({
        scope: opts.scope,
        token: opts.token,
        output: opts.output,
        includeArchived: opts.includeArchived,
        includeForks: opts.includeForks,
      });
    });

  // ----- size -----
  program
    .command('size')
    .description('Read a list CSV (or auto-enumerate), partial-clone each included repo, and write a sized CSV.')
    .option('-f, --from <path>', 'list CSV produced by `list` (or hand-edited)')
    .option('-s, --scope <spec>', 'auto-enumerate this scope instead of reading --from')
    .option('-t, --token <pat>', 'GitHub PAT (or env DAMSECURE_SIZER_GITHUB_TOKEN)')
    .option('-o, --output <path>', 'write to this file (default: stdout)')
    .addOption(
      new Option('--format <fmt>', 'csv | json | table')
        .choices(['csv', 'json', 'table'])
    )
    .option('--no-activity', 'skip git log calls (sizing only)')
    .option('-c, --concurrency <n>', 'parallel repos (default 5)', (v) => parseInt(v, 10))
    .option('-q, --quiet', 'suppress per-repo progress lines on stderr', false)
    .option('--include-archived', 'enumerate archived repos when --scope is used', true)
    .option('--no-include-archived', 'drop archived repos when --scope is used')
    .option('--include-forks', 'enumerate fork repos when --scope is used', true)
    .option('--no-include-forks', 'drop fork repos when --scope is used')
    .action(async (opts) => {
      await runSizeCommand({
        from: opts.from,
        scope: opts.scope,
        token: opts.token,
        output: opts.output,
        format: opts.format,
        concurrency: opts.concurrency,
        noActivity: opts.activity === false,
        quiet: opts.quiet,
        includeArchived: opts.includeArchived,
        includeForks: opts.includeForks,
      });
    });

  // ----- all -----
  program
    .command('all')
    .description('Convenience: list + size in one shot. Add --interactive to deselect repos between the two steps.')
    .requiredOption('-s, --scope <spec>', '"org=acme" or "user"')
    .option('-t, --token <pat>', 'GitHub PAT (or env DAMSECURE_SIZER_GITHUB_TOKEN)')
    .option('-o, --output <path>', 'write to this file (default: stdout)')
    .addOption(
      new Option('--format <fmt>', 'csv | json | table')
        .choices(['csv', 'json', 'table'])
    )
    .option('-i, --interactive', 'show a checkbox prompt to deselect repos before sizing', false)
    .option('--no-activity', 'skip git log calls (sizing only)')
    .option('-c, --concurrency <n>', 'parallel repos (default 5)', (v) => parseInt(v, 10))
    .option('-q, --quiet', 'suppress per-repo progress lines on stderr', false)
    .option('--include-archived', 'enumerate archived repos', true)
    .option('--no-include-archived', 'drop archived repos')
    .option('--include-forks', 'enumerate fork repos', true)
    .option('--no-include-forks', 'drop fork repos')
    .action(async (opts) => {
      await runAllCommand({
        scope: opts.scope,
        token: opts.token,
        output: opts.output,
        format: opts.format,
        concurrency: opts.concurrency,
        noActivity: opts.activity === false,
        quiet: opts.quiet,
        interactive: opts.interactive,
        includeArchived: opts.includeArchived,
        includeForks: opts.includeForks,
      });
    });

  return program;
}

async function main(argv: string[]): Promise<void> {
  // We check for --debug here too so the early-throw path (e.g., commander
  // failing to parse args before the preAction hook fires) still honours it.
  const debug = argv.includes('--debug');
  if (debug) enableDebugLog();

  const program = makeProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`damsecure-sizer: ${message}\n`);
    if (debug && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exitCode = 1;
  }
}

// Only run when invoked directly (lets tests import the program lazily).
const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith('cli.ts') ||
    process.argv[1].endsWith('cli.js') ||
    process.argv[1].endsWith('damsecure-sizer'));
if (isDirect) {
  void main(process.argv);
}

export { makeProgram, main };

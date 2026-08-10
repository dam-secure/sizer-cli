#!/usr/bin/env node
// Suppress Node's DEP0040 (punycode) deprecation warning, emitted at
// import time by a transitive dep (likely Octokit / simple-git). The
// api/worker packages use NODE_OPTIONS='--disable-warning=DEP0040' on
// their npm scripts (mirrored on our dev/test scripts in package.json);
// we also need a runtime filter that travels with the compiled
// `dist/cli.js` and Docker install paths. Targets DEP0040 by
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
 * @damsecure/sizer entry point. The root command sizes repos by default;
 * pass `--list-only` to enumerate and print the list CSV without cloning.
 * Command handlers call `preflight` to install the log redactor and resolve
 * the token before doing anything else.
 *
 * Friendly errors: any thrown `Error` reaches the caller via commander; we
 * wrap the top level in a small `try/catch` to print a concise message and
 * a non-zero exit code, suppressing stack traces unless `--debug` is set.
 */

import { Command, Option } from 'commander';
import { runListCommand } from './commands/list.js';
import { runSizeCommand } from './commands/size.js';
import { enableDebugLog } from './debugLog.js';

const VERSION = '0.1.0';

function makeProgram(): Command {
  const program = new Command();
  program
    .name('damsecure-sizer')
    .description(
      'Produce a pull-request, file-count, and activity fact sheet for your repositories that Dam Secure can quote against — without giving us access to your code. No pricing logic; the output CSV is the deliverable.'
    )
    .version(VERSION)
    .option(
      '-s, --scope <spec>',
      'GitHub owner/login to include, e.g. "acme" or "john-smith" (default: all visible repos, acme+john-smith)'
    )
    .option('-t, --token <pat>', 'GitHub PAT (or env GHPAT)')
    .option('--list-only', 'enumerate repos and write the list CSV to stdout without cloning', false)
    .option('-o, --output <path>', 'write sizing output to this file (default: stdout)')
    .addOption(
      new Option('--format <fmt>', 'csv | table')
        .choices(['csv', 'table'])
    )
    .option('-i, --interactive', 'show a checkbox prompt to deselect repos before sizing (requires a TTY)', false)
    .option('--ignore-repos <repos>', 'comma-separated owner/repo names to skip before sizing')
    .option('--no-activity', 'skip git log calls (sizing only)')
    .option('-c, --concurrency <n>', 'parallel repos (default 5)', (v) => parseInt(v, 10))
    .option('-q, --quiet', 'suppress per-repo progress lines on stderr', false)
    .option('--include-archived', 'enumerate archived repos as included=false (default true)', true)
    .option('--no-include-archived', 'drop archived repos from enumeration')
    .option('--include-forks', 'enumerate fork repos as included=false (default true)', true)
    .option('--no-include-forks', 'drop fork repos from enumeration')
    // Top-level --debug: enables stderr emission of caught-and-suppressed
    // errors via debugLog(), AND prints the stack of any thrown error in
    // the top-level catch below. Off by default — Rule 3 requires we never
    // leak internal details to a user who didn't ask.
    .option('--debug', 'verbose error output to stderr (caught error details + stack traces)', false)
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts() as { debug?: boolean };
      if (opts.debug) enableDebugLog();
    })
    .action(async (opts) => {
      if (opts.listOnly) {
        await runListCommand({
          scope: opts.scope,
          token: opts.token,
          includeArchived: opts.includeArchived,
          includeForks: opts.includeForks,
        });
        return;
      }

      await runSizeCommand({
        scope: opts.scope,
        token: opts.token,
        output: opts.output,
        format: opts.format,
        concurrency: opts.concurrency,
        noActivity: opts.activity === false,
        quiet: opts.quiet,
        interactive: opts.interactive,
        ignoreRepos: opts.ignoreRepos,
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

function looksLikeNodeStyleArgv(argv: string[]): boolean {
  const script = argv[1] ?? '';
  return (
    script.endsWith('cli.ts') ||
    script.endsWith('cli.js') ||
    script.endsWith('damsecure-sizer')
  );
}

// Only run when invoked directly (lets tests import the program lazily).
const isDirect = looksLikeNodeStyleArgv(process.argv);
if (isDirect) {
  void main(process.argv);
}

export { makeProgram, main };

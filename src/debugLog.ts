/**
 * Debug-log sink (Rule 3 compliance).
 *
 * The CLI presents a friendly one-line message when something goes wrong;
 * underlying errors must be available to the user when they explicitly opt
 * in via `--debug`, but otherwise must NOT leak. This module is the single
 * funnel for that.
 *
 * Use `debugLog(category, err)` at any catch-and-suppress site so the
 * suppression isn't actually silent — `--debug` reveals it. This is what
 * keeps us out of empty-catch territory while still providing soft-fallback
 * behaviour to non-debug users.
 *
 * Calls go through `process.stderr.write`, which the preflight log redactor
 * already wraps — any PAT or authenticated clone URL that leaks through a
 * caught error is automatically scrubbed.
 */

let debugEnabled = false;

export function enableDebugLog(): void {
  debugEnabled = true;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/** Test-only: reset the enabled flag. Not exported via index. */
export function __resetDebugLog(): void {
  debugEnabled = false;
}

/**
 * Log a caught-and-suppressed error to stderr ONLY when `--debug` is set.
 *
 *   try { ... }
 *   catch (err) {
 *     debugLog('analyseActivity.gitLog', err);
 *     return UNAVAILABLE_SUMMARY;
 *   }
 *
 * Format: `[<category>] <message>` (one line). Stack traces are intentionally
 * not included by default — buyers running `--debug` only need enough to
 * file a useful issue. The stack is still available via the top-level
 * `--debug` catch in `cli.ts` for THROWN errors that bubble up.
 */
export function debugLog(category: string, err: unknown): void {
  if (!debugEnabled) return;
  const message = err instanceof Error ? err.message : String(err);
  // Single line; the redactor scrubs any token that leaks through here.
  process.stderr.write(`[${category}] ${message}\n`);
}

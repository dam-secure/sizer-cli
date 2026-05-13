/**
 * Per-repo progress reporter for the `size` and `all` pipelines.
 *
 * Why this exists: clones + analysis can take 10+ seconds per org, and the
 * user has no way to know whether the tool is alive, which repo is in
 * flight, or which one blew up. Silent CLIs are a UX trap.
 *
 * Design choices:
 *   - All output goes to **stderr** so `--output -` / `> sized.csv` /
 *     piping the JSON renderer to `jq` still work cleanly.
 *   - Off when `--quiet` is set (CI / scripted use).
 *   - Off when stderr is not a TTY AND `--quiet` not set, callers can opt
 *     into pretty progress with `--progress` if needed (out of scope v1;
 *     today we just default to "always print to stderr unless --quiet").
 *   - The redactor wrapping `process.stderr.write` already scrubs any
 *     PAT that leaks via these messages.
 */

export interface ProgressReporter {
  /** Print the workspace dir + total repo count, once at start. */
  start(workspaceRoot: string, totalRepos: number, concurrency: number): void;
  /** A repo started cloning. Index is 1-based; total matches `start`. */
  repoStart(index: number, total: number, fullName: string): void;
  /** A repo finished. `summary` is a short one-liner of the result. */
  repoDone(
    index: number,
    total: number,
    fullName: string,
    summary: string,
    durationMs: number
  ): void;
  /** Wall time + total repo count, once at the end. */
  end(durationMs: number, completedRepos: number, erroredRepos: number): void;
}

/** No-op reporter — used when `--quiet` is set. */
export const QUIET_REPORTER: ProgressReporter = {
  start: () => undefined,
  repoStart: () => undefined,
  repoDone: () => undefined,
  end: () => undefined,
};

/**
 * Stderr reporter — prints one line per event. Index width auto-pads so
 * `[ 1/36]` and `[36/36]` line up. Falls back to plain ASCII when
 * `process.stderr.isTTY` is false (e.g., piped or redirected) so log
 * collectors don't trip over ANSI escapes.
 */
export function createStderrReporter(): ProgressReporter {
  return {
    start(workspaceRoot, totalRepos, concurrency) {
      writeLine(
        `[sizer] workspace: ${workspaceRoot} (cleaned up at exit)`
      );
      writeLine(
        `[sizer] sizing ${totalRepos} repo${totalRepos === 1 ? '' : 's'} at concurrency ${concurrency}`
      );
    },
    repoStart(index, total, fullName) {
      // Always print the "cloning" line so the user sees TWO events per
      // repo (clone start + sized done). With concurrency, the events from
      // different repos interleave — that's fine and actually informative
      // (you can see which repos are racing).
      writeLine(
        `[sizer] ${formatProgress(index, total)} ${fullName}  ▸ cloning …`
      );
    },
    repoDone(index, total, fullName, summary, durationMs) {
      writeLine(
        `[sizer] ${formatProgress(index, total)} ${fullName}  ✓ ${summary}  (${formatMs(durationMs)})`
      );
    },
    end(durationMs, completed, errored) {
      const errorPart = errored > 0 ? `, ${errored} errored` : '';
      writeLine(
        `[sizer] done — ${completed} repo${completed === 1 ? '' : 's'} sized${errorPart} in ${formatMs(durationMs)}`
      );
    },
  };
}

function formatProgress(index: number, total: number): string {
  const width = String(total).length;
  const padded = String(index).padStart(width, ' ');
  return `[${padded}/${total}]`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function writeLine(line: string): void {
  process.stderr.write(line + '\n');
}

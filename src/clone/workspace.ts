/**
 * Workspace lifecycle for the sizer's per-repo clones.
 *
 * Layout (decision D2):
 *   ${TMPDIR:-/tmp}/damsecure-sizer-<pid>/<sanitised-repo-name>/
 *
 * Cleanup strategy:
 *   - Per-repo: caller wraps `partialClone` in a try/finally and calls
 *     `releaseRepo()` to drop just that one clone (keeps peak disk to
 *     `concurrency × avg_clone_size`).
 *   - Process-wide: `registerProcessCleanup()` wires `process.on('exit')` +
 *     SIGINT/SIGTERM to nuke the parent dir. Best-effort — a SIGKILL leaks
 *     the dir, which is documented in the README.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let processCleanupRegistered = false;

export interface WorkspaceHandle {
  /** Absolute path to the parent dir, e.g. `/tmp/damsecure-sizer-12345`. */
  rootDir: string;
  /**
   * Reserve a clone directory for a given repo. The returned path is unique
   * within the workspace; if the directory already exists from a prior
   * `reserveRepo` call (e.g., a retry), it is wiped first.
   */
  reserveRepo(repoFullName: string): Promise<string>;
  /** Drop a per-repo clone directory. Always safe to call (best-effort). */
  releaseRepo(repoDir: string): Promise<void>;
  /** Drop the entire workspace (best-effort). Idempotent. */
  destroy(): Promise<void>;
}

/**
 * Create the workspace root and return a handle. Does NOT register process-exit
 * cleanup automatically — call {@link registerProcessCleanup} once at CLI entry
 * if you want SIGINT/SIGTERM handling.
 */
export async function createWorkspace(): Promise<WorkspaceHandle> {
  const rootDir = join(tmpdir(), `damsecure-sizer-${process.pid}`);
  await mkdir(rootDir, { recursive: true });

  let destroyed = false;

  return {
    rootDir,
    async reserveRepo(repoFullName: string): Promise<string> {
      if (destroyed) {
        throw new Error('reserveRepo called on a destroyed workspace');
      }
      const sanitised = sanitiseRepoName(repoFullName);
      const repoDir = join(rootDir, sanitised);
      // If a previous attempt left scaffolding, clear it so the clone has a
      // pristine target.
      await rm(repoDir, { recursive: true, force: true });
      // We deliberately do NOT pre-create the dir — `git clone` requires the
      // target to NOT exist (or to be empty). Caller hands `repoDir` to
      // `partialClone(cloneUrl, repoDir)`.
      return repoDir;
    },
    async releaseRepo(repoDir: string): Promise<void> {
      // Best-effort: ignore not-found, surface other errors as-is.
      await rm(repoDir, { recursive: true, force: true });
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

/**
 * Sanitise a repo's `owner/name` into a single path-safe directory name.
 * Conservative: any character outside `[a-z0-9._-]` is replaced with `_`.
 */
export function sanitiseRepoName(fullName: string): string {
  return fullName.toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
}

/**
 * Wire process-exit signals to clean up the workspace. Idempotent — safe to
 * call more than once; only the first call attaches listeners.
 *
 * Note: `process.on('exit')` runs synchronously, so we use a sync cleanup
 * fallback there. SIGINT/SIGTERM go through the async path first.
 */
export function registerProcessCleanup(workspace: WorkspaceHandle): void {
  if (processCleanupRegistered) return;
  processCleanupRegistered = true;

  // Synchronous best-effort on hard exit. Avoid throwing inside this path.
  const syncCleanup = () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const fs: typeof import('node:fs') = require('node:fs');
      fs.rmSync(workspace.rootDir, { recursive: true, force: true });
    } catch {
      // intentional: best-effort
    }
  };

  process.once('exit', syncCleanup);

  const handleSignal = (signal: NodeJS.Signals) => {
    workspace
      .destroy()
      .catch(() => undefined)
      .finally(() => {
        // Re-emit signal for process default handling so the shell sees the
        // correct exit code.
        process.kill(process.pid, signal);
      });
    // Detach to avoid recursion when the re-emit fires.
    process.removeAllListeners(signal);
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}

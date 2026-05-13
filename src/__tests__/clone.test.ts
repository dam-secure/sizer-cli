/**
 * Partial-clone + workspace lifecycle tests.
 *
 * - The "real partial clone" test seeds a local bare repo and calls
 *   `partialClone` against a `file://` URL — this exercises simple-git +
 *   real `git` end-to-end (no network required).
 * - The fallback path is exercised via `options.runner` injection so we
 *   don't have to actually break the protocol.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { simpleGit } from 'simple-git';
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  stat,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  partialClone,
  looksLikePartialCloneRejection,
} from '../clone/partialClone.js';
import {
  createWorkspace,
  sanitiseRepoName,
} from '../clone/workspace.js';

describe('looksLikePartialCloneRejection', () => {
  it('returns true for known protocol-rejection strings', () => {
    expect(
      looksLikePartialCloneRejection('fatal: filtering not recognized by server')
    ).toBe(true);
    expect(
      looksLikePartialCloneRejection('Server does not support filter')
    ).toBe(true);
    expect(
      looksLikePartialCloneRejection('filter not supported')
    ).toBe(true);
    expect(looksLikePartialCloneRejection('Object filtering: nope')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(looksLikePartialCloneRejection('connection refused')).toBe(false);
    expect(
      looksLikePartialCloneRejection('Authentication failed')
    ).toBe(false);
    expect(
      looksLikePartialCloneRejection('repository not found')
    ).toBe(false);
  });
});

describe('sanitiseRepoName', () => {
  it('replaces unsafe chars with underscores and lowercases', () => {
    expect(sanitiseRepoName('Acme/Repo')).toBe('acme_repo');
    expect(sanitiseRepoName('owner/with spaces')).toBe('owner_with_spaces');
    expect(sanitiseRepoName('orgX/repo-1.0_beta')).toBe('orgx_repo-1.0_beta');
    expect(sanitiseRepoName('owner/has*weird?chars')).toBe('owner_has_weird_chars');
  });
});

describe('createWorkspace + reserveRepo + releaseRepo', () => {
  it('creates a workspace under tmpdir and removes it on destroy', async () => {
    const ws = await createWorkspace();
    expect(ws.rootDir).toMatch(/damsecure-sizer-\d+$/);
    const s = await stat(ws.rootDir);
    expect(s.isDirectory()).toBe(true);

    const reserved = await ws.reserveRepo('acme/api');
    expect(reserved).toBe(`${ws.rootDir}/acme_api`);
    // reserveRepo doesn't create the dir (git clone does); it just clears any
    // pre-existing scaffolding. So the dir should NOT exist now.
    await expect(stat(reserved)).rejects.toThrow();

    await ws.destroy();
    await expect(stat(ws.rootDir)).rejects.toThrow();
  });

  it('reserveRepo wipes any pre-existing directory at the target path', async () => {
    const ws = await createWorkspace();
    const reserved = await ws.reserveRepo('acme/api');
    // Pollute it.
    await mkdir(reserved, { recursive: true });
    await writeFile(join(reserved, 'leftover.txt'), 'old data');

    // Re-reserve: should be wiped before git clone tries to write into it.
    const again = await ws.reserveRepo('acme/api');
    expect(again).toBe(reserved);
    await expect(stat(reserved)).rejects.toThrow();

    await ws.destroy();
  });

  it('releaseRepo is idempotent and ignores missing directories', async () => {
    const ws = await createWorkspace();
    await ws.releaseRepo(join(ws.rootDir, 'never-existed'));
    // No throw is the assertion.
    await ws.destroy();
  });
});

describe('partialClone — real git against a local bare fixture', () => {
  let bareRepoPath: string;
  let workTreePath: string;
  let workspaceRoot: string;

  beforeAll(async () => {
    workTreePath = await mkdtemp(join(tmpdir(), 'sizer-fixture-work-'));
    bareRepoPath = await mkdtemp(join(tmpdir(), 'sizer-fixture-bare-'));
    workspaceRoot = await mkdtemp(join(tmpdir(), 'sizer-fixture-ws-'));

    // Build a real working repo.
    const work = simpleGit(workTreePath);
    await work.init();
    await work.addConfig('user.email', 'sizer-test@example.invalid');
    await work.addConfig('user.name', 'Sizer Test');
    await mkdir(join(workTreePath, 'src'), { recursive: true });
    await writeFile(join(workTreePath, 'README.md'), '# fixture');
    await writeFile(join(workTreePath, 'src', 'a.ts'), 'export const A = 1;');
    await writeFile(join(workTreePath, 'src', 'b.ts'), 'export const B = 2;');
    await work.add('.');
    await work.commit('initial');
    // Force a known branch name so file://-based clones don't depend on the
    // host's init.defaultBranch config.
    await work.raw(['branch', '-M', 'main']);

    // Bare clone for the fixture remote.
    await simpleGit().clone(workTreePath, bareRepoPath, ['--bare']);
  }, 30_000);

  afterAll(async () => {
    await rm(workTreePath, { recursive: true, force: true });
    await rm(bareRepoPath, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('clones with --filter=blob:none --no-checkout and produces a working .git', async () => {
    const dest = join(workspaceRoot, 'first-clone');
    const cloneUrl = `file://${bareRepoPath}`;

    const result = await partialClone(cloneUrl, dest);
    expect(result.usedFullCloneFallback).toBe(false);

    // .git directory must exist
    const gitDir = await stat(join(dest, '.git'));
    expect(gitDir.isDirectory()).toBe(true);

    // --no-checkout means working tree files are absent: 'src/a.ts' should NOT
    // exist as a regular file at the destination root.
    await expect(stat(join(dest, 'src', 'a.ts'))).rejects.toThrow();

    // ls-tree -r HEAD should still list the files (trees are present even with
    // a partial filter).
    const git = result.git;
    const lsTree = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']);
    const files = lsTree.trim().split('\n').sort();
    expect(files).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
  });

  it('cleanup runs even when clone throws (per-repo finally)', async () => {
    const ws = await createWorkspace();
    const dest = await ws.reserveRepo('bad/missing');
    const expectedDir = dest;

    let cleanedUp = false;
    try {
      await partialClone('file:///definitely/not/a/repo', dest);
      throw new Error('expected partialClone to throw');
    } catch (err) {
      // Expected — bad URL.
      expect(err).toBeInstanceOf(Error);
    } finally {
      await ws.releaseRepo(dest);
      cleanedUp = true;
    }
    expect(cleanedUp).toBe(true);
    // releaseRepo should have removed any partial scaffolding.
    await expect(stat(expectedDir)).rejects.toThrow();

    await ws.destroy();
  });
});

describe('partialClone — fallback path (decision D6)', () => {
  it('falls back to a full clone when the partial filter is rejected', async () => {
    const calls: Array<{ partial: boolean; noCheckout: boolean }> = [];
    const warnings: string[] = [];

    const dest = await mkdtemp(join(tmpdir(), 'sizer-fallback-'));
    try {
      const result = await partialClone(
        'https://example.invalid/acme/api.git',
        dest,
        {
          warn: (msg) => warnings.push(msg),
          runner: async (_url, opts) => {
            calls.push({ partial: opts.partialFilter, noCheckout: opts.noCheckout });
            if (opts.partialFilter) {
              throw new Error('fatal: filtering not recognized by server');
            }
            // Real `git clone` would create the dir; mirror that for the fake.
            await mkdir(opts.destination, { recursive: true });
          },
        }
      );

      expect(result.usedFullCloneFallback).toBe(true);
      expect(calls).toEqual([
        { partial: true, noCheckout: true },
        { partial: false, noCheckout: true },
      ]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/falling back to a full clone/i);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('does NOT fall back for unrelated errors', async () => {
    const calls: number[] = [];
    const dest = await mkdtemp(join(tmpdir(), 'sizer-noFallback-'));
    try {
      await expect(
        partialClone('https://example.invalid/acme/api.git', dest, {
          runner: async (_url, _opts) => {
            calls.push(1);
            throw new Error('Authentication failed');
          },
        })
      ).rejects.toThrow(/Authentication failed/);
      expect(calls).toHaveLength(1); // only one attempt, no fallback
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });
});

describe('process cleanup wiring', () => {
  it('does not throw when the workspace is registered for process cleanup', async () => {
    const ws = await createWorkspace();
    // We don't actually trigger a signal (would kill the test process); we
    // just confirm the registration is benign.
    const { registerProcessCleanup } = await import('../clone/workspace.js');
    expect(() => registerProcessCleanup(ws)).not.toThrow();
    // Calling twice is idempotent.
    expect(() => registerProcessCleanup(ws)).not.toThrow();
    await ws.destroy();
  });
});

describe('workspace listing smoke', () => {
  it('reserves multiple repos under a single workspace root', async () => {
    const ws = await createWorkspace();
    await ws.reserveRepo('owner/a');
    // Pre-create both dirs to exercise listing.
    await mkdir(join(ws.rootDir, 'owner_a'), { recursive: true });
    await mkdir(join(ws.rootDir, 'owner_b'), { recursive: true });
    const entries = await readdir(ws.rootDir);
    expect(entries.sort()).toEqual(['owner_a', 'owner_b']);
    await ws.destroy();
  });
});

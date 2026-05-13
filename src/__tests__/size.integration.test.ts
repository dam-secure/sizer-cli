/**
 * End-to-end-ish test for `runSizeCommand`.
 *
 * Strategy: stub out the network (Octokit's repo enumeration) by injecting a
 * fake clone URL pointing at a local bare repo. The size pipeline then
 * partial-clones, runs `analyseFiles` + `analyseActivity`, and writes the
 * sized CSV. This exercises Workspace cleanup, partial clone, file/activity
 * analysis, and CSV emission as a single chain.
 *
 * Note: we intercept the enumerator factory so the test does not need an HTTP
 * mock for Octokit.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseIgnoredRepos, runSizeCommand } from '../commands/size.js';

vi.mock('../scm/factory.js', async (importActual) => {
  const actual: typeof import('../scm/factory.js') = await importActual();
  return {
    ...actual,
    createEnumerator: vi.fn(),
  };
});

import { createEnumerator } from '../scm/factory.js';
import type { ScmEnumerator } from '../scm/types.js';

describe('runSizeCommand — end-to-end against a local bare fixture', () => {
  let bareRepoPath: string;
  let workTreePath: string;

  beforeAll(async () => {
    workTreePath = await mkdtemp(join(tmpdir(), 'sizer-e2e-work-'));
    bareRepoPath = await mkdtemp(join(tmpdir(), 'sizer-e2e-bare-'));

    const git = simpleGit(workTreePath);
    await git.init();
    await git.addConfig('user.email', 'sizer-test@example.invalid');
    await git.addConfig('user.name', 'sizer-test');
    await mkdir(join(workTreePath, 'src'));
    await writeFile(join(workTreePath, 'README.md'), '# e2e');
    await writeFile(join(workTreePath, 'src', 'a.ts'), 'export const A = 1;');
    await writeFile(join(workTreePath, 'logo.png'), 'png-bytes');
    await writeFile(join(workTreePath, '.damsecure-ignore'), 'private/\n');
    await mkdir(join(workTreePath, 'private'));
    await writeFile(join(workTreePath, 'private', 'note.md'), 'private');
    await git.add('.');
    await git.commit('initial');
    await git.raw(['branch', '-M', 'main']);

    await simpleGit().clone(workTreePath, bareRepoPath, ['--bare']);

  }, 60_000);

  afterAll(async () => {
    await rm(workTreePath, { recursive: true, force: true });
    await rm(bareRepoPath, { recursive: true, force: true });
  });

  it('clones, analyses files + activity, and writes a sized CSV to --output', async () => {
    // Inject a fake enumerator that returns the bare-repo file:// URL.
    const fakeEnumerator: ScmEnumerator = {
      enumerate: async () => [
        {
          fullName: 'acme/api',
          cloneUrl: `file://${bareRepoPath}`,
          defaultBranch: 'main',
          sizeKb: 0,
          pushedAt: '',
          isArchived: false,
          isFork: false,
          isEmpty: false,
        },
        {
          fullName: 'acme/ignored',
          cloneUrl: 'file:///does/not/exist',
          defaultBranch: 'main',
          sizeKb: 0,
          pushedAt: '',
          isArchived: false,
          isFork: false,
          isEmpty: false,
        },
      ],
    };
    vi.mocked(createEnumerator).mockReturnValue(fakeEnumerator);

    const outputPath = join(workTreePath, 'sized.csv');
    process.env.GHPAT = 'ghp_fake_for_test';
    const result = await runSizeCommand({
      scope: 'org=acme',
      output: outputPath,
      format: 'csv',
      ignoreRepos: 'acme/ignored',
    });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.full_name).toBe('acme/api');
    expect(row.error).toBe('');
    expect(row.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    // 5 files in the fixture: README.md, src/a.ts, logo.png, .damsecure-ignore, private/note.md
    expect(row.total_files).toBe(5);
    expect(row.excluded_global).toBe(1); // logo.png
    expect(row.excluded_repo).toBe(1); // private/note.md
    expect(row.counted_files).toBe(3); // README.md, src/a.ts, .damsecure-ignore
    expect(row.has_damsecure_ignore).toBe(true);
    expect(row.damsecure_ignore_lines).toBe(1);
    expect(row.activity_unavailable).toBe(false);
    // Activity columns should NOT be -1 since we have 1 commit.
    expect(row.commits_last_52w).toBeGreaterThanOrEqual(1);

    // Sized CSV was written to --output.
    const csvContent = await readFile(outputPath, 'utf8');
    expect(csvContent).toContain('acme/api');
    expect(csvContent).not.toContain('acme/ignored');
    expect(csvContent).toContain('counted_files');
    // No tier / credits columns:
    expect(csvContent).not.toMatch(/\btier\b/i);
    expect(csvContent).not.toMatch(/\bcredits?\b/i);
  }, 60_000);

  it('validates ignored repo names', () => {
    expect(parseIgnoredRepos('acme/api, ACME/Web')).toEqual(
      new Set(['acme/api', 'acme/web'])
    );
    expect(() => parseIgnoredRepos('acme/api,,acme/web')).toThrow(/empty entry/);
    expect(() => parseIgnoredRepos('not-a-full-name')).toThrow(/owner\/repo/);
  });
});

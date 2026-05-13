/**
 * `runAllCommand` orchestration tests.
 *
 * These pin two contracts that, together, define the all → size handoff:
 *
 *  1. The result is rendered EXACTLY ONCE — not once by `size`'s
 *     `finalise()` and again by `all`'s post-hoc filter. (Bug 1.)
 *  2. Interactive deselections from the checkbox prompt are honoured —
 *     the deselected repo is NOT cloned/sized/rendered. (Bug 2.)
 *
 * Both regressions came from `runAllCommand` punting enumeration to
 * `runSizeCommand({ scope })`, which re-enumerated from scratch and
 * re-rendered. The fix wires the in-memory enumeration through the
 * `listRowsOverride` / `listingsOverride` seam instead.
 */

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { simpleGit } from 'simple-git';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the SCM factory so `runAllCommand` and `runSizeCommand` get our
// fake enumerator instead of hitting GitHub. Keep `parseScope` real so
// the `--scope org=acme` parsing path is still exercised.
vi.mock('../scm/factory.js', async (importActual) => {
  const actual: typeof import('../scm/factory.js') = await importActual();
  return { ...actual, createEnumerator: vi.fn() };
});

// Mock the inquirer checkbox so `interactiveDeselect` resolves to a
// fixed set of selections without prompting. Routed through the
// existing `promptCheckbox ?? checkbox` fall-through in
// `interactive.ts` — `runAllCommand` doesn't pass an override, so the
// imported `checkbox` is what gets called.
vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
}));

// Mock fs/promises so we can spy on `rm` (used by `releaseRepo`,
// `reserveRepo`, and `destroy` in workspace.ts) without breaking other
// fs operations. The `rm` mock still calls through to the real
// implementation so cleanup keeps working.
vi.mock('node:fs/promises', async (importActual) => {
  const actual: typeof import('node:fs/promises') = await importActual();
  return { ...actual, rm: vi.fn(actual.rm) };
});

import { runAllCommand } from '../commands/all.js';
import { createEnumerator } from '../scm/factory.js';
import { checkbox } from '@inquirer/prompts';
import { rm as rmMock } from 'node:fs/promises';
import type { ScmEnumerator, RepoListing } from '../scm/types.js';

describe('runAllCommand — orchestration contract with runSizeCommand', () => {
  let bareRepoPath: string;
  let workTreePath: string;
  let cloneUrl: string;

  beforeAll(async () => {
    workTreePath = await mkdtemp(join(tmpdir(), 'sizer-all-work-'));
    bareRepoPath = await mkdtemp(join(tmpdir(), 'sizer-all-bare-'));

    const git = simpleGit(workTreePath);
    await git.init();
    await git.addConfig('user.email', 'sizer-test@example.invalid');
    await git.addConfig('user.name', 'sizer-test');
    await mkdir(join(workTreePath, 'src'));
    await writeFile(join(workTreePath, 'README.md'), '# all-cmd');
    await writeFile(join(workTreePath, 'src', 'a.ts'), 'export const A = 1;');
    await git.add('.');
    await git.commit('initial');
    await git.raw(['branch', '-M', 'main']);

    await simpleGit().clone(workTreePath, bareRepoPath, ['--bare']);
    cloneUrl = `file://${bareRepoPath}`;

    process.env.DAMSECURE_SIZER_GITHUB_TOKEN = 'ghp_fake_for_test';
  }, 60_000);

  afterAll(async () => {
    await rmMock(workTreePath, { recursive: true, force: true });
    await rmMock(bareRepoPath, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(createEnumerator).mockReset();
    vi.mocked(checkbox).mockReset();
    vi.mocked(rmMock).mockClear();
  });

  function makeListing(fullName: string): RepoListing {
    return {
      fullName,
      cloneUrl,
      defaultBranch: 'main',
      sizeKb: 0,
      pushedAt: '',
      isArchived: false,
      isFork: false,
      isEmpty: false,
    };
  }

  // Test A — Bug 1: the result table is rendered EXACTLY ONCE.
  //
  // Pre-fix, runAllCommand called `runSizeCommand({ scope })` without
  // forwarding `--output`/`--format`, so `finalise()` rendered to stdout
  // for it; runAllCommand then re-rendered the same data to stdout again.
  // After the fix, runAllCommand owns no rendering — `runSizeCommand`
  // does it once.
  it('renders the result table exactly once when --format=table and no --output', async () => {
    // One repo is enough to prove the bug: the failing path printed the
    // header once for `finalise()` and a second time for the post-hoc
    // re-render.
    const fakeEnumerator: ScmEnumerator = {
      enumerate: async () => [makeListing('acme/api')],
    };
    vi.mocked(createEnumerator).mockReturnValue(fakeEnumerator);

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        if (typeof chunk === 'string') stdoutChunks.push(chunk);
        else if (Buffer.isBuffer(chunk))
          stdoutChunks.push(chunk.toString('utf8'));
        return true;
      }) as typeof process.stdout.write);

    try {
      await runAllCommand({
        scope: 'org=acme',
        format: 'table',
        quiet: true,
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const captured = stdoutChunks.join('');
    // The header line uniquely identifies a table render — `EXCL_GLOBAL`
    // appears nowhere else in the rendered output, so a regex count is
    // unambiguous. Two renders ⇒ two matches; one render ⇒ one match.
    const headerMatches = captured.match(/REPO\s+FILES\s+EXCL_GLOBAL/g) ?? [];
    expect(
      headerMatches.length,
      `expected exactly one rendered header; captured stdout was:\n${captured}`
    ).toBe(1);
    // Sanity: the row for the one repo should be present.
    expect(captured).toContain('acme/api');
  }, 60_000);

  // Test B — Bug 2: interactive deselections are honoured.
  //
  // Pre-fix, runAllCommand mutated rows in memory but then handed
  // `--scope` to runSizeCommand, which re-enumerated from scratch and
  // recomputed `included=` via `defaultIncluded()`. The post-hoc filter
  // hid the deselected repo from the second render, but the work had
  // already been done (clone + analyse) for it. After the fix, the
  // deselected repo never enters the work pool.
  it('honours interactive deselections — middle repo is not sized or rendered', async () => {
    const fakeEnumerator: ScmEnumerator = {
      enumerate: async () => [
        makeListing('acme/a'),
        makeListing('acme/b'),
        makeListing('acme/c'),
      ],
    };
    vi.mocked(createEnumerator).mockReturnValue(fakeEnumerator);

    // Simulate the user toggling off the middle repo. interactiveDeselect
    // calls checkbox() and uses its return value as the selected names.
    vi.mocked(checkbox).mockResolvedValueOnce(['acme/a', 'acme/c']);

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        if (typeof chunk === 'string') stdoutChunks.push(chunk);
        else if (Buffer.isBuffer(chunk))
          stdoutChunks.push(chunk.toString('utf8'));
        return true;
      }) as typeof process.stdout.write);

    try {
      await runAllCommand({
        scope: 'org=acme',
        format: 'csv',
        interactive: true,
        quiet: true,
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(vi.mocked(checkbox)).toHaveBeenCalledTimes(1);

    const csv = stdoutChunks.join('');
    // The CSV's first column is `full_name`, so `acme/a,` only appears
    // in a data row (never the header).
    expect(csv).toContain('acme/a,');
    expect(csv).toContain('acme/c,');
    // Pre-fix, this expectation failed: deselected repo was sized AND
    // included in `runSizeCommand`'s render before the post-hoc filter
    // clipped it from a SECOND render. The buggy stdout therefore
    // contained `acme/b,`.
    expect(csv).not.toContain('acme/b,');

    // Workspace cleanup: only the two non-deselected repos should ever
    // be reserved + released. The deselected one never enters the work
    // pool, so its sanitised path never appears in any rm call. Both
    // `reserveRepo` (pre-clean) and `releaseRepo` (post-clone) call
    // `rm(repoDir)`, so we expect at least 2 calls per included repo.
    const expectedRoot = join(tmpdir(), `damsecure-sizer-${process.pid}`);
    const aPath = join(expectedRoot, 'acme_a');
    const bPath = join(expectedRoot, 'acme_b');
    const cPath = join(expectedRoot, 'acme_c');
    const rmPaths = vi
      .mocked(rmMock)
      .mock.calls.map((c) => String(c[0] ?? ''));
    expect(rmPaths, `rm calls during run:\n  ${rmPaths.join('\n  ')}`).toEqual(
      expect.arrayContaining([aPath, cPath])
    );
    expect(rmPaths).not.toContain(bPath);
  }, 60_000);
});

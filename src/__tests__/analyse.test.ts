/**
 * Analyse layer tests.
 *
 *  - File analysis: real repo seeded with a `.damsecure-ignore` and assorted
 *    extensions; verify total / excluded_global / excluded_repo / counted /
 *    has_damsecure_ignore / damsecure_ignore_lines + identity invariant.
 *  - Activity analysis (pure summariser): hand-crafted records exercise
 *    window inclusivity, unique committer counting, top-N tie-breaking.
 *  - Activity analysis (integration): real repo with controlled commit
 *    timestamps via `GIT_COMMITTER_DATE` env vars.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  enableDebugLog,
  __resetDebugLog,
} from '../debugLog.js';

const execFileAsync = promisify(execFile);
import { analyseFiles } from '../analyse/files.js';
import {
  analyseActivity,
  summariseActivity,
  parseGitLog,
  formatTopContributors,
  type ActivityRecord,
} from '../analyse/activity.js';

describe('analyseFiles — against a real seeded repo', () => {
  let workTree: string;
  let commitSha: string;

  beforeAll(async () => {
    workTree = await mkdtemp(join(tmpdir(), 'sizer-analyse-'));
    const git = simpleGit(workTree);
    await git.init();
    await git.addConfig('user.email', 'sizer-test@example.invalid');
    await git.addConfig('user.name', 'Sizer Test');

    // Source files (all kept)
    await mkdir(join(workTree, 'src'), { recursive: true });
    await writeFile(join(workTree, 'src', 'a.ts'), 'export const A = 1;');
    await writeFile(join(workTree, 'src', 'b.ts'), 'export const B = 2;');
    await writeFile(join(workTree, 'README.md'), '# repo');

    // Files matched by global ignorefile.txt:
    await mkdir(join(workTree, 'public'), { recursive: true });
    await writeFile(join(workTree, 'public', 'logo.png'), 'png-bytes');
    await writeFile(join(workTree, 'package-lock.json'), '{}');
    await writeFile(join(workTree, 'main.bundle.js'), 'bundle');

    // Files matched by per-repo .damsecure-ignore:
    await mkdir(join(workTree, 'secrets'), { recursive: true });
    await writeFile(join(workTree, 'secrets', 'key.pem'), 'KEY');
    await mkdir(join(workTree, 'private'), { recursive: true });
    await writeFile(join(workTree, 'private', 'note.md'), 'private');

    await writeFile(
      join(workTree, '.damsecure-ignore'),
      ['# repo-specific ignores', '/secrets/', 'private/'].join('\n') + '\n'
    );

    await git.add('.');
    await git.commit('initial');
    await git.raw(['branch', '-M', 'main']);
    commitSha = (await git.revparse(['HEAD'])).trim();
  }, 30_000);

  afterAll(async () => {
    await rm(workTree, { recursive: true, force: true });
  });

  it('reports total, excluded_global, excluded_repo, counted with the identity invariant', async () => {
    const result = await analyseFiles(simpleGit(workTree), { ref: 'HEAD' });

    expect(result.commitSha).toBe(commitSha);
    expect(result.hasDamsecureIgnore).toBe(true);
    expect(result.damsecureIgnoreLines).toBe(2); // /secrets/ and private/

    // total = counted + excludedGlobal + excludedRepo (the invariant the CSV depends on)
    expect(
      result.countedFiles + result.excludedGlobal + result.excludedRepo
    ).toBe(result.totalFiles);

    // We seeded:
    //   2 source files     (kept: src/a.ts, src/b.ts)
    //   1 README.md        (kept)
    //   3 global-excluded  (logo.png, package-lock.json, main.bundle.js)
    //   2 repo-excluded    (secrets/key.pem, private/note.md)
    //   1 .damsecure-ignore (kept; not matched by either set)
    // total = 9
    expect(result.totalFiles).toBe(9);
    expect(result.excludedGlobal).toBe(3);
    expect(result.excludedRepo).toBe(2);
    expect(result.countedFiles).toBe(4);
  });

  it('treats a missing .damsecure-ignore as an empty pattern set (not an error)', async () => {
    // Build a second repo with no .damsecure-ignore.
    const dir = await mkdtemp(join(tmpdir(), 'sizer-noignore-'));
    try {
      const git = simpleGit(dir);
      await git.init();
      await git.addConfig('user.email', 't@t');
      await git.addConfig('user.name', 't');
      await writeFile(join(dir, 'README.md'), '# noignore');
      await writeFile(join(dir, 'logo.png'), 'png');
      await git.add('.');
      await git.commit('init');
      await git.raw(['branch', '-M', 'main']);

      const result = await analyseFiles(git);
      expect(result.hasDamsecureIgnore).toBe(false);
      expect(result.damsecureIgnoreLines).toBe(0);
      expect(result.excludedRepo).toBe(0);
      expect(result.totalFiles).toBe(2);
      expect(result.excludedGlobal).toBe(1); // logo.png
      expect(result.countedFiles).toBe(1); // README.md
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('attributes a path matched by both filters to the global bucket only', async () => {
    // .damsecure-ignore mentions *.png AND global already excludes *.png:
    // result.excludedGlobal should contain it; result.excludedRepo shouldn't
    // double-count.
    const dir = await mkdtemp(join(tmpdir(), 'sizer-overlap-'));
    try {
      const git = simpleGit(dir);
      await git.init();
      await git.addConfig('user.email', 't@t');
      await git.addConfig('user.name', 't');
      await writeFile(join(dir, 'README.md'), '# overlap');
      await writeFile(join(dir, 'logo.png'), 'png');
      await writeFile(join(dir, '.damsecure-ignore'), '*.png\n');
      await git.add('.');
      await git.commit('init');
      await git.raw(['branch', '-M', 'main']);

      const result = await analyseFiles(git);
      expect(result.excludedGlobal).toBe(1);
      expect(result.excludedRepo).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Pure summariser unit tests
// ---------------------------------------------------------------------------

const NOW = new Date('2026-05-13T12:00:00Z');

function rec(authorAndDate: { author: string; daysAgo: number }): ActivityRecord {
  const t = NOW.getTime() - authorAndDate.daysAgo * 24 * 60 * 60 * 1000;
  return {
    sha: 'a'.repeat(40),
    author: authorAndDate.author,
    committedAt: new Date(t).toISOString(),
  };
}

describe('summariseActivity — windows + uniques + top-N', () => {
  it('counts commits across nested 4w/13w/52w windows correctly', () => {
    const records = [
      rec({ author: 'alice', daysAgo: 3 }),     // <4w & <13w & <52w
      rec({ author: 'alice', daysAgo: 10 }),    // <4w & <13w & <52w
      rec({ author: 'bob', daysAgo: 60 }),      // <13w & <52w (not 4w)
      rec({ author: 'bob', daysAgo: 100 }),     // <52w only (not 13w nor 4w)
      rec({ author: 'carol', daysAgo: 200 }),   // <52w
      rec({ author: 'dave', daysAgo: 500 }),    // outside 52w — excluded
    ];

    const s = summariseActivity(records, '2026-05-10T00:00:00Z', NOW);
    expect(s.commitsLast4w).toBe(2);
    expect(s.commitsLast13w).toBe(3);
    expect(s.commitsLast52w).toBe(5);
  });

  it('counts each contributor once per window', () => {
    const records = [
      rec({ author: 'alice', daysAgo: 1 }),
      rec({ author: 'alice', daysAgo: 5 }),
      rec({ author: 'alice', daysAgo: 9 }),
      rec({ author: 'bob', daysAgo: 9 }),
    ];
    const s = summariseActivity(records, '2026-05-10T00:00:00Z', NOW);
    expect(s.commitsLast4w).toBe(4);
    expect(s.committersLast4w).toBe(2);
  });

  it('top-5 contributors sorted by count desc with deterministic alpha tie-break', () => {
    const records = [
      ...Array(10).fill(0).map(() => rec({ author: 'edith', daysAgo: 1 })),
      ...Array(8).fill(0).map(() => rec({ author: 'alice', daysAgo: 5 })),
      ...Array(8).fill(0).map(() => rec({ author: 'zara', daysAgo: 3 })),
      ...Array(5).fill(0).map(() => rec({ author: 'bob', daysAgo: 7 })),
      ...Array(2).fill(0).map(() => rec({ author: 'carol', daysAgo: 11 })),
      ...Array(1).fill(0).map(() => rec({ author: 'dan', daysAgo: 13 })),
    ];

    const s = summariseActivity(records, '2026-05-10T00:00:00Z', NOW);
    expect(s.topContributors.map((c) => c.name)).toEqual([
      'edith', // 10
      'alice', // 8 (a < z)
      'zara',  // 8
      'bob',   // 5
      'carol', // 2
      // dan dropped (top 5 only)
    ]);
    expect(s.topContributors[1].commits).toBe(8);
  });

  it('returns zeros (NOT -1) when records is empty', () => {
    const s = summariseActivity([], '', NOW);
    expect(s.commitsLast4w).toBe(0);
    expect(s.commitsLast52w).toBe(0);
    expect(s.committersLast52w).toBe(0);
    expect(s.topContributors).toEqual([]);
    expect(s.activityUnavailable).toBe(false);
    expect(s.lastCommitAt).toBe('');
  });

  it('skips records with unparseable committer dates', () => {
    const records: ActivityRecord[] = [
      { sha: 'x', author: 'alice', committedAt: 'not-a-date' },
      rec({ author: 'bob', daysAgo: 1 }),
    ];
    const s = summariseActivity(records, '', NOW);
    expect(s.commitsLast4w).toBe(1);
  });
});

describe('parseGitLog', () => {
  it('parses tab-separated log output', () => {
    const out = parseGitLog(
      [
        'sha1\talice\t2026-05-13T10:00:00Z',
        'sha2\tbob\t2026-05-12T10:00:00Z',
        '',
        'sha3\tcarol\t2026-05-11T10:00:00Z',
      ].join('\n')
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      sha: 'sha1',
      author: 'alice',
      committedAt: '2026-05-13T10:00:00Z',
    });
  });

  it('skips lines with fewer than 3 fields', () => {
    expect(parseGitLog('sha1\talice')).toEqual([]);
  });
});

describe('formatTopContributors', () => {
  it('joins as "name:count" semicolon-separated', () => {
    expect(
      formatTopContributors([
        { name: 'alice', commits: 10 },
        { name: 'bob', commits: 5 },
      ])
    ).toBe('alice:10;bob:5');
  });

  it('escapes : and ; in author names defensively', () => {
    expect(
      formatTopContributors([{ name: 'evil:name;here', commits: 1 }])
    ).toBe('evil_name_here:1');
  });

  it('returns empty string for an empty list', () => {
    expect(formatTopContributors([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Activity integration: real repo with controlled commit timestamps
// ---------------------------------------------------------------------------

describe('analyseActivity — integration with controlled commit dates', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sizer-activity-'));
    const git = simpleGit(dir);
    await git.init();
    await git.addConfig('user.email', 'sizer-test@example.invalid');
    await git.addConfig('user.name', 'alice');

    await writeFile(join(dir, 'README.md'), '0');
    await git.add('.');
    // Real repos commit chronologically (oldest commit at the chain root,
    // newest at HEAD). `git log --since=52.weeks.ago` uses a traversal
    // optimisation that stops walking past commits with old committer dates,
    // so we have to mirror real repo topology. (See PR comment in
    // analyseActivity for more context.)
    //   chain root:  500 days ago  (outside 52w)
    //                200 days ago  (within 52w only)
    //                 60 days ago  (within 52w + 13w)
    //                 10 days ago  (within all three windows)
    //   HEAD:          3 days ago  (within all three windows)
    await commitWithDate(git, dir, 'README.md', '1', 'commit-500d', daysAgoIso(NOW, 500), 'alice');
    await commitWithDate(git, dir, 'README.md', '2', 'commit-200d', daysAgoIso(NOW, 200), 'bob');
    await commitWithDate(git, dir, 'README.md', '3', 'commit-60d', daysAgoIso(NOW, 60), 'alice');
    await commitWithDate(git, dir, 'README.md', '4', 'commit-10d', daysAgoIso(NOW, 10), 'bob');
    await commitWithDate(git, dir, 'README.md', '5', 'commit-3d', daysAgoIso(NOW, 3), 'alice');

    await git.raw(['branch', '-M', 'main']);
  }, 30_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('produces the right windowed counts and top contributors', async () => {
    const summary = await analyseActivity(simpleGit(dir), { now: NOW });
    expect(summary.activityUnavailable).toBe(false);
    expect(summary.commitsLast4w).toBe(2);
    expect(summary.commitsLast13w).toBe(3);
    expect(summary.commitsLast52w).toBe(4);
    expect(summary.committersLast4w).toBe(2);
    expect(summary.committersLast52w).toBe(2);
    expect(summary.topContributors.map((c) => `${c.name}:${c.commits}`)).toEqual([
      'alice:2', // 2 inside 52w (3d ago + 60d ago); 500d ago excluded
      'bob:2',
    ]);
    expect(summary.lastCommitAt).toBeTruthy();
  });
});

describe('analyseActivity — silent catches now route through debugLog (Rule 3)', () => {
  it('returns activityUnavailable=true when git log throws (broken/non-git dir)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sizer-not-a-repo-'));
    try {
      const summary = await analyseActivity(simpleGit(dir), { now: NOW });
      expect(summary.activityUnavailable).toBe(true);
      expect(summary.commitsLast4w).toBe(-1);
      expect(summary.lastCommitAt).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
      __resetDebugLog();
    }
  });

  it('does NOT write to stderr when --debug is off (silent-by-default)', async () => {
    __resetDebugLog();
    const dir = await mkdtemp(join(tmpdir(), 'sizer-debug-off-'));
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      await analyseActivity(simpleGit(dir), { now: NOW });
      // The plugin/simple-git internals may emit unrelated noise; what we
      // assert is that NO call was tagged with our category prefix.
      const debugLines = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith('[analyseActivity.'));
      expect(debugLines).toEqual([]);
    } finally {
      writeSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('DOES write a debug line to stderr when --debug is on', async () => {
    enableDebugLog();
    const dir = await mkdtemp(join(tmpdir(), 'sizer-debug-on-'));
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      await analyseActivity(simpleGit(dir), { now: NOW });
      const debugLines = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith('[analyseActivity.'));
      // At least one of the two catch sites should fire (the gitLog one
      // typically does because the dir isn't a repo).
      expect(debugLines.length).toBeGreaterThanOrEqual(1);
      expect(debugLines[0]).toMatch(/^\[analyseActivity\.(gitLog|lastCommitAt)\] /);
    } finally {
      writeSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
      __resetDebugLog();
    }
  });
});

function daysAgoIso(now: Date, days: number): string {
  const t = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return t.toISOString();
}

async function commitWithDate(
  git: ReturnType<typeof simpleGit>,
  workTree: string,
  filename: string,
  newContent: string,
  message: string,
  isoDate: string,
  authorName: string
): Promise<void> {
  await writeFile(join(workTree, filename), newContent);
  await git.add(filename);
  // Bypass simple-git for the commit so we can control GIT_*_DATE env vars
  // directly; simple-git's `.env()` interacts badly with its
  // block-unsafe-operations plugin (PAGER/EDITOR rejection) and partial-env
  // replacement semantics. execFile gives us deterministic env handling.
  await execFileAsync('git', ['commit', '-m', message], {
    cwd: workTree,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: `${authorName}@example.invalid`,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: `${authorName}@example.invalid`,
    },
  });
}

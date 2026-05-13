/**
 * Vendored matcher parity test for `filterFiles`.
 *
 * Runs both:
 *   1. The CLI's `filterFiles` (which uses the embedded ignorefile.txt + an
 *      optional `.damsecure-ignore` content string).
 *   2. A direct matcher pass over the same fixture list.
 *
 * If both produce identical kept/excluded sets for every fixture in every
 * mode (global-only AND global + per-repo), the sizer wrapper stays aligned
 * with its vendored matcher primitives.
 *
 * Also asserts the separated-counts invariant required by the sized CSV:
 *
 *     total = counted + excludedGlobal + excludedRepo
 */

import { describe, expect, it } from 'vitest';
import { filterFiles } from '../counting/fileFilter.js';
import {
  findMatchingPattern,
  parseIgnorePatterns,
} from '../matchers/index.js';
import { GLOBAL_IGNORE_FILE_CONTENT } from '../generated/ignoreFileContent.js';

/**
 * 110+ paths covering: globs (*.png, *.lock, *.min.js), dotfiles, deeply
 * nested dirs, paths matched only by the global set, paths matched only
 * by the per-repo set, paths matched by both, and paths matched by neither.
 */
const FIXTURE_PATHS: readonly string[] = Object.freeze([
  // Plain source files (kept in both modes)
  'README.md',
  'src/index.ts',
  'src/lib/utils.ts',
  'src/lib/sub/sub.ts',
  'src/components/Button.tsx',
  'src/components/forms/Login.tsx',
  'src/components/forms/Register.tsx',
  'src/services/api.ts',
  'src/services/auth.ts',
  'src/services/db.ts',
  'src/types/user.ts',
  'src/types/api.ts',
  'src/types/index.ts',
  'src/utils/log.ts',
  'src/utils/format.ts',
  'tests/unit/login.test.ts',
  'tests/unit/api.test.ts',
  'tests/integration/full.test.ts',
  'docs/architecture.md',
  'docs/onboarding.md',
  'examples/basic.ts',
  'examples/advanced.ts',
  'scripts/release.sh',
  'scripts/deploy.sh',
  'main.py',
  'app/main.py',
  'app/util.py',
  'cmd/server/main.go',
  'cmd/cli/main.go',
  'pkg/handler/http.go',
  'src/Main.java',
  'src/MainTest.java',

  // Image / asset (excluded by global ignorefile.txt)
  'public/logo.png',
  'public/banner.jpg',
  'public/favicon.ico',
  'public/icon.svg',
  'assets/photo.jpeg',
  'assets/anim.gif',
  'assets/sample.webp',
  'assets/sub/old.bmp',
  'assets/sub/legacy.tiff',
  'assets/sub/cool.avif',
  'assets/sub/heic.heic',

  // Fonts (excluded by global)
  'fonts/Inter.woff',
  'fonts/Inter.woff2',
  'fonts/Inter.otf',
  'fonts/Inter.ttf',

  // Lock files (excluded by global)
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'Podfile.lock',
  'sub-app/package-lock.json',
  'sub-app/yarn.lock',

  // Java compiled (excluded by global)
  'lib/Foo.class',
  'lib/Bar.jar',
  'dist/app.war',
  'dist/app.ear',
  'dist/app.aar',
  'target/foo.txt',
  'target/sub/bar.bin',
  'out/app.jar',
  'out/sub/main.class',

  // JS bundles + build artifacts (excluded by global)
  'public/bundle.min.js',
  'public/page.bundle.js',
  'public/lazy.chunk.js',
  'dist/main.js',
  'dist/sub/x.js',
  'build/main.js',
  'node_modules/foo/index.js',
  'node_modules/foo/sub/bar.js',
  '.next/cache.json',
  '.next/sub/x.js',
  '.nuxt/sub.js',
  '.cache/blob',

  // Python compiled / venv (excluded by global)
  '__pycache__/main.pyc',
  'src/__pycache__/utils.pyc',
  'app/main.pyo',
  'app/main.pyd',
  'venv/lib/python.so',
  '.venv/lib/python.so',
  'env/bin/python',
  '.env/bin/python',
  '.eggs/foo.egg',
  'foo.egg-info/PKG-INFO',

  // Go compiled / vendored (excluded by global)
  'bin/server.exe',
  'bin/server.exe~',
  'bin/server.dll',
  'bin/server.so',
  'bin/server.dylib',
  'vendor/foo/bar.go',
  'vendor/foo/sub/baz.go',

  // Archives & docs (excluded by global)
  'release.zip',
  'archive.tar',
  'archive.tar.gz',
  'archive.rar',
  'archive.7z',
  'archive.gz',
  'archive.bz2',
  'archive.xz',
  'docs/manual.pdf',
  'docs/notes.doc',
  'docs/notes.docx',
  'docs/data.xls',
  'docs/data.xlsx',
  'docs/slides.ppt',
  'docs/slides.pptx',

  // Per-repo only candidates (NOT matched by global; used in the per-repo mode)
  'secrets/key.pem',
  'secrets/sub/cert.pem',
  'private/notes.md',
  'private/sub/info.md',
  'tmp/scratch.tmp',
  'tmp/sub/another.tmp',
  'analysis/preview.txt',
  'analysis/sub/draft.txt',
]);

/**
 * Synthetic `.damsecure-ignore` exercising path-anchored, directory, and
 * extension globs — the same flavours we expect from real-world repos.
 */
const REPO_IGNORE = [
  '/secrets/',
  'private/',
  '*.tmp',
  'analysis/',
].join('\n');

function directlyMatchedIgnoredPaths(
  paths: readonly string[],
  damsecureIgnore: string | null
): Set<string> {
  const globalPatterns = parseIgnorePatterns(GLOBAL_IGNORE_FILE_CONTENT);
  const repoPatterns = damsecureIgnore
    ? parseIgnorePatterns(damsecureIgnore)
    : [];

  const ignored = new Set<string>();
  for (const path of paths) {
    const globalMatch = findMatchingPattern(path, globalPatterns);
    const repoMatch = findMatchingPattern(path, repoPatterns);
    if (globalMatch || repoMatch) {
      ignored.add(path);
    }
  }
  return ignored;
}

describe('filterFiles — matcher parity', () => {
  it('agrees with direct matcher evaluation in global-only mode (no .damsecure-ignore)', () => {
    const cli = filterFiles(FIXTURE_PATHS, null);
    const cliKept = new Set(cli.kept);
    const cliExcluded = new Set(
      FIXTURE_PATHS.filter((p) => !cliKept.has(p))
    );

    const directlyExcluded = directlyMatchedIgnoredPaths(FIXTURE_PATHS, null);

    expect([...cliExcluded].sort()).toEqual([...directlyExcluded].sort());
    expect(cli.excludedRepo).toBe(0); // no per-repo patterns supplied
  });

  it('agrees with direct matcher evaluation in global + per-repo mode (synthetic .damsecure-ignore)', () => {
    const cli = filterFiles(FIXTURE_PATHS, REPO_IGNORE);
    const cliKept = new Set(cli.kept);
    const cliExcluded = new Set(
      FIXTURE_PATHS.filter((p) => !cliKept.has(p))
    );

    const directlyExcluded = directlyMatchedIgnoredPaths(FIXTURE_PATHS, REPO_IGNORE);

    expect([...cliExcluded].sort()).toEqual([...directlyExcluded].sort());

    // Sanity: per-repo patterns excluded SOMETHING that wasn't already excluded
    // by the global set (otherwise the test isn't actually exercising the
    // per-repo branch).
    expect(cli.excludedRepo).toBeGreaterThan(0);
  });

  it('preserves the separated-counts invariant: counted + excludedGlobal + excludedRepo == total', () => {
    for (const repoIgnore of [null, REPO_IGNORE]) {
      const cli = filterFiles(FIXTURE_PATHS, repoIgnore);
      expect(cli.kept.length + cli.excludedGlobal + cli.excludedRepo).toBe(
        FIXTURE_PATHS.length
      );
    }
  });

  it('does not double-count a path matched by both global and per-repo patterns', () => {
    // *.png is in both the global set AND a per-repo set we craft here.
    // The implementation should attribute it to the global bucket (checked
    // first), not both.
    const overlapping = '*.png\n';
    const justOnePng = ['public/logo.png'];

    const cli = filterFiles(justOnePng, overlapping);
    expect(cli.excludedGlobal).toBe(1);
    expect(cli.excludedRepo).toBe(0);
    expect(cli.kept).toEqual([]);
  });

  it('reports zero exclusions when a repo has no per-repo patterns and no global-matching files', () => {
    const onlySource = ['src/index.ts', 'README.md', 'tests/x.test.ts'];
    const cli = filterFiles(onlySource, null);
    expect(cli.kept.sort()).toEqual([...onlySource].sort());
    expect(cli.excludedGlobal).toBe(0);
    expect(cli.excludedRepo).toBe(0);
  });

  it('handles an empty .damsecure-ignore string (no per-repo patterns)', () => {
    const cli = filterFiles(['README.md', 'logo.png'], '');
    expect(cli.excludedRepo).toBe(0);
    expect(cli.excludedGlobal).toBe(1); // logo.png
    expect(cli.kept).toEqual(['README.md']);
  });

  it('handles a .damsecure-ignore that contains only comments and blank lines', () => {
    const cli = filterFiles(
      ['README.md', 'tmp/x.tmp'],
      '\n\n# only comments\n\n#  another comment\n'
    );
    expect(cli.excludedRepo).toBe(0);
    expect(cli.kept.sort()).toEqual(['README.md', 'tmp/x.tmp'].sort());
  });
});

describe('filterFiles — fixture coverage', () => {
  it('includes at least 100 paths covering globs, dotfiles, and nested dirs', () => {
    expect(FIXTURE_PATHS.length).toBeGreaterThanOrEqual(100);

    const hasGlobMatchable = FIXTURE_PATHS.some((p) => p.endsWith('.png'));
    const hasDotPath = FIXTURE_PATHS.some((p) => p.startsWith('.'));
    const hasDeeplyNested = FIXTURE_PATHS.some(
      (p) => p.split('/').length >= 3
    );

    expect(hasGlobMatchable).toBe(true);
    expect(hasDotPath).toBe(true);
    expect(hasDeeplyNested).toBe(true);
  });
});

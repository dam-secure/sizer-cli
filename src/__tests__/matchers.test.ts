import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  findMatchingPattern,
  MINIMATCH_OPTIONS,
  normalizeGitignorePattern,
  parseIgnorePatterns,
} from '../matchers/index.js';

const IGNORE_FILE_SHA256 = '304754f3eb4692a53cdd64766f51f053db2566483520ccd3d9a58a78e19e1433';

describe('vendored ignore matchers', () => {
  it('parses non-empty, non-comment ignore patterns', () => {
    const content = [
      '# comment',
      '',
      '  *.png  ',
      'dist/',
      '  # another comment',
      'node_modules/',
    ].join('\n');

    expect(parseIgnorePatterns(content)).toEqual([
      '*.png',
      'dist/',
      'node_modules/',
    ]);
  });

  it('normalizes gitignore directory and root-relative syntax for minimatch', () => {
    expect(normalizeGitignorePattern('/src/generated/')).toBe('src/generated/**');
    expect(normalizeGitignorePattern('dist/')).toBe('dist/**');
    expect(normalizeGitignorePattern('*.lock')).toBe('*.lock');
  });

  it('returns the original pattern that matched a file path', () => {
    const patterns = ['dist/', '*.lock', '/src/generated/'];

    expect(findMatchingPattern('dist/index.js', patterns)).toBe('dist/');
    expect(findMatchingPattern('apps/web/yarn.lock', patterns)).toBe('*.lock');
    expect(findMatchingPattern('src/generated/routes.ts', patterns)).toBe('/src/generated/');
    expect(findMatchingPattern('src/index.ts', patterns)).toBeNull();
  });

  it('keeps matcher options aligned with gitignore-style matching expectations', () => {
    expect(MINIMATCH_OPTIONS).toEqual({
      matchBase: true,
      dot: true,
      nocase: true,
    });
  });

  it('pins the vendored global ignorefile content', async () => {
    const ignoreFileUrl = new URL('../matchers/ignorefile.txt', import.meta.url);
    const content = await readFile(ignoreFileUrl, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');

    expect(hash).toBe(IGNORE_FILE_SHA256);
  });
});

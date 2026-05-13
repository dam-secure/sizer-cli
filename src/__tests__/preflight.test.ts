/**
 * Preflight unit tests.
 *
 *  - resolveToken: precedence (flag > env > friendly error)
 *  - ensureGitVersion: parses real-world output, rejects too-old
 *  - redactString: scrubs the credential portion of a clone URL
 *  - installLogRedactor: does what it says by wrapping process.stdout.write
 *
 * The stream-wrapping test is intentionally narrow: we capture the wrapped
 * function's output (via a write spy) to assert scrubbing happens, then
 * call __resetRedactor + restore the spy.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ensureGitVersion,
  installLogRedactor,
  redactString,
  resolveToken,
  PreflightError,
  REDACT_PATTERN,
  ENV_TOKEN,
  __resetRedactor,
} from '../preflight.js';

describe('resolveToken', () => {
  it('uses --token when provided', () => {
    expect(resolveToken('flag-value', { [ENV_TOKEN]: 'env-value' })).toBe('flag-value');
  });

  it('falls back to env when --token is absent', () => {
    expect(resolveToken(undefined, { [ENV_TOKEN]: 'env-value' })).toBe('env-value');
  });

  it('throws a friendly error mentioning the env name and click-path', () => {
    try {
      resolveToken(undefined, {});
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      const msg = (err as Error).message;
      expect(msg).toContain(ENV_TOKEN);
      expect(msg).toContain('Contents: Read-only');
      expect(msg).toContain('Metadata: Read-only');
    }
  });
});

describe('ensureGitVersion', () => {
  it('accepts modern git', () => {
    expect(() => ensureGitVersion('git version 2.45.0')).not.toThrow();
    expect(() =>
      ensureGitVersion('git version 2.40.1.windows.1')
    ).not.toThrow();
    expect(() =>
      ensureGitVersion('git version 2.45.0 (Apple Git-145)')
    ).not.toThrow();
  });

  it('accepts the minimum (2.22)', () => {
    expect(() => ensureGitVersion('git version 2.22.0')).not.toThrow();
  });

  it('rejects below the minimum', () => {
    expect(() => ensureGitVersion('git version 2.20.0')).toThrow(/git 2\.22\+/);
    expect(() => ensureGitVersion('git version 1.9.0')).toThrow(/git 2\.22\+/);
  });

  it('rejects unparseable output', () => {
    expect(() => ensureGitVersion('hello, world')).toThrow(/Unrecognised/);
  });
});

describe('redactString / REDACT_PATTERN', () => {
  it('replaces x-access-token credentials with ***', () => {
    expect(
      redactString('https://x-access-token:ghp_xxx@github.com/acme/api.git')
    ).toBe('https://x-access-token:***@github.com/acme/api.git');
  });

  it('handles multiple occurrences in a single string', () => {
    const s =
      'a https://x-access-token:t1@gh.com/o/a.git b https://x-access-token:t2@gh.com/o/b.git';
    expect(redactString(s)).toBe(
      'a https://x-access-token:***@gh.com/o/a.git b https://x-access-token:***@gh.com/o/b.git'
    );
  });

  it('does not change strings without credentials', () => {
    expect(redactString('clone failed: connection refused')).toBe(
      'clone failed: connection refused'
    );
  });

  it('REDACT_PATTERN matches only the credential portion', () => {
    const matches = 'https://x-access-token:abc123@gh.com/x.git'.match(
      REDACT_PATTERN
    );
    expect(matches).toEqual(['x-access-token:abc123@']);
  });
});

describe('installLogRedactor — process.stdout/stderr.write wrapping', () => {
  it('scrubs strings that pass through process.stdout.write', () => {
    __resetRedactor();
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    installLogRedactor();

    process.stdout.write(
      'leaked: https://x-access-token:ghp_xxx@github.com/acme/api.git\n'
    );

    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls[0][0] as string;
    expect(written).not.toContain('ghp_xxx');
    expect(written).toContain('x-access-token:***@');

    writeSpy.mockRestore();
    __resetRedactor();
  });

  it('passes through buffers unchanged when they have no credentials', () => {
    __resetRedactor();
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    installLogRedactor();

    const buf = Buffer.from('plain output\n', 'utf8');
    process.stdout.write(buf);

    expect(writeSpy).toHaveBeenCalled();
    const written = writeSpy.mock.calls[0][0];
    expect(written).toBe(buf); // identity — no replacement happened

    writeSpy.mockRestore();
    __resetRedactor();
  });

  it('is idempotent — installing twice does not double-wrap', () => {
    __resetRedactor();
    installLogRedactor();
    const writeAfterFirstInstall = process.stdout.write;
    installLogRedactor();
    expect(process.stdout.write).toBe(writeAfterFirstInstall);
    __resetRedactor();
  });
});

/**
 * Progress reporter tests.
 *
 * Pin the stderr-only contract, the `--quiet` no-op behaviour, and the
 * `[ N/M]` zero-padded format. Renders are captured via a stderr.write spy.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  QUIET_REPORTER,
  createStderrReporter,
} from '../progress.js';
import { __resetDebugLog } from '../debugLog.js';

afterEach(() => {
  vi.restoreAllMocks();
  __resetDebugLog();
});

function captureStderr(): { lines: string[]; restore: () => void } {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const lines: string[] = [];
  spy.mockImplementation((chunk: unknown) => {
    if (typeof chunk === 'string') {
      for (const line of chunk.split('\n')) {
        if (line.length > 0) lines.push(line);
      }
    }
    return true;
  });
  return {
    lines,
    restore: () => spy.mockRestore(),
  };
}

describe('QUIET_REPORTER', () => {
  it('emits nothing for any event', () => {
    const cap = captureStderr();
    QUIET_REPORTER.start('/tmp/sizer', 5, 5);
    QUIET_REPORTER.repoStart(1, 5, 'acme/api');
    QUIET_REPORTER.repoDone(1, 5, 'acme/api', '10 files (0 excl_global, 0 excl_repo, 10 counted)', 1234);
    QUIET_REPORTER.end(5000, 5, 0);
    expect(cap.lines).toEqual([]);
    cap.restore();
  });
});

describe('createStderrReporter', () => {
  it('start() prints the workspace path + repo count + concurrency', () => {
    const cap = captureStderr();
    createStderrReporter().start('/tmp/sizer-99', 36, 5);
    expect(cap.lines.length).toBe(2);
    expect(cap.lines[0]).toContain('workspace: /tmp/sizer-99');
    expect(cap.lines[1]).toMatch(/sizing 36 repos at concurrency 5/);
    cap.restore();
  });

  it('start() pluralises correctly on a single-repo run', () => {
    const cap = captureStderr();
    createStderrReporter().start('/tmp/sizer-1', 1, 1);
    expect(cap.lines[1]).toMatch(/sizing 1 repo at concurrency 1/);
    cap.restore();
  });

  it('repoStart() always prints a "cloning" line (matches repoDone for two events per repo)', () => {
    const cap = captureStderr();
    createStderrReporter().repoStart(3, 36, 'acme/api');
    expect(cap.lines.length).toBe(1);
    expect(cap.lines[0]).toMatch(/^\[sizer\] \[ 3\/36\] acme\/api  ▸ cloning …$/);
    cap.restore();
  });

  it('a full repo lifecycle emits exactly two lines (cloning, then sized)', () => {
    const cap = captureStderr();
    const reporter = createStderrReporter();
    reporter.repoStart(7, 10, 'acme/api');
    reporter.repoDone(7, 10, 'acme/api', '50 files (5 excl_global, 0 excl_repo, 45 counted)', 800);
    expect(cap.lines.length).toBe(2);
    expect(cap.lines[0]).toMatch(/^\[sizer\] \[ 7\/10\] acme\/api  ▸ cloning …$/);
    expect(cap.lines[1]).toMatch(/^\[sizer\] \[ 7\/10\] acme\/api  ✓ 50 files \(5 excl_global, 0 excl_repo, 45 counted\)  \(800ms\)$/);
    cap.restore();
  });

  it('repoDone() right-pads the index to match the total width', () => {
    const cap = captureStderr();
    const reporter = createStderrReporter();
    reporter.repoDone(1, 100, 'acme/api', '12 files', 1500);
    reporter.repoDone(99, 100, 'acme/web', '34 files', 200);
    expect(cap.lines[0]).toMatch(/^\[sizer\] \[  1\/100\] acme\/api  ✓ 12 files  \(1\.5s\)$/);
    expect(cap.lines[1]).toMatch(/^\[sizer\] \[ 99\/100\] acme\/web  ✓ 34 files  \(200ms\)$/);
    cap.restore();
  });

  it('end() reports total + errored counts and wall time', () => {
    const cap = captureStderr();
    createStderrReporter().end(14_137, 36, 1);
    expect(cap.lines[0]).toMatch(/done — 36 repos sized, 1 errored in 14\.1s/);
    cap.restore();
  });

  it('end() omits the errored phrase when no repos errored', () => {
    const cap = captureStderr();
    createStderrReporter().end(2_500, 5, 0);
    expect(cap.lines[0]).toMatch(/done — 5 repos sized in 2\.5s/);
    expect(cap.lines[0]).not.toContain('errored');
    cap.restore();
  });
});

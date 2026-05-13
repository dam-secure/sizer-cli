/**
 * debugLog tests — pin the silent-by-default + stderr-when-enabled contract
 * so a future regression that re-introduces a silent catch fails CI.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  debugLog,
  enableDebugLog,
  isDebugEnabled,
  __resetDebugLog,
} from '../debugLog.js';

afterEach(() => {
  __resetDebugLog();
  vi.restoreAllMocks();
});

describe('debugLog', () => {
  it('is silent by default — does NOT touch stderr when debug is off', () => {
    expect(isDebugEnabled()).toBe(false);
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    debugLog('test.silent', new Error('should not appear'));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes a single line to stderr when debug is enabled', () => {
    enableDebugLog();
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    debugLog('test.category', new Error('boom'));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const arg = writeSpy.mock.calls[0][0] as string;
    expect(arg).toBe('[test.category] boom\n');
  });

  it('handles non-Error throwables (string, number, undefined)', () => {
    enableDebugLog();
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    debugLog('test.string', 'plain string');
    debugLog('test.number', 42);
    debugLog('test.undef', undefined);
    expect(writeSpy).toHaveBeenCalledTimes(3);
    expect(writeSpy.mock.calls[0][0]).toBe('[test.string] plain string\n');
    expect(writeSpy.mock.calls[1][0]).toBe('[test.number] 42\n');
    expect(writeSpy.mock.calls[2][0]).toBe('[test.undef] undefined\n');
  });

  it('emits one line per call (no batching, no stack)', () => {
    enableDebugLog();
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const e = new Error('with-stack');
    debugLog('cat', e);
    const arg = writeSpy.mock.calls[0][0] as string;
    expect(arg).toBe('[cat] with-stack\n');
    expect(arg).not.toContain('at ');  // no stack frames
  });
});

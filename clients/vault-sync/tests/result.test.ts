import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, unwrap } from '../src/shared/result';

describe('result', () => {
  it('creates ok result', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    expect(unwrap(r)).toBe(42);
  });

  it('creates err result', () => {
    const r = err({ message: 'fail', status: 500 });
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
  });

  it('unwrap throws on error', () => {
    const r = err('bad');
    expect(() => unwrap(r as any)).toThrow();
  });
});

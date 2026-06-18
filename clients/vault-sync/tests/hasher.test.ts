import { describe, it, expect } from 'vitest';
import { computeBufferHash, shortenHash } from '../src/services/hasher';

describe('hasher', () => {
  it('computes consistent SHA-256 hash', async () => {
    const buf = Buffer.from('hello world');
    const h1 = computeBufferHash(buf);
    const h2 = computeBufferHash(buf);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = computeBufferHash(Buffer.from('a'));
    const h2 = computeBufferHash(Buffer.from('b'));
    expect(h1).not.toBe(h2);
  });

  it('shortens hash to specified length', () => {
    const hash = computeBufferHash(Buffer.from('test'));
    expect(shortenHash(hash, 8).length).toBe(8);
    expect(shortenHash(hash, 12).length).toBe(12);
  });
});

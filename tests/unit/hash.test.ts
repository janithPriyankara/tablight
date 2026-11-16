import { describe, expect, it } from 'vitest';
import { sha1hex } from '../../src/shared/hash';
describe('sha1hex', () => {
  it('matches the known SHA-1 of "abc"', async () => {
    expect(await sha1hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
  it('hashes UTF-8 bytes', async () => {
    expect(await sha1hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(await sha1hex('é')).toHaveLength(40);
  });
});

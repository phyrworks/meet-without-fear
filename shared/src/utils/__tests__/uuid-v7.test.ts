import { uuidv7 } from '../uuid-v7';

const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  afterEach(() => jest.useRealTimers());

  it('has version nibble 7 and RFC variant 10xx for many samples', () => {
    for (let i = 0; i < 5000; i++) expect(uuidv7()).toMatch(V7_RE);
  });

  it('encodes the current ms timestamp in the first 48 bits', () => {
    const before = Date.now();
    const id = uuidv7();
    const ts = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('sorts by creation time across milliseconds', () => {
    jest.useFakeTimers();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      jest.setSystemTime(new Date(4_000_000_000_000 + i * 3));
      ids.push(uuidv7());
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it('is monotonic within one millisecond and unique', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(4_100_000_000_000));
    const ids = Array.from({ length: 3000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(V7_RE));
  });
});

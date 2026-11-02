/**
 * UUIDv7 generator (RFC 9562 section 5.7).
 *
 * OWNER RULE: app code mints UUIDv7 only, never v4 (crypto.randomUUID) —
 * v7 ids sort by creation time. ESLint bans randomUUID outside tests.
 *
 * Layout: 48-bit unix-ms timestamp | version 7 | 12-bit rand_a | variant 10 | 62-bit rand_b.
 * rand_a doubles as a monotonic counter (RFC 9562 method 1) so ids minted in
 * the same millisecond still sort in creation order.
 */

let lastMs = 0;
let seq = 0;

type CryptoLike = { getRandomValues?: (a: Uint8Array) => Uint8Array };

function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('uuidv7: crypto.getRandomValues is unavailable in this runtime');
  }
  return c.getRandomValues(new Uint8Array(n));
}

export function uuidv7(): string {
  let ms = Date.now();
  if (ms > lastMs) {
    lastMs = ms;
    // Random start below 0x800 leaves headroom so the counter rarely overflows.
    const r = randomBytes(2);
    seq = ((r[0] << 8) | r[1]) & 0x7ff;
  } else {
    // Same ms (or clock stepped back): keep the last timestamp and count up.
    seq += 1;
    if (seq > 0xfff) {
      lastMs += 1;
      seq = 0;
    }
    ms = lastMs;
  }

  const b = randomBytes(16);
  // 48-bit big-endian timestamp (avoid 32-bit bit ops on the high part).
  const hi = Math.floor(ms / 0x10000); // top 32 bits
  const lo = ms % 0x10000; // low 16 bits
  b[0] = (hi >>> 24) & 0xff;
  b[1] = (hi >>> 16) & 0xff;
  b[2] = (hi >>> 8) & 0xff;
  b[3] = hi & 0xff;
  b[4] = (lo >>> 8) & 0xff;
  b[5] = lo & 0xff;
  b[6] = 0x70 | ((seq >>> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);

  let h = '';
  for (let i = 0; i < 16; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

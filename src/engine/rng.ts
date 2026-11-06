/** Random source used by every shuffle and by the AI. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Unbiased uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

function unbiasedInt(u32: () => number, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
    throw new Error(`Invalid random bound: ${maxExclusive}`);
  }
  // Rejection sampling removes the modulo bias a plain `%` would introduce.
  const limit = 0x100000000 - (0x100000000 % maxExclusive);
  let value = u32();
  while (value >= limit) value = u32();
  return value % maxExclusive;
}

function hashSeed(seed: string | number): number {
  const text = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * sfc32: small, fast and statistically solid. Used for reproducible tests,
 * bug reports (the seed is logged) and for AI decisions.
 */
export class SeededRng implements Rng {
  private a: number;
  private b: number;
  private c: number;
  private d = 1;

  constructor(seed: string | number) {
    const h = hashSeed(seed);
    this.a = h;
    this.b = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    this.c = Math.imul(h ^ 0x243f6a88, 0xc2b2ae35) >>> 0;
    for (let i = 0; i < 16; i++) this.u32();
  }

  private u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  next(): number {
    return this.u32() / 0x100000000;
  }

  int(maxExclusive: number): number {
    return unbiasedInt(() => this.u32(), maxExclusive);
  }
}

/** Cryptographically strong source used to shuffle real gameplay decks. */
export class CryptoRng implements Rng {
  private buffer = new Uint32Array(256);
  private index = 256;

  private u32(): number {
    if (this.index >= this.buffer.length) {
      globalThis.crypto.getRandomValues(this.buffer);
      this.index = 0;
    }
    return this.buffer[this.index++];
  }

  next(): number {
    return this.u32() / 0x100000000;
  }

  int(maxExclusive: number): number {
    return unbiasedInt(() => this.u32(), maxExclusive);
  }
}

export const createRng = (seed?: string | number): Rng =>
  seed === undefined ? new CryptoRng() : new SeededRng(seed);

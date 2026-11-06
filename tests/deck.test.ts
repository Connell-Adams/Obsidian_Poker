import { describe, expect, it } from 'vitest';
import { cardToString, handClass, handClassIndex, handClassNameFromIndex, parseCard, parseCards } from '../src/engine/cards';
import { Deck } from '../src/engine/deck';
import { CryptoRng, SeededRng } from '../src/engine/rng';

describe('cards', () => {
  it('round-trips every card through text', () => {
    for (let c = 0; c < 52; c++) expect(parseCard(cardToString(c))).toBe(c);
  });

  it('rejects malformed cards', () => {
    expect(() => parseCard('Xx')).toThrow();
    expect(() => parseCard('A')).toThrow();
    expect(() => cardToString(52)).toThrow();
  });

  it('names and indexes all 169 starting hand classes consistently', () => {
    const names = new Set<string>();
    for (let a = 0; a < 52; a++) {
      for (let b = a + 1; b < 52; b++) {
        const name = handClass(a, b);
        names.add(name);
        expect(handClassNameFromIndex(handClassIndex(a, b))).toBe(name);
      }
    }
    expect(names.size).toBe(169);
    const [a, b] = parseCards('As Kh');
    expect(handClass(a, b)).toBe('AKo');
  });
});

describe('deck', () => {
  it('holds 52 unique cards and deals each exactly once', () => {
    const deck = Deck.shuffled(new SeededRng(1));
    const drawn = new Set<number>();
    while (deck.remaining > 0) drawn.add(deck.draw());
    expect(drawn.size).toBe(52);
    expect(() => deck.draw()).toThrow();
  });

  it('is reproducible from a seed and differs across seeds', () => {
    const order = (seed: number) => {
      const d = Deck.shuffled(new SeededRng(seed));
      return Array.from({ length: 52 }, () => d.draw()).join();
    };
    expect(order(7)).toBe(order(7));
    expect(order(7)).not.toBe(order(8));
  });

  it('burns without exposing the card', () => {
    const deck = Deck.shuffled(new SeededRng(3));
    expect(deck.burn()).toBeUndefined();
    expect(deck.burned).toBe(1);
    expect(deck.remaining).toBe(51);
  });

  it('shuffles uniformly: each card lands in the top slot equally often (chi-square)', () => {
    const rng = new SeededRng('uniformity');
    const counts = new Array(52).fill(0);
    const trials = 104000;
    for (let i = 0; i < trials; i++) counts[Deck.shuffled(rng).draw()]++;
    const expected = trials / 52;
    const chi = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    // 51 degrees of freedom: chi-square above 90 would be a p < 0.001 failure.
    expect(chi).toBeLessThan(90);
  });

  it('crypto source produces in-range values and uses no modulo bias at small bounds', () => {
    const rng = new CryptoRng();
    const counts = [0, 0, 0];
    for (let i = 0; i < 30000; i++) counts[rng.int(3)]++;
    for (const c of counts) expect(Math.abs(c - 10000)).toBeLessThan(500);
    for (let i = 0; i < 1000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

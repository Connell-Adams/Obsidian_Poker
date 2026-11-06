import { describe, expect, it } from 'vitest';
import { computePots, splitPot } from '../src/engine/pots';

const c = (seat: number, amount: number, folded = false) => ({ seat, amount, folded });

describe('computePots', () => {
  it('makes a single pot when everyone contributes equally', () => {
    expect(computePots([c(0, 100), c(1, 100), c(2, 100)])).toEqual([{ amount: 300, eligible: [0, 1, 2] }]);
  });

  it('builds a main and a side pot for one short all-in', () => {
    expect(computePots([c(0, 50), c(1, 200), c(2, 200)])).toEqual([
      { amount: 150, eligible: [0, 1, 2] },
      { amount: 300, eligible: [1, 2] },
    ]);
  });

  it('builds a pot per level for several different all-ins', () => {
    const pots = computePots([c(0, 25), c(1, 75), c(2, 150), c(3, 300), c(4, 300)]);
    expect(pots).toEqual([
      { amount: 125, eligible: [0, 1, 2, 3, 4] },
      { amount: 200, eligible: [1, 2, 3, 4] },
      { amount: 225, eligible: [2, 3, 4] },
      { amount: 300, eligible: [3, 4] },
    ]);
    expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(850);
  });

  it('keeps folded chips in the pots without making the player eligible', () => {
    // Seat 2 folded after putting in 120, which is more than the all-in but less than the top level.
    const pots = computePots([c(0, 50), c(1, 200), c(2, 120, true), c(3, 200)]);
    expect(pots).toEqual([
      { amount: 200, eligible: [0, 1, 3] },
      { amount: 370, eligible: [1, 3] },
    ]);
  });

  it('merges layers whose eligibility is identical when a folded player sets the only break', () => {
    const pots = computePots([c(0, 100, true), c(1, 300), c(2, 300)]);
    expect(pots).toEqual([{ amount: 700, eligible: [1, 2] }]);
  });

  it('puts dead money above every live level into the last pot', () => {
    const pots = computePots([c(0, 100), c(1, 100), c(2, 150, true)]);
    expect(pots).toEqual([{ amount: 350, eligible: [0, 1] }]);
  });

  it('never loses a chip across many random contribution patterns', () => {
    for (let t = 0; t < 2000; t++) {
      const entries = Array.from({ length: 2 + (t % 8) }, (_, i) =>
        c(i, ((t * 37 + i * 91) % 500) + 1, i > 0 && (t + i) % 3 === 0),
      );
      const total = entries.reduce((s, e) => s + e.amount, 0);
      const pots = computePots(entries);
      expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(total);
      for (const pot of pots) for (const seat of pot.eligible) expect(entries[seat].folded).toBe(false);
    }
  });
});

describe('splitPot', () => {
  it('pays a sole winner everything', () => {
    expect(splitPot(500, [3], [3, 4, 0])).toEqual([{ seat: 3, amount: 500 }]);
  });

  it('splits evenly', () => {
    expect(splitPot(500, [1, 3], [1, 2, 3, 0])).toEqual([
      { seat: 1, amount: 250 },
      { seat: 3, amount: 250 },
    ]);
  });

  it('gives odd chips to the winners closest to the left of the button', () => {
    expect(splitPot(101, [0, 2], [2, 3, 0, 1])).toEqual([
      { seat: 2, amount: 51 },
      { seat: 0, amount: 50 },
    ]);
    expect(splitPot(11, [0, 1, 2], [1, 2, 0])).toEqual([
      { seat: 1, amount: 4 },
      { seat: 2, amount: 4 },
      { seat: 0, amount: 3 },
    ]);
  });

  it('refuses to split with no winners', () => {
    expect(() => splitPot(100, [], [0])).toThrow();
  });
});

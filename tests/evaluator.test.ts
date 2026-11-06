import { describe, expect, it } from 'vitest';
import { cardsToString, fullDeck, parseCards } from '../src/engine/cards';
import { Category, categoryOf, compareHands, evaluateHand, scoreHand } from '../src/engine/evaluator';
import { SeededRng } from '../src/engine/rng';

const cat = (text: string) => evaluateHand(parseCards(text)).category;
const cmp = (a: string, b: string) => Math.sign(compareHands(parseCards(a), parseCards(b)));

/** Independent, slow, naive five-card ranker used only to cross-check the fast evaluator. */
function naiveFive(cards: number[]): number[] {
  const ranks = cards.map((c) => c >> 2).sort((a, b) => b - a);
  const flush = cards.every((c) => (c & 3) === (cards[0] & 3));
  const unique = [...new Set(ranks)];
  let straightHigh = -1;
  if (unique.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks.join() === '12,3,2,1,0') straightHigh = 3;
  }
  const groups = unique
    .map((r) => [ranks.filter((x) => x === r).length, r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const pattern = groups.map((g) => g[0]).join('');
  const order = groups.map((g) => g[1]);
  if (flush && straightHigh === 12) return [9];
  if (flush && straightHigh >= 0) return [8, straightHigh];
  if (pattern === '41') return [7, ...order];
  if (pattern === '32') return [6, ...order];
  if (flush) return [5, ...order];
  if (straightHigh >= 0) return [4, straightHigh];
  if (pattern === '311') return [3, ...order];
  if (pattern === '221') return [2, ...order];
  if (pattern === '2111') return [1, ...order];
  return [0, ...order];
}

function compareNaive(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

function naiveBestOfSeven(cards: number[]): number[] {
  let best: number[] | null = null;
  for (let skipA = 0; skipA < 7; skipA++) {
    for (let skipB = skipA + 1; skipB < 7; skipB++) {
      const five = cards.filter((_, i) => i !== skipA && i !== skipB);
      const r = naiveFive(five);
      if (!best || compareNaive(r, best) > 0) best = r;
    }
  }
  return best!;
}

describe('hand rankings', () => {
  it('recognises every category from seven cards', () => {
    expect(cat('As Ks Qs Js Ts 2d 3c')).toBe(Category.RoyalFlush);
    expect(cat('9h 8h 7h 6h 5h Ad Ac')).toBe(Category.StraightFlush);
    expect(cat('Kd Kc Kh Ks 2d 3c 9h')).toBe(Category.FourOfAKind);
    expect(cat('Kd Kc Kh 2s 2d 3c 9h')).toBe(Category.FullHouse);
    expect(cat('Ah Jh 9h 4h 2h Kd Qc')).toBe(Category.Flush);
    expect(cat('9d 8c 7h 6s 5d Ah Kc')).toBe(Category.Straight);
    expect(cat('7d 7c 7h 2s 4d Jc Ah')).toBe(Category.ThreeOfAKind);
    expect(cat('7d 7c 4h 4s Kd Jc 2h')).toBe(Category.TwoPair);
    expect(cat('7d 7c 2h 4s Kd Jc 9h')).toBe(Category.OnePair);
    expect(cat('2d 7c 9h 4s Kd Jc 3h')).toBe(Category.HighCard);
  });

  it('orders the categories correctly', () => {
    const ladder = [
      '2d 7c 9h 4s Kd',
      '7d 7c 2h 4s Kd',
      '7d 7c 4h 4s Kd',
      '7d 7c 7h 2s 4d',
      '9d 8c 7h 6s 5d',
      'Ah Jh 9h 4h 2h',
      'Kd Kc Kh 2s 2d',
      'Kd Kc Kh Ks 2d',
      '9h 8h 7h 6h 5h',
      'As Ks Qs Js Ts',
    ];
    for (let i = 1; i < ladder.length; i++) expect(cmp(ladder[i], ladder[i - 1])).toBe(1);
  });

  it('handles ace-low straights and rejects wrap-arounds', () => {
    const wheel = evaluateHand(parseCards('Ad 2c 3h 4s 5d Kh 9c'));
    expect(wheel.category).toBe(Category.Straight);
    expect(wheel.description).toBe('Straight, Five high');
    expect(cardsToString(wheel.bestFive)).toBe('5d 4s 3h 2c Ad');
    expect(cmp('2c 3d 4h 5s 6d', 'Ad 2c 3h 4s 5d')).toBe(1); // six-high beats the wheel
    expect(cat('Qd Kc Ah 2s 3d 7h 8c')).toBe(Category.HighCard); // no Q-K-A-2-3 wrap
    expect(cat('Ah 2h 3h 4h 5h Kd Qc')).toBe(Category.StraightFlush);
    expect(cmp('As Ks Qs Js Ts', 'Ks Qs Js Ts 9s')).toBe(1);
    expect(cmp('Ah Kd Qc Js Td', 'Kh Qd Jc Ts 9d')).toBe(1); // broadway beats king-high
  });

  it('prefers the higher straight and the higher straight flush when both exist', () => {
    expect(evaluateHand(parseCards('2c 3d 4h 5s 6d 7h 8c')).description).toBe('Straight, Eight high');
    const e = evaluateHand(parseCards('9h 8h 7h 6h 5h 4h Tc'));
    expect(e.description).toBe('Straight Flush, Nine high');
  });
});

describe('kickers and comparisons', () => {
  it('compares kickers for every category that has them', () => {
    expect(cmp('Ad Ac Ks 9h 2c', 'Ah As Qs Jh 2d')).toBe(1); // pair kicker
    expect(cmp('Ad Ac Ks 9h 3c', 'Ah As Kd 9c 2d')).toBe(1); // last kicker
    expect(cmp('Ad Ac 9s 9h Kc', 'Ah As 9d 9c Qd')).toBe(1); // two pair kicker
    expect(cmp('Ad Ac 9s 9h Kc', 'Ah As 8d 8c Kd')).toBe(1); // second pair
    expect(cmp('Ad Ac As Kh 2c', 'Td Tc Ts Ah Kd')).toBe(1); // trips rank
    expect(cmp('7d 7c 7s Ah 2c', '7d 7c 7s Kh Qc')).toBe(1); // trips kicker
    expect(cmp('Kd Kc Kh Ks Ad', 'Kd Kc Kh Ks Qd')).toBe(1); // quads kicker
  });

  it('compares flushes through all five cards', () => {
    expect(cmp('Ah Jh 9h 4h 3h', 'Ad Jd 9d 4d 2d')).toBe(1);
    expect(cmp('Ah Kh 9h 4h 3h', 'Ad Qd Jd Td 8d')).toBe(1);
    expect(cmp('Ah Jh 9h 4h 3h', 'Ad Jd 9d 4d 3d')).toBe(0);
  });

  it('compares full houses by trips first, then pair', () => {
    expect(cmp('Ad Ac As 2h 2c', 'Kd Kc Ks Qh Qc')).toBe(1);
    expect(cmp('Kd Kc Ks Qh Qc', 'Kd Kh Ks Jh Jc')).toBe(1);
  });

  it('makes a full house from two sets of trips, using the higher as trips', () => {
    const e = evaluateHand(parseCards('Kd Kc Ks 9h 9c 9d 2s'));
    expect(e.description).toBe('Full House, Kings over Nines');
  });

  it('uses the best kicker with three pairs on seven cards', () => {
    const e = evaluateHand(parseCards('Kd Kc 9h 9c 4d 4s Ah'));
    expect(e.description).toBe('Two Pair, Kings and Nines');
    expect(cardsToString(e.bestFive)).toContain('Ah');
    const f = evaluateHand(parseCards('Kd Kc 9h 9c 4d 4s 2h'));
    expect(f.bestFive.filter((c) => c >> 2 === 2)).toHaveLength(1); // kicker is a four, not the deuce
  });

  it('detects ties and plays the board', () => {
    const board = 'As Ks Qs Js Ts';
    expect(cmp(`${board} 2d 3c`, `${board} 4d 5c`)).toBe(0);
    expect(cmp('Ad Kc 9s 7h 4c 3d 2s', 'Ah Kd 9c 7d 4h 3c 2d')).toBe(0);
  });

  it('returns the exact winning five cards', () => {
    const quads = evaluateHand(parseCards('Kd Kc Kh Ks 2d 3c 9h'));
    expect(cardsToString(quads.bestFive)).toBe('Ks Kh Kd Kc 9h');
    const flush = evaluateHand(parseCards('Ah Jh 9h 4h 2h 3h Kd'));
    expect(cardsToString(flush.bestFive)).toBe('Ah Jh 9h 4h 3h');
  });

  it('rejects duplicates, bad card counts and invalid cards', () => {
    expect(() => evaluateHand(parseCards('Ah Ah 9h 4h 2h'))).toThrow(/duplicate/);
    expect(() => evaluateHand(parseCards('Ah 9h 4h 2h'))).toThrow();
    expect(() => evaluateHand([0, 1, 2, 3, 99])).toThrow();
  });
});

describe('exhaustive and randomised verification', () => {
  it('produces the known category counts for all 2,598,960 five-card hands', () => {
    const counts = new Array(10).fill(0);
    const hand = new Int32Array(5);
    for (hand[0] = 0; hand[0] < 48; hand[0]++)
      for (hand[1] = hand[0] + 1; hand[1] < 49; hand[1]++)
        for (hand[2] = hand[1] + 1; hand[2] < 50; hand[2]++)
          for (hand[3] = hand[2] + 1; hand[3] < 51; hand[3]++)
            for (hand[4] = hand[3] + 1; hand[4] < 52; hand[4]++) counts[categoryOf(scoreHand(hand, 5))]++;
    expect(counts).toEqual([1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 36, 4]);
  });

  it('agrees with an independent brute-force ranker on 40,000 random seven-card matchups', () => {
    const rng = new SeededRng('evaluator-cross-check');
    const deck = fullDeck();
    for (let trial = 0; trial < 40000; trial++) {
      for (let i = 0; i < 9; i++) {
        const j = i + rng.int(52 - i);
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const board = deck.slice(4, 9);
      const a = [deck[0], deck[1], ...board];
      const b = [deck[2], deck[3], ...board];
      const fast = Math.sign(scoreHand(a) - scoreHand(b));
      const naive = Math.sign(compareNaive(naiveBestOfSeven(a), naiveBestOfSeven(b)));
      if (fast !== naive) throw new Error(`Mismatch: ${cardsToString(a)} vs ${cardsToString(b)}: ${fast} vs ${naive}`);
    }
  });
});

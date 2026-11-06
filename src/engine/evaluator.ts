import { type Card, RANK_CHARS, rankOf, suitOf } from './cards';

/**
 * Hand evaluator. `scoreHand` is allocation-free and handles 5..7 cards (it is
 * called millions of times by the equity simulator). Scores are directly
 * comparable: a higher integer always means a stronger hand, equal integers
 * always mean a tie.
 *
 * Layout: category << 20 | five 4-bit rank nibbles (most significant first).
 */
export const Category = {
  HighCard: 0,
  OnePair: 1,
  TwoPair: 2,
  ThreeOfAKind: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  FourOfAKind: 7,
  StraightFlush: 8,
  RoyalFlush: 9,
} as const;
export type Category = (typeof Category)[keyof typeof Category];

export const CATEGORY_NAMES = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
  'Royal Flush',
] as const;

const WHEEL_MASK = 0b1000000001111;

/** STRAIGHT_HIGH[rankMask] = rank of the straight's top card, or -1. The five-high wheel returns 3. */
const STRAIGHT_HIGH = new Int8Array(1 << 13);
const POPCOUNT = new Uint8Array(1 << 13);
for (let mask = 0; mask < 1 << 13; mask++) {
  POPCOUNT[mask] = (mask & 1) + POPCOUNT[mask >> 1];
  let high = -1;
  for (let top = 12; top >= 4; top--) {
    const run = 0b11111 << (top - 4);
    if ((mask & run) === run) {
      high = top;
      break;
    }
  }
  if (high < 0 && (mask & WHEEL_MASK) === WHEEL_MASK) high = 3;
  STRAIGHT_HIGH[mask] = high;
}

const highBit = (mask: number): number => 31 - Math.clz32(mask);

/** Packs the `count` highest ranks in `mask` into nibbles starting at `shift` going down. */
function packTop(mask: number, count: number, shift: number): number {
  let out = 0;
  let m = mask;
  let s = shift;
  for (let i = 0; i < count && m !== 0; i++) {
    const r = highBit(m);
    out |= r << s;
    m &= ~(1 << r);
    s -= 4;
  }
  return out;
}

export function scoreHand(cards: ArrayLike<Card>, length: number = cards.length): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let one = 0; // ranks seen at least once
  let two = 0; // at least twice
  let three = 0; // at least three times
  let four = 0; // four times

  for (let i = 0; i < length; i++) {
    const card = cards[i];
    const bit = 1 << (card >> 2);
    switch (card & 3) {
      case 0:
        s0 |= bit;
        break;
      case 1:
        s1 |= bit;
        break;
      case 2:
        s2 |= bit;
        break;
      default:
        s3 |= bit;
    }
    four |= three & bit;
    three |= two & bit;
    two |= one & bit;
    one |= bit;
  }

  let flushMask = 0;
  if (POPCOUNT[s0] >= 5) flushMask = s0;
  else if (POPCOUNT[s1] >= 5) flushMask = s1;
  else if (POPCOUNT[s2] >= 5) flushMask = s2;
  else if (POPCOUNT[s3] >= 5) flushMask = s3;

  if (flushMask !== 0) {
    const sf = STRAIGHT_HIGH[flushMask];
    if (sf >= 0) return ((sf === 12 ? Category.RoyalFlush : Category.StraightFlush) << 20) | (sf << 16);
  }
  if (four !== 0) {
    const q = highBit(four);
    return (Category.FourOfAKind << 20) | (q << 16) | (highBit(one & ~(1 << q)) << 12);
  }
  if (three !== 0) {
    const t = highBit(three);
    const rest = two & ~(1 << t);
    if (rest !== 0) return (Category.FullHouse << 20) | (t << 16) | (highBit(rest) << 12);
  }
  if (flushMask !== 0) return (Category.Flush << 20) | packTop(flushMask, 5, 16);

  const straight = STRAIGHT_HIGH[one];
  if (straight >= 0) return (Category.Straight << 20) | (straight << 16);

  if (three !== 0) {
    const t = highBit(three);
    return (Category.ThreeOfAKind << 20) | (t << 16) | packTop(one & ~(1 << t), 2, 12);
  }
  if (two !== 0) {
    const p1 = highBit(two);
    const rest = two & ~(1 << p1);
    if (rest !== 0) {
      const p2 = highBit(rest);
      return (Category.TwoPair << 20) | (p1 << 16) | (p2 << 12) | packTop(one & ~(1 << p1) & ~(1 << p2), 1, 8);
    }
    return (Category.OnePair << 20) | (p1 << 16) | packTop(one & ~(1 << p1), 3, 12);
  }
  return (Category.HighCard << 20) | packTop(one, 5, 16);
}

export const categoryOf = (score: number): Category => (score >> 20) as Category;

export interface EvaluatedHand {
  score: number;
  category: Category;
  categoryName: string;
  /** Human readable, e.g. "Full House, Kings over Tens". */
  description: string;
  /** The exact five cards making the hand, in display order. */
  bestFive: Card[];
}

const RANK_SINGULAR = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

function describe(score: number): string {
  const nib = (i: number) => (score >> (16 - i * 4)) & 15;
  switch (categoryOf(score)) {
    case Category.RoyalFlush:
      return 'Royal Flush';
    case Category.StraightFlush:
      return `Straight Flush, ${RANK_SINGULAR[nib(0)]} high`;
    case Category.FourOfAKind:
      return `Four of a Kind, ${RANK_PLURAL[nib(0)]}`;
    case Category.FullHouse:
      return `Full House, ${RANK_PLURAL[nib(0)]} over ${RANK_PLURAL[nib(1)]}`;
    case Category.Flush:
      return `Flush, ${RANK_SINGULAR[nib(0)]} high`;
    case Category.Straight:
      return `Straight, ${RANK_SINGULAR[nib(0)]} high`;
    case Category.ThreeOfAKind:
      return `Three of a Kind, ${RANK_PLURAL[nib(0)]}`;
    case Category.TwoPair:
      return `Two Pair, ${RANK_PLURAL[nib(0)]} and ${RANK_PLURAL[nib(1)]}`;
    case Category.OnePair:
      return `Pair of ${RANK_PLURAL[nib(0)]}`;
    default:
      return `${RANK_SINGULAR[nib(0)]} High`;
  }
}

/** Orders five cards the way a dealer would read them: groups first, wheel with the ace last. */
function displayOrder(five: Card[], score: number): Card[] {
  const counts = new Map<number, number>();
  for (const c of five) counts.set(rankOf(c), (counts.get(rankOf(c)) ?? 0) + 1);
  const cat = categoryOf(score);
  const isWheel = (cat === Category.Straight || cat === Category.StraightFlush) && ((score >> 16) & 15) === 3;
  const value = (c: Card) => (isWheel && rankOf(c) === 12 ? -1 : rankOf(c));
  return [...five].sort(
    (a, b) => counts.get(rankOf(b))! - counts.get(rankOf(a))! || value(b) - value(a) || suitOf(b) - suitOf(a),
  );
}

/** Full evaluation including the exact winning five cards. Rejects duplicate cards. */
export function evaluateHand(cards: readonly Card[]): EvaluatedHand {
  if (cards.length < 5 || cards.length > 7) throw new Error(`Hand evaluation needs 5-7 cards, got ${cards.length}`);
  if (new Set(cards).size !== cards.length) throw new Error('Hand contains duplicate cards');
  for (const c of cards) if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error(`Invalid card ${c}`);

  const score = scoreHand(cards);
  const n = cards.length;
  let bestFive: Card[] | null = null;
  // One or more five-card subsets reach the seven-card score; take the first.
  outer: for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            if (scoreHand(five) === score) {
              bestFive = five;
              break outer;
            }
          }
  if (!bestFive) throw new Error('Evaluator invariant violated: no five-card subset reaches the score');
  const category = categoryOf(score);
  return {
    score,
    category,
    categoryName: CATEGORY_NAMES[category],
    description: describe(score),
    bestFive: displayOrder(bestFive, score),
  };
}

/** Compares two hands of 5..7 cards: >0 when `a` wins, <0 when `b` wins, 0 on a tie. */
export const compareHands = (a: readonly Card[], b: readonly Card[]): number => scoreHand(a) - scoreHand(b);

export const rankName = (rank: number): string => RANK_SINGULAR[rank];
export const rankChar = (rank: number): string => RANK_CHARS[rank];

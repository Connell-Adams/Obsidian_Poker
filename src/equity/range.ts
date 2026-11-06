import { type Card, handClass, makeCard, RANK_CHARS, rankOf, suitOf } from '../engine/cards';
import { PREFLOP_ORDER } from './preflopData';

export interface WeightedCombo {
  a: Card;
  b: Card;
  w: number;
}
export type Range = WeightedCombo[];

/** All 1326 two-card combinations, with the percentile of their starting-hand class. */
export interface ComboInfo {
  a: Card;
  b: Card;
  cls: string;
  /** Fraction of all combos at least as strong as this class's top, 0 = best hand. */
  pct: number;
}

const classSize = (cls: string): number => (cls.length === 2 ? 6 : cls[2] === 's' ? 4 : 12);

/** Percentile of each of the 169 classes: midpoint of its cumulative combo interval. */
export const CLASS_PERCENTILE: Readonly<Record<string, number>> = (() => {
  const out: Record<string, number> = {};
  let cumulative = 0;
  for (const cls of PREFLOP_ORDER) {
    const size = classSize(cls);
    out[cls] = (cumulative + size / 2) / 1326;
    cumulative += size;
  }
  return out;
})();

export const ALL_COMBOS: readonly ComboInfo[] = (() => {
  const out: ComboInfo[] = [];
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      const cls = handClass(a, b);
      out.push({ a, b, cls, pct: CLASS_PERCENTILE[cls] });
    }
  }
  return out;
})();

export const handPercentile = (a: Card, b: Card): number => CLASS_PERCENTILE[handClass(a, b)];

/** The strongest `fraction` of starting hands. `soft` blurs the edge so ranges are not razor sharp. */
export function topPercentRange(fraction: number, soft = 0): Range {
  const out: Range = [];
  for (const c of ALL_COMBOS) {
    const w = soft > 0 ? clamp01((fraction - c.pct) / soft + 0.5) : c.pct <= fraction ? 1 : 0;
    if (w > 0) out.push({ a: c.a, b: c.b, w });
  }
  return out;
}

/** Hands between two percentiles, e.g. a calling range excluding what would have 3-bet. */
export function bandRange(from: number, to: number, soft = 0): Range {
  const out: Range = [];
  for (const c of ALL_COMBOS) {
    const upper = soft > 0 ? clamp01((to - c.pct) / soft + 0.5) : c.pct <= to ? 1 : 0;
    const lower = soft > 0 ? clamp01((c.pct - from) / soft + 0.5) : c.pct >= from ? 1 : 0;
    const w = upper * lower;
    if (w > 0) out.push({ a: c.a, b: c.b, w });
  }
  return out;
}

export function removeDead(range: Range, dead: readonly Card[]): Range {
  if (dead.length === 0) return range;
  return range.filter((c) => !dead.includes(c.a) && !dead.includes(c.b));
}

export const rangeCombos = (range: Range): number => range.reduce((sum, c) => sum + c.w, 0);

/** Share of all 1326 combos represented, weight included. */
export const rangeShare = (range: Range): number => rangeCombos(range) / 1326;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const RANK_INDEX = (ch: string): number => {
  const r = RANK_CHARS.indexOf(ch.toUpperCase());
  if (r < 0) throw new Error(`Unknown rank "${ch}"`);
  return r;
};

function classCombos(hi: number, lo: number, kind: 'p' | 's' | 'o' | 'any'): Array<[Card, Card]> {
  const out: Array<[Card, Card]> = [];
  if (hi === lo) {
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = s1 + 1; s2 < 4; s2++) out.push([makeCard(hi, s1), makeCard(hi, s2)]);
    return out;
  }
  for (let s1 = 0; s1 < 4; s1++) {
    for (let s2 = 0; s2 < 4; s2++) {
      const suited = s1 === s2;
      if ((kind === 's' && !suited) || (kind === 'o' && suited)) continue;
      out.push([makeCard(hi, s1), makeCard(lo, s2)]);
    }
  }
  return out;
}

/**
 * Parses range text used by the equity calculator: "QQ+, 99-77, AKs, ATs+, KQo,
 * T9s, AsKd, top15%". Whitespace and commas separate tokens. Throws on bad input
 * with a message suitable for showing to the user.
 */
export function parseRange(text: string): Range {
  const seen = new Map<number, WeightedCombo>();
  const add = (a: Card, b: Card) => {
    const key = Math.min(a, b) * 52 + Math.max(a, b);
    if (a !== b && !seen.has(key)) seen.set(key, { a: Math.min(a, b), b: Math.max(a, b), w: 1 });
  };

  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const token = raw.trim();
    const pct = token.match(/^(?:top)?(\d+(?:\.\d+)?)%$/i);
    if (pct) {
      for (const c of topPercentRange(Number(pct[1]) / 100)) add(c.a, c.b);
      continue;
    }
    const exact = token.match(/^([2-9TJQKAtjqka])([cdhs])([2-9TJQKAtjqka])([cdhs])$/);
    if (exact) {
      add(makeCard(RANK_INDEX(exact[1]), 'cdhs'.indexOf(exact[2])), makeCard(RANK_INDEX(exact[3]), 'cdhs'.indexOf(exact[4])));
      continue;
    }
    const dash = token.match(/^([2-9TJQKAtjqka])([2-9TJQKAtjqka])([so]?)-([2-9TJQKAtjqka])([2-9TJQKAtjqka])([so]?)$/);
    if (dash) {
      const [r1, r2, r3, r4] = [dash[1], dash[2], dash[4], dash[5]].map(RANK_INDEX);
      if (r1 === r2 && r3 === r4) {
        for (let r = Math.min(r1, r3); r <= Math.max(r1, r3); r++) for (const [a, b] of classCombos(r, r, 'p')) add(a, b);
      } else if (r1 === r3) {
        const kind = (dash[3] || 'any') as 's' | 'o' | 'any';
        for (let lo = Math.min(r2, r4); lo <= Math.max(r2, r4); lo++) for (const [a, b] of classCombos(r1, lo, kind)) add(a, b);
      } else {
        throw new Error(`Cannot read the range "${token}". Use forms like 99-66 or A9s-A5s.`);
      }
      continue;
    }
    const single = token.match(/^([2-9TJQKAtjqka])([2-9TJQKAtjqka])([so]?)(\+?)$/);
    if (!single) throw new Error(`Cannot read "${token}". Examples: QQ+, AKs, T9o, AsKd, top15%`);
    let hi = RANK_INDEX(single[1]);
    let lo = RANK_INDEX(single[2]);
    if (lo > hi) [hi, lo] = [lo, hi];
    const plus = single[4] === '+';
    if (hi === lo) {
      for (let r = hi; r <= (plus ? 12 : hi); r++) for (const [a, b] of classCombos(r, r, 'p')) add(a, b);
    } else {
      const kind = (single[3] || 'any') as 's' | 'o' | 'any';
      for (let k = lo; k <= (plus ? hi - 1 : lo); k++) for (const [a, b] of classCombos(hi, k, kind)) add(a, b);
    }
  }
  if (seen.size === 0) throw new Error('The range is empty');
  return [...seen.values()];
}

/** A short readable summary of a weighted range for coach explanations. */
export function describeRange(range: Range): string {
  const total = rangeCombos(range);
  if (total <= 0) return 'no hands';
  const share = (total / 1326) * 100;
  const byClass = new Map<string, number>();
  for (const c of range) {
    const cls = handClass(c.a, c.b);
    byClass.set(cls, (byClass.get(cls) ?? 0) + c.w);
  }
  const top = [...byClass.entries()]
    .sort((x, y) => CLASS_PERCENTILE[x[0]] - CLASS_PERCENTILE[y[0]])
    .filter(([, w]) => w >= 0.5)
    .slice(0, 5)
    .map(([cls]) => cls);
  return `about ${share < 1 ? share.toFixed(1) : share.toFixed(0)}% of hands${top.length ? `, led by ${top.join(', ')}` : ''}`;
}

export { rankOf, suitOf };

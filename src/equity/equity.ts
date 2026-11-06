import type { Card } from '../engine/cards';
import { scoreHand } from '../engine/evaluator';
import type { Rng } from '../engine/rng';
import type { Range } from './range';

export interface EquityResult {
  /** Share of the pot won on average, ties split. 0..1 */
  equity: number;
  win: number;
  tie: number;
  samples: number;
  /** True when every possible board was enumerated, so `stderr` is zero. */
  exact: boolean;
  /** Standard error of `equity` under Monte Carlo. */
  stderr: number;
}

const remainingCards = (dead: readonly Card[]): Card[] => {
  const used = new Uint8Array(52);
  for (const c of dead) used[c] = 1;
  const out: Card[] = [];
  for (let c = 0; c < 52; c++) if (!used[c]) out.push(c);
  return out;
};

const choose = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
};

/** Calls `visit` with `seven` filled for each possible completion of the board. */
function forEachBoard(known: readonly Card[], stubs: Card[], visit: (board: Int32Array) => void): void {
  const board = new Int32Array(5);
  for (let i = 0; i < known.length; i++) board[i] = known[i];
  const need = 5 - known.length;
  const n = stubs.length;
  if (need === 0) {
    visit(board);
    return;
  }
  const start = known.length;
  const recurse = (depth: number, from: number) => {
    for (let i = from; i <= n - (need - depth); i++) {
      board[start + depth] = stubs[i];
      if (depth + 1 === need) visit(board);
      else recurse(depth + 1, i + 1);
    }
  };
  recurse(0, 0);
}

/** Exact hand-vs-hand equity by enumerating every board. Preflop this is 1.7M boards. */
export function handVsHandExact(hero: readonly [Card, Card], villain: readonly [Card, Card], board: readonly Card[]): EquityResult {
  const dead = [...hero, ...villain, ...board];
  if (new Set(dead).size !== dead.length) throw new Error('Duplicate cards in the matchup');
  const stubs = remainingCards(dead);
  const seven = new Int32Array(7);
  const other = new Int32Array(7);
  seven[0] = hero[0];
  seven[1] = hero[1];
  other[0] = villain[0];
  other[1] = villain[1];
  let wins = 0;
  let ties = 0;
  let total = 0;
  forEachBoard(board, stubs, (b) => {
    for (let i = 0; i < 5; i++) {
      seven[i + 2] = b[i];
      other[i + 2] = b[i];
    }
    const h = scoreHand(seven, 7);
    const v = scoreHand(other, 7);
    if (h > v) wins++;
    else if (h === v) ties++;
    total++;
  });
  return { equity: (wins + ties / 2) / total, win: wins / total, tie: ties / total, samples: total, exact: true, stderr: 0 };
}

/** Exact equity against a weighted range. Only feasible on later streets; see `equityVsRange`. */
export function handVsRangeExact(hero: readonly [Card, Card], range: Range, board: readonly Card[]): EquityResult {
  const dead = [...hero, ...board];
  const seven = new Int32Array(7);
  const other = new Int32Array(7);
  seven[0] = hero[0];
  seven[1] = hero[1];
  let winWeight = 0;
  let tieWeight = 0;
  let totalWeight = 0;
  let samples = 0;
  for (const combo of range) {
    if (combo.w <= 0 || dead.includes(combo.a) || dead.includes(combo.b)) continue;
    other[0] = combo.a;
    other[1] = combo.b;
    const stubs = remainingCards([...dead, combo.a, combo.b]);
    let wins = 0;
    let ties = 0;
    let total = 0;
    forEachBoard(board, stubs, (b) => {
      for (let i = 0; i < 5; i++) {
        seven[i + 2] = b[i];
        other[i + 2] = b[i];
      }
      const h = scoreHand(seven, 7);
      const v = scoreHand(other, 7);
      if (h > v) wins++;
      else if (h === v) ties++;
      total++;
    });
    winWeight += (combo.w * wins) / total;
    tieWeight += (combo.w * ties) / total;
    totalWeight += combo.w;
    samples += total;
  }
  if (totalWeight === 0) return { equity: 1, win: 1, tie: 0, samples: 0, exact: true, stderr: 0 };
  const win = winWeight / totalWeight;
  const tie = tieWeight / totalWeight;
  return { equity: win + tie / 2, win, tie, samples, exact: true, stderr: 0 };
}

/** Weighted sampler that picks combos in O(log n). */
class RangeSampler {
  private readonly cumulative: Float64Array;
  private readonly combos: Range;
  readonly total: number;

  constructor(range: Range) {
    this.combos = range.filter((c) => c.w > 0);
    this.cumulative = new Float64Array(this.combos.length);
    let sum = 0;
    for (let i = 0; i < this.combos.length; i++) {
      sum += this.combos[i].w;
      this.cumulative[i] = sum;
    }
    this.total = sum;
  }

  sample(rng: Rng): number {
    const target = rng.next() * this.total;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] > target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  at(index: number): { a: Card; b: Card } {
    return this.combos[index];
  }
}

/**
 * Monte Carlo equity of `hero` against one range per opponent, all staying to
 * showdown. Opponent combos that collide with known cards are rejected and
 * resampled, so card removal is respected.
 */
export function multiwayEquity(
  hero: readonly [Card, Card],
  opponents: readonly Range[],
  board: readonly Card[],
  iterations: number,
  rng: Rng,
): EquityResult {
  const samplers = opponents.map((r) => new RangeSampler(r));
  const seven = new Int32Array(7);
  seven[0] = hero[0];
  seven[1] = hero[1];
  const other = new Int32Array(7);
  for (let i = 0; i < board.length; i++) {
    seven[i + 2] = board[i];
    other[i + 2] = board[i];
  }
  const fixed = new Uint8Array(52);
  fixed[hero[0]] = 1;
  fixed[hero[1]] = 1;
  for (const c of board) fixed[c] = 1;
  const used = new Uint8Array(52);
  const villainCards = new Int32Array(opponents.length * 2);
  const need = 5 - board.length;

  let equitySum = 0;
  let equitySquares = 0;
  let wins = 0;
  let ties = 0;
  let samples = 0;

  for (let iter = 0; iter < iterations; iter++) {
    used.set(fixed);
    let ok = true;
    for (let v = 0; v < samplers.length && ok; v++) {
      let tries = 0;
      for (;;) {
        if (samplers[v].total <= 0 || tries++ > 64) {
          ok = false;
          break;
        }
        const combo = samplers[v].at(samplers[v].sample(rng));
        if (!used[combo.a] && !used[combo.b]) {
          used[combo.a] = 1;
          used[combo.b] = 1;
          villainCards[v * 2] = combo.a;
          villainCards[v * 2 + 1] = combo.b;
          break;
        }
      }
    }
    if (!ok) continue;

    for (let k = 0; k < need; k++) {
      let card = rng.int(52);
      while (used[card]) card = rng.int(52);
      used[card] = 1;
      seven[2 + board.length + k] = card;
      other[2 + board.length + k] = card;
    }
    const heroScore = scoreHand(seven, 7);
    let best = heroScore;
    let tiedWith = 0;
    for (let v = 0; v < samplers.length; v++) {
      other[0] = villainCards[v * 2];
      other[1] = villainCards[v * 2 + 1];
      const score = scoreHand(other, 7);
      if (score > best) {
        best = score;
        tiedWith = -1000;
      } else if (score === best && best === heroScore) {
        tiedWith++;
      }
    }
    samples++;
    let share = 0;
    if (best === heroScore && tiedWith >= 0) {
      if (tiedWith === 0) {
        share = 1;
        wins++;
      } else {
        share = 1 / (tiedWith + 1);
        ties++;
      }
    }
    equitySum += share;
    equitySquares += share * share;
  }

  if (samples === 0) return { equity: 0, win: 0, tie: 0, samples: 0, exact: false, stderr: 0 };
  const mean = equitySum / samples;
  const variance = Math.max(0, equitySquares / samples - mean * mean);
  return {
    equity: mean,
    win: wins / samples,
    tie: ties / samples,
    samples,
    exact: false,
    stderr: Math.sqrt(variance / samples),
  };
}

export interface EquityOptions {
  iterations: number;
  rng: Rng;
  /** Largest number of evaluations allowed for exact enumeration. */
  maxExactEvaluations?: number;
}

/**
 * Equity against a range. Uses exact enumeration when the number of runouts is
 * small enough, otherwise Monte Carlo, and reports which one was used.
 */
export function equityVsRange(hero: readonly [Card, Card], range: Range, board: readonly Card[], options: EquityOptions): EquityResult {
  const live = range.filter((c) => c.w > 0).length;
  const boards = choose(48 - board.length, 5 - board.length);
  if (live * boards * 2 <= (options.maxExactEvaluations ?? 4_000_000)) return handVsRangeExact(hero, range, board);
  return multiwayEquity(hero, [range], board, options.iterations, options.rng);
}

/** Range-versus-range equity for the first range, sampled with card removal respected. */
export function rangeVsRange(a: Range, b: Range, board: readonly Card[], iterations: number, rng: Rng): EquityResult {
  const sa = new RangeSampler(a);
  const sb = new RangeSampler(b);
  if (sa.total <= 0 || sb.total <= 0) throw new Error('Both ranges must contain at least one hand');
  const seven = new Int32Array(7);
  const other = new Int32Array(7);
  for (let i = 0; i < board.length; i++) {
    seven[i + 2] = board[i];
    other[i + 2] = board[i];
  }
  const fixed = new Uint8Array(52);
  for (const c of board) fixed[c] = 1;
  const used = new Uint8Array(52);
  const need = 5 - board.length;
  let wins = 0;
  let ties = 0;
  let samples = 0;

  for (let iter = 0; iter < iterations; iter++) {
    used.set(fixed);
    const ca = sa.at(sa.sample(rng));
    if (used[ca.a] || used[ca.b]) continue;
    used[ca.a] = 1;
    used[ca.b] = 1;
    const cb = sb.at(sb.sample(rng));
    if (used[cb.a] || used[cb.b]) continue;
    used[cb.a] = 1;
    used[cb.b] = 1;
    seven[0] = ca.a;
    seven[1] = ca.b;
    other[0] = cb.a;
    other[1] = cb.b;
    for (let k = 0; k < need; k++) {
      let card = rng.int(52);
      while (used[card]) card = rng.int(52);
      used[card] = 1;
      seven[2 + board.length + k] = card;
      other[2 + board.length + k] = card;
    }
    const sA = scoreHand(seven, 7);
    const sB = scoreHand(other, 7);
    if (sA > sB) wins++;
    else if (sA === sB) ties++;
    samples++;
  }
  if (samples === 0) throw new Error('The ranges and board leave no possible matchup');
  const win = wins / samples;
  const tie = ties / samples;
  const equity = win + tie / 2;
  return { equity, win, tie, samples, exact: false, stderr: Math.sqrt((equity * (1 - equity)) / samples) };
}

import { parseCards } from '../engine/cards';
import type { Rng } from '../engine/rng';
import { equityVsRange, type EquityResult, handVsHandExact, rangeVsRange } from '../equity/equity';
import { describeRange, parseRange, removeDead } from '../equity/range';

export interface EquityQuery {
  /** Two exact cards ("AsKd") or a range ("QQ+, AKs"). */
  sideA: string;
  sideB: string;
  board: string;
  iterations: number;
}

export interface EquityQueryResult {
  mode: 'hand_vs_hand' | 'hand_vs_range' | 'range_vs_hand' | 'range_vs_range';
  a: EquityResult;
  /** Equity of side B: 1 minus side A, reported for readability. */
  bEquity: number;
  describeA: string;
  describeB: string;
}

const isExactHand = (text: string): boolean => /^\s*[2-9TJQKA][cdhs]\s*[2-9TJQKA][cdhs]\s*$/i.test(text);

/** The calculator's single entry point: picks exact enumeration when it is practical. */
export function runEquityQuery(query: EquityQuery, rng: Rng): EquityQueryResult {
  const board = query.board.trim() ? parseCards(query.board) : [];
  if (![0, 3, 4, 5].includes(board.length)) throw new Error('The board must have 0, 3, 4 or 5 cards');
  if (new Set(board).size !== board.length) throw new Error('The board has a duplicate card');

  const aExact = isExactHand(query.sideA);
  const bExact = isExactHand(query.sideB);
  if (aExact && bExact) {
    const a = parseCards(query.sideA) as [number, number];
    const b = parseCards(query.sideB) as [number, number];
    const result = handVsHandExact(a, b, board);
    return { mode: 'hand_vs_hand', a: result, bEquity: 1 - result.equity, describeA: query.sideA.trim(), describeB: query.sideB.trim() };
  }
  if (aExact) {
    const a = parseCards(query.sideA) as [number, number];
    const range = removeDead(parseRange(query.sideB), [...a, ...board]);
    if (range.length === 0) throw new Error('Those cards leave no possible hands in the range');
    const result = equityVsRange(a, range, board, { iterations: query.iterations, rng });
    return { mode: 'hand_vs_range', a: result, bEquity: 1 - result.equity, describeA: query.sideA.trim(), describeB: describeRange(range) };
  }
  if (bExact) {
    const b = parseCards(query.sideB) as [number, number];
    const range = removeDead(parseRange(query.sideA), [...b, ...board]);
    if (range.length === 0) throw new Error('Those cards leave no possible hands in the range');
    const mirrored = equityVsRange(b, range, board, { iterations: query.iterations, rng });
    const result: EquityResult = { ...mirrored, equity: 1 - mirrored.equity, win: 1 - mirrored.equity - mirrored.tie / 2 };
    return { mode: 'range_vs_hand', a: result, bEquity: mirrored.equity, describeA: describeRange(range), describeB: query.sideB.trim() };
  }
  const rangeA = removeDead(parseRange(query.sideA), board);
  const rangeB = removeDead(parseRange(query.sideB), board);
  const result = rangeVsRange(rangeA, rangeB, board, query.iterations, rng);
  return { mode: 'range_vs_range', a: result, bEquity: 1 - result.equity, describeA: describeRange(rangeA), describeB: describeRange(rangeB) };
}

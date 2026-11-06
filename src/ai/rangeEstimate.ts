import { type Card, rankOf, suitOf } from '../engine/cards';
import { Category, scoreHand } from '../engine/evaluator';
import type { BettingStreet } from '../engine/hand';
import { ALL_COMBOS, type Range } from '../equity/range';
import type { PlayerRead } from '../stats/counters';
import type { PublicAction } from './view';

const COMBO_COUNT = ALL_COMBOS.length;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export interface RangeContext {
  players: ReadonlyArray<{ seat: number; position: string }>;
  actions: readonly PublicAction[];
  boardByStreet: Readonly<Partial<Record<BettingStreet, readonly Card[]>>>;
  /** Cards the estimator knows are unavailable: its own hole cards and the board. */
  dead: readonly Card[];
  bigBlind: number;
}

/** A belief over the 1326 combos. Weight 0 means the combo is impossible or discounted away. */
export interface EstimatedRange {
  weights: Float64Array;
  /** 0 (weakest in range) .. 1 (strongest in range) on the latest street seen. */
  strength: Float32Array;
  /** Plain-language note on how the range was formed, for the coach. */
  notes: string[];
}

function positionFactor(position: string): number {
  switch (position) {
    case 'UTG':
    case 'UTG+1':
      return 0.65;
    case 'UTG+2':
    case 'MP':
      return 0.8;
    case 'HJ':
      return 0.95;
    case 'CO':
      return 1.2;
    case 'BTN':
      return 1.6;
    case 'SB':
      return 1.2;
    default:
      return 1;
  }
}

function fillBand(weights: Float64Array, from: number, to: number, soft: number): void {
  for (let i = 0; i < COMBO_COUNT; i++) {
    const pct = ALL_COMBOS[i].pct;
    const upper = clamp((to - pct) / soft + 0.5, 0, 1);
    const lower = from <= 0 ? 1 : clamp((pct - from) / soft + 0.5, 0, 1);
    weights[i] = upper * lower;
  }
}

/**
 * The preflop belief, from a player's position, public action and their observed
 * tendencies. The read already includes population priors for small samples.
 */
function preflopBelief(ctx: RangeContext, seat: number, read: PlayerRead, notes: string[]): Float64Array {
  const weights = new Float64Array(COMBO_COUNT);
  const position = ctx.players.find((p) => p.seat === seat)?.position ?? 'MP';
  const factor = positionFactor(position);
  let raises = 0;
  let lastAction: PublicAction | null = null;
  let raisesBeforeLast = 0;
  for (const a of ctx.actions) {
    if (a.street !== 'preflop') break;
    if (a.seat === seat) {
      lastAction = a;
      raisesBeforeLast = raises;
    }
    if (a.action === 'raise') raises++;
  }
  const pfr = clamp(read.pfr * factor, 0.02, 0.9);
  const threeBet = clamp(read.threeBet * Math.sqrt(factor), 0.01, 0.4);
  const vpip = clamp(read.vpip, 0.05, 0.98);

  if (!lastAction) {
    fillBand(weights, 0, 1, 0.05);
    notes.push('has not acted yet, so any two cards are still possible');
    return weights;
  }
  if (lastAction.action === 'raise') {
    if (raisesBeforeLast === 0) {
      const shove = lastAction.allIn && lastAction.to < ctx.bigBlind * 15;
      const top = shove ? Math.max(pfr, 0.25) : pfr;
      fillBand(weights, 0, top, 0.03);
      notes.push(`opened from ${position}, modelled as the top ${Math.round(top * 100)}% of hands`);
    } else if (raisesBeforeLast === 1) {
      fillBand(weights, 0, threeBet, 0.012);
      notes.push(`3-bet, modelled as the top ${Math.round(threeBet * 100)}% of hands`);
    } else {
      const top = clamp(threeBet * 0.45, 0.012, 0.06);
      fillBand(weights, 0, top, 0.006);
      notes.push(`re-raised a 3-bet, modelled as the top ${(top * 100).toFixed(1)}% of hands`);
    }
  } else if (lastAction.action === 'call') {
    if (raisesBeforeLast === 0) {
      fillBand(weights, Math.min(pfr * 0.6, 0.2), clamp(vpip * 1.1, 0.1, 1), 0.04);
      notes.push(`limped, capped below their usual raising hands`);
    } else if (raisesBeforeLast === 1) {
      const wide = position === 'BB' ? clamp(vpip * 1.7, 0.3, 0.7) : position === 'SB' ? clamp(vpip * 1.1, 0.12, 0.45) : clamp(vpip * 0.9, 0.08, 0.5);
      fillBand(weights, threeBet * 0.6, wide, 0.03);
      notes.push(`called a raise from ${position}, modelled up to the top ${Math.round(wide * 100)}% without their 3-bets`);
    } else {
      fillBand(weights, 0.012, Math.max(threeBet * 0.9, 0.06), 0.012);
      notes.push('called a 3-bet, which is a strong and narrow range');
    }
  } else if (lastAction.action === 'check') {
    fillBand(weights, Math.min(pfr * 0.5, 0.15), 1, 0.05);
    notes.push('checked the big blind option, so most strong hands would have raised');
  } else {
    fillBand(weights, 0, 1, 0.05);
  }
  return weights;
}

/**
 * Comparable hand value used to rank a range on a board. Draws are lifted to the
 * level of a pair so that semi-bluffs stay in betting ranges, as they would in play.
 */
function boardValue(a: Card, b: Card, board: readonly Card[], scratch: Int32Array): number {
  scratch[0] = a;
  scratch[1] = b;
  for (let i = 0; i < board.length; i++) scratch[i + 2] = board[i];
  const score = scoreHand(scratch, board.length + 2);
  if (board.length >= 5 || score >> 20 > Category.OnePair) return score;
  const suitsOnBoard = [0, 0, 0, 0];
  let rankMask = 0;
  for (const c of board) {
    suitsOnBoard[suitOf(c)]++;
    rankMask |= 1 << rankOf(c);
  }
  rankMask |= (1 << rankOf(a)) | (1 << rankOf(b));
  const sa = suitOf(a);
  const sb = suitOf(b);
  const flushDraw = suitsOnBoard[sa] + 1 + (sa === sb ? 1 : 0) === 4 || suitsOnBoard[sb] + 1 + (sa === sb ? 1 : 0) === 4;
  if (rankMask & (1 << 12)) rankMask |= 1 << 13;
  let straightDraw = false;
  for (let low = 0; low <= 9 && !straightDraw; low++) {
    const run = (rankMask >> low) & 0b11111;
    const count = (run & 1) + ((run >> 1) & 1) + ((run >> 2) & 1) + ((run >> 3) & 1) + ((run >> 4) & 1);
    if (count >= 4) straightDraw = true;
  }
  const isHighCard = score >> 20 === Category.HighCard;
  if (flushDraw && straightDraw) return Math.max(score, (Category.TwoPair << 20) | (2 << 16));
  if (flushDraw) return Math.max(score, isHighCard ? (Category.OnePair << 20) | (9 << 16) : (Category.TwoPair << 20));
  if (straightDraw) return Math.max(score, isHighCard ? (Category.OnePair << 20) | (6 << 16) : score + (1 << 15));
  return score;
}

/** Ranks every live combo on the board and writes a weighted percentile to `strength`. */
export function rankOnBoard(weights: Float64Array, board: readonly Card[], strength: Float32Array): void {
  const scratch = new Int32Array(7);
  const values = new Float64Array(COMBO_COUNT);
  const live: number[] = [];
  let total = 0;
  for (let i = 0; i < COMBO_COUNT; i++) {
    if (weights[i] <= 0) continue;
    const c = ALL_COMBOS[i];
    values[i] = boardValue(c.a, c.b, board, scratch);
    live.push(i);
    total += weights[i];
  }
  live.sort((x, y) => values[x] - values[y]);
  let running = 0;
  for (const i of live) {
    running += weights[i];
    strength[i] = total > 0 ? (running - weights[i] / 2) / total : 0;
  }
}

/** Discounts a range after a public action, using how the player tends to play. */
function applyAction(weights: Float64Array, strength: Float32Array, action: PublicAction, read: PlayerRead): void {
  const afq = read.afq;
  const raisePart = Math.max(0, action.added - action.facing);
  const base = action.potBefore + action.facing;
  const ratio = base > 0 ? raisePart / base : 0.66;

  if (action.action === 'bet' || action.action === 'raise') {
    let valueShare = clamp((0.2 + 0.8 * afq) / (0.72 + 0.45 * Math.min(ratio, 2)), 0.08, 0.75);
    if (action.action === 'raise') valueShare *= 0.62;
    const bluffWeight = clamp(0.06 + 0.45 * afq, 0.05, 0.42) * (action.action === 'raise' ? 0.55 : 1);
    const edge = 1 - valueShare;
    for (let i = 0; i < COMBO_COUNT; i++) {
      if (weights[i] <= 0) continue;
      weights[i] *= strength[i] >= edge ? 1 : bluffWeight + (1 - bluffWeight) * clamp((strength[i] - edge + 0.08) / 0.08, 0, 1);
    }
  } else if (action.action === 'call') {
    const callRatio = action.potBefore > 0 ? action.facing / action.potBefore : 0.5;
    const stay = clamp(0.8 - 0.22 * Math.min(callRatio, 2) + 0.15 * (read.wtsd - 0.3), 0.2, 0.92);
    const edge = 1 - stay;
    for (let i = 0; i < COMBO_COUNT; i++) {
      if (weights[i] <= 0) continue;
      const lower = clamp((strength[i] - edge + 0.08) / 0.08, 0.04, 1);
      const upper = strength[i] > 0.94 ? 0.5 : 1; // the very top usually raises
      weights[i] *= lower * upper;
    }
  } else if (action.action === 'check') {
    const keep = 0.3 + 0.45 * (1 - afq);
    for (let i = 0; i < COMBO_COUNT; i++) {
      if (weights[i] > 0 && strength[i] > 0.8) weights[i] *= keep;
    }
  }
}

const STREETS: readonly BettingStreet[] = ['flop', 'turn', 'river'];

/**
 * Bayesian-flavoured estimate of a player's range from public information only:
 * position, the action sequence and observed tendencies. Hole cards of other
 * players are never an input.
 */
export function estimateRange(ctx: RangeContext, seat: number, read: PlayerRead): EstimatedRange {
  const notes: string[] = [];
  const weights = preflopBelief(ctx, seat, read, notes);
  for (let i = 0; i < COMBO_COUNT; i++) {
    const c = ALL_COMBOS[i];
    if (ctx.dead.includes(c.a) || ctx.dead.includes(c.b)) weights[i] = 0;
  }
  const strength = new Float32Array(COMBO_COUNT);
  for (let i = 0; i < COMBO_COUNT; i++) strength[i] = 1 - ALL_COMBOS[i].pct;

  for (const street of STREETS) {
    const board = ctx.boardByStreet[street];
    if (!board) break;
    rankOnBoard(weights, board, strength);
    let acted = false;
    for (const a of ctx.actions) {
      if (a.street === street && a.seat === seat) {
        applyAction(weights, strength, a, read);
        acted = true;
      }
    }
    if (acted) rankOnBoard(weights, board, strength);
  }
  return { weights, strength, notes };
}

/** Converts a belief to a samplable range, optionally keeping only the strongest part. */
export function toRange(estimate: EstimatedRange, topFraction = 1): Range {
  const out: Range = [];
  const cut = 1 - topFraction;
  for (let i = 0; i < COMBO_COUNT; i++) {
    const w = estimate.weights[i];
    if (w > 0.001 && estimate.strength[i] >= cut) out.push({ a: ALL_COMBOS[i].a, b: ALL_COMBOS[i].b, w });
  }
  return out;
}

/** Share of all combos remaining, weight included. */
export function estimateShare(estimate: EstimatedRange): number {
  let total = 0;
  for (let i = 0; i < COMBO_COUNT; i++) total += estimate.weights[i];
  return total / COMBO_COUNT;
}

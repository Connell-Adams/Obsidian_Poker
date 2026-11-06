import type { Card } from '../engine/cards';
import { scoreHand } from '../engine/evaluator';
import type { Rng } from '../engine/rng';
import { splitPot } from '../engine/pots';
import type { AllInEquity, HandRecord } from '../history/record';

/**
 * All-in equity from revealed cards: what each player's share of every pot was worth
 * when the money went in, against what they actually received. Only runs for hands
 * whose cards were turned face up by the all-in, so nothing hidden is used.
 */
export function computeAllInEquity(record: HandRecord, rng: Rng, samples = 12000): AllInEquity[] | undefined {
  if (!record.allInRunout) return undefined;
  const reveal = record.events.find((e) => e.t === 'allin_reveal');
  if (!reveal || reveal.t !== 'allin_reveal') return undefined;
  const revealIndex = record.events.indexOf(reveal);
  let knownBoard: Card[] = [];
  for (let i = 0; i < revealIndex; i++) {
    const e = record.events[i];
    if (e.t === 'board') knownBoard = e.board;
  }

  const hands = reveal.hands;
  const seatOrder = record.players.map((p) => p.seat);
  const dead = new Uint8Array(52);
  for (const h of hands) {
    dead[h.cards[0]] = 1;
    dead[h.cards[1]] = 1;
  }
  for (const c of knownBoard) dead[c] = 1;
  const stubs: Card[] = [];
  for (let c = 0; c < 52; c++) if (!dead[c]) stubs.push(c);

  const need = 5 - knownBoard.length;
  const board = new Int32Array(5);
  for (let i = 0; i < knownBoard.length; i++) board[i] = knownBoard[i];
  const seven = new Int32Array(7);
  const scores = new Map<number, number>();
  const expected = new Map<number, number>(hands.map((h) => [h.seat, 0]));
  const scratch = [...stubs];

  const evaluate = () => {
    for (const h of hands) {
      seven[0] = h.cards[0];
      seven[1] = h.cards[1];
      for (let i = 0; i < 5; i++) seven[i + 2] = board[i];
      scores.set(h.seat, scoreHand(seven, 7));
    }
    for (const pot of record.pots) {
      let best = -1;
      for (const seat of pot.eligible) best = Math.max(best, scores.get(seat) ?? -1);
      const winners = pot.eligible.filter((seat) => scores.get(seat) === best);
      for (const w of splitPot(pot.amount, winners, seatOrder)) expected.set(w.seat, (expected.get(w.seat) ?? 0) + w.amount);
    }
  };

  let runs = 0;
  const combos = need === 0 ? 1 : need === 1 ? stubs.length : need === 2 ? (stubs.length * (stubs.length - 1)) / 2 : Infinity;
  if (combos <= samples) {
    const recurse = (depth: number, from: number) => {
      if (depth === need) {
        evaluate();
        runs++;
        return;
      }
      for (let i = from; i < stubs.length; i++) {
        board[knownBoard.length + depth] = stubs[i];
        recurse(depth + 1, i + 1);
      }
    };
    recurse(0, 0);
  } else {
    for (let s = 0; s < samples; s++) {
      for (let k = 0; k < need; k++) {
        const j = k + rng.int(scratch.length - k);
        const t = scratch[k];
        scratch[k] = scratch[j];
        scratch[j] = t;
        board[knownBoard.length + k] = scratch[k];
      }
      evaluate();
      runs++;
    }
  }

  const totalPot = record.pots.reduce((sum, p) => sum + p.amount, 0);
  return hands.map((h) => {
    const share = (expected.get(h.seat) ?? 0) / runs;
    const received = record.pots.reduce((sum, pot) => sum + (pot.winners.find((w) => w.seat === h.seat)?.amount ?? 0), 0);
    return { seat: h.seat, equity: totalPot > 0 ? share / totalPot : 0, evDiff: received - share };
  });
}

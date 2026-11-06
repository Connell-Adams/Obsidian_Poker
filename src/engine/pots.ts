export interface Contribution {
  seat: number;
  /** Total chips this player put in during the hand (after any uncalled refund). */
  amount: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Seats that can win this pot. Folded players never qualify. */
  eligible: number[];
}

/**
 * Splits total contributions into a main pot and side pots.
 *
 * Each distinct contribution level of a live player closes a layer. A layer
 * takes min(contribution, level) - min(contribution, previousLevel) from every
 * player, including folded ones, whose chips stay in as dead money.
 */
export function computePots(contributions: readonly Contribution[]): Pot[] {
  const live = contributions.filter((c) => !c.folded && c.amount > 0);
  const levels = [...new Set(live.map((c) => c.amount))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let previous = 0;

  for (const level of levels) {
    let amount = 0;
    for (const c of contributions) amount += Math.min(c.amount, level) - Math.min(c.amount, previous);
    const eligible = live.filter((c) => c.amount >= level).map((c) => c.seat);
    const last = pots[pots.length - 1];
    if (last && sameSeats(last.eligible, eligible)) last.amount += amount;
    else if (amount > 0) pots.push({ amount, eligible });
    previous = level;
  }

  // Dead money above the highest live level (only reachable via unusual folds).
  let dead = 0;
  for (const c of contributions) dead += Math.max(0, c.amount - previous);
  if (dead > 0) {
    if (pots.length === 0) throw new Error('Chips in the pot but nobody eligible to win them');
    pots[pots.length - 1].amount += dead;
  }
  return pots;
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((seat) => b.includes(seat));
}

/**
 * Splits one pot between winners. Odd chips go one at a time to the winners
 * closest to the left of the button; `seatOrder` lists seats clockwise starting
 * with the first seat left of the button.
 */
export function splitPot(
  amount: number,
  winners: readonly number[],
  seatOrder: readonly number[],
): Array<{ seat: number; amount: number }> {
  if (winners.length === 0) throw new Error('A pot needs at least one winner');
  const ordered = seatOrder.filter((seat) => winners.includes(seat));
  if (ordered.length !== winners.length) throw new Error('Winner missing from the seat order');
  const share = Math.floor(amount / ordered.length);
  const oddChips = amount - share * ordered.length;
  return ordered.map((seat, i) => ({ seat, amount: share + (i < oddChips ? 1 : 0) }));
}

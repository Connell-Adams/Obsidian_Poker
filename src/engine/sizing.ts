import type { LegalActions, PlayerAction } from './hand';

/**
 * The total street bet for a bet or raise of `fraction` of the pot. A raise is
 * sized after the call: to = currentBet + fraction * (pot + toCall). Returns a
 * legal size, clamped to the minimum and maximum, or null if aggression is illegal.
 */
export function potFractionTo(legal: LegalActions, fraction: number): number | null {
  if (!legal.canBet && !legal.canRaise) return null;
  const toCall = Math.max(0, legal.currentBet - legal.streetBet);
  const size = Math.round(fraction * (legal.pot + toCall));
  return clampTo(legal, legal.currentBet + size);
}

/** Multiple of the current bet (or of the big blind when opening). Null if aggression is illegal. */
export function multipleTo(legal: LegalActions, multiple: number): number | null {
  if (!legal.canBet && !legal.canRaise) return null;
  const base = legal.currentBet > 0 ? legal.currentBet : legal.bigBlind;
  return clampTo(legal, Math.round(base * multiple));
}

export function clampTo(legal: LegalActions, to: number): number {
  return Math.max(legal.minTo, Math.min(legal.maxTo, Math.round(to)));
}

/** Builds the correct action for a target size, using the kind the rules require here. */
export function aggressiveAction(legal: LegalActions, to: number): PlayerAction | null {
  if (legal.canBet) return { type: 'bet', to: clampTo(legal, to) };
  if (legal.canRaise) return { type: 'raise', to: clampTo(legal, to) };
  return null;
}

/** Chips leaving the stack if the player commits to this total street bet. */
export const chipsToCommit = (legal: LegalActions, to: number): number => to - legal.streetBet;

/** Pot odds as the fraction of the final pot the caller must pay: call / (pot + call). */
export function potOdds(legal: LegalActions): number {
  return legal.callAmount === 0 ? 0 : legal.callAmount / (legal.pot + legal.callAmount);
}

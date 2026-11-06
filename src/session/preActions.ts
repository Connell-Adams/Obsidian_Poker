import type { LegalActions, PlayerAction } from '../engine/hand';
import { aggressiveAction, multipleTo } from '../engine/sizing';

export type PreActionKind = 'check_fold' | 'fold_any' | 'check' | 'call_any' | 'raise_x';

export interface PreAction {
  kind: PreActionKind;
  /** Raise multiple for `raise_x`, e.g. 2, 2.5, 3, 4 or a custom value. */
  multiple?: number;
  /** The hand this was armed for: a pre-action can never leak into another hand. */
  handNumber: number;
}

export type PreActionResolution =
  /** Execute this action now. */
  | { kind: 'execute'; action: PlayerAction; keepArmed: boolean }
  /** Nothing to do at this decision, but stay armed for a later one. */
  | { kind: 'wait' }
  /** Impossible here: drop it and let the player decide. */
  | { kind: 'cancel'; reason: string };

/**
 * Decides what an armed pre-action does at the moment the player is to act. All
 * rules are checked against the live legal options, so a stale selection can
 * never produce an unintended action:
 *  - Check never becomes a call: it cancels if there is a bet to face.
 *  - Check/Fold checks when free, folds otherwise.
 *  - Fold to Any Bet folds to any positive amount, and otherwise leaves the decision to the player.
 *  - Call Any Bet calls at most the remaining stack, which the engine caps.
 *  - Preset raises are clamped to legal limits and cancel if raising is illegal.
 */
export function resolvePreAction(pre: PreAction, legal: LegalActions, handNumber: number): PreActionResolution {
  if (pre.handNumber !== handNumber) return { kind: 'cancel', reason: 'It was set for a previous hand' };
  switch (pre.kind) {
    case 'check_fold':
      return { kind: 'execute', action: legal.canCheck ? { type: 'check' } : { type: 'fold' }, keepArmed: false };
    case 'fold_any':
      if (legal.canCall) return { kind: 'execute', action: { type: 'fold' }, keepArmed: false };
      return { kind: 'wait' };
    case 'check':
      if (legal.canCheck) return { kind: 'execute', action: { type: 'check' }, keepArmed: false };
      return { kind: 'cancel', reason: 'There is a bet to call, so Check was cancelled' };
    case 'call_any':
      if (legal.canCall) return { kind: 'execute', action: { type: 'call' }, keepArmed: false };
      if (legal.canCheck) return { kind: 'execute', action: { type: 'check' }, keepArmed: false };
      return { kind: 'cancel', reason: 'Nothing to call' };
    case 'raise_x': {
      const to = multipleTo(legal, pre.multiple ?? 3);
      if (to === null) return { kind: 'cancel', reason: 'Raising is not legal here' };
      const action = aggressiveAction(legal, to);
      if (!action) return { kind: 'cancel', reason: 'Raising is not legal here' };
      return { kind: 'execute', action, keepArmed: false };
    }
  }
}

export const PRE_ACTION_LABELS: Record<PreActionKind, string> = {
  check_fold: 'Check/Fold',
  fold_any: 'Fold to Any Bet',
  check: 'Check',
  call_any: 'Call Any Bet',
  raise_x: 'Raise',
};

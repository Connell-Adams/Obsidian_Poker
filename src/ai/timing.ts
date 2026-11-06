import type { Rng } from '../engine/rng';
import type { Decision } from './decision';
import type { EmotionalState } from './emotions';
import type { BotProfile } from './profiles';
import type { PublicHandView } from './view';

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export interface ThinkingTime {
  ms: number;
  kind: 'snap' | 'normal' | 'tank';
}

/**
 * Human-like delay before acting, generally 1.5-6 seconds. Hand strength leaks a
 * little: strong hands snap-call more often and big decisions tank more often.
 * Noise means no timing pattern reliably reveals what a bot holds.
 */
export function thinkingTime(decision: Decision, view: PublicHandView, profile: BotProfile, mood: EmotionalState, rng: Rng): ThinkingTime {
  const patience = profile.attrs.patience / 100;
  const pot = view.pot;
  const me = view.players.find((p) => p.seat === view.seat)!;
  const type = decision.action.type;
  const added = type === 'bet' || type === 'raise' ? decision.action.to - me.streetBet : type === 'allin' ? me.stack : type === 'call' ? view.legal.callAmount : 0;
  const stakes = clamp((added + pot * 0.25) / Math.max(1, me.stack + me.streetBet), 0, 1);

  const preflopFold = view.street === 'preflop' && type === 'fold';
  let ms = 1500 + 2200 * decision.complexity + 1500 * stakes + 800 * patience;
  if (view.street === 'river') ms += 500;
  if (view.tournament) ms *= 1 + view.tournament.riskPremium;
  if (preflopFold) ms = 900 + 900 * decision.complexity + 500 * patience;
  ms *= 0.72 + rng.next() * 0.56;
  ms *= 1 - mood.tilt * 0.3;

  let kind: ThinkingTime['kind'] = 'normal';
  const strong = decision.strength > 0.72;
  const weak = decision.strength < 0.3;
  let snapChance = 0.06;
  if (type === 'call' && strong) snapChance = 0.22;
  if (type === 'check' && weak) snapChance = 0.25;
  if (preflopFold && decision.complexity < 0.3) snapChance = 0.3;
  if (type === 'fold' && decision.complexity < 0.2) snapChance = 0.2;
  let tankChance = 0.03 + 0.14 * stakes + 0.06 * decision.complexity;
  if (view.street === 'river') tankChance += 0.06;

  const roll = rng.next();
  if (roll < snapChance) {
    kind = 'snap';
    ms = 350 + rng.next() * 750;
  } else if (roll < snapChance + tankChance) {
    kind = 'tank';
    ms = 6000 + rng.next() * 6000;
  }
  return { ms: Math.round(clamp(ms, 350, 13000)), kind };
}

import type { BotAttributes, BotProfile } from './profiles';

/** A bot's mood. Everything is bounded and decays back toward neutral. */
export interface EmotionalState {
  /** 0..1 anger at recent results. */
  frustration: number;
  /** 0..1, 0.5 is neutral. */
  confidence: number;
  /** 0..1 how badly play is currently distorted. */
  tilt: number;
  /** -1..1 temporary shift in appetite for risk. */
  riskShift: number;
  /** Last results in big blinds, newest last. */
  recentNetBB: number[];
  /** -1..1 perceived run of good or bad results. */
  momentum: number;
  recentWins: number;
  recentLosses: number;
}

export const neutralEmotions = (): EmotionalState => ({
  frustration: 0,
  confidence: 0.5,
  tilt: 0,
  riskShift: 0,
  recentNetBB: [],
  momentum: 0,
  recentWins: 0,
  recentLosses: 0,
});

export interface HandOutcomeForBot {
  netBB: number;
  /** Net as a fraction of the stack at the start of the hand. */
  stackFraction: number;
  badBeat: boolean;
  wonShowdown: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Applies one finished hand. Runs for every hand, so tilt always recovers over time. */
export function updateEmotions(prev: EmotionalState, outcome: HandOutcomeForBot, attrs: BotAttributes): EmotionalState {
  const resistance = attrs.tiltResistance / 100;
  const next: EmotionalState = { ...prev, recentNetBB: [...prev.recentNetBB, outcome.netBB].slice(-10) };

  // Everything drifts back toward neutral every hand. Resilient players recover faster.
  const recovery = 0.06 + 0.16 * resistance;
  next.tilt = prev.tilt * (1 - recovery);
  next.frustration = prev.frustration * (1 - recovery);
  next.riskShift = prev.riskShift * (1 - recovery);
  next.confidence = 0.5 + (prev.confidence - 0.5) * (1 - recovery * 0.7);

  const lossFraction = outcome.stackFraction < 0 ? -outcome.stackFraction : 0;
  const winFraction = outcome.stackFraction > 0 ? outcome.stackFraction : 0;

  if (outcome.badBeat) {
    next.frustration += 0.5 * (1 - 0.6 * resistance);
    next.tilt += 0.55 * (1 - 0.75 * resistance);
  }
  if (lossFraction >= 0.25) {
    next.frustration += lossFraction * 0.5 * (1 - 0.5 * resistance);
    next.tilt += lossFraction * 0.55 * (1 - 0.7 * resistance);
    next.confidence -= lossFraction * 0.3;
  }
  if (winFraction >= 0.2) {
    next.confidence += Math.min(0.3, winFraction * 0.25);
    next.tilt *= 0.75;
    next.frustration *= 0.7;
  }

  const recent = next.recentNetBB;
  next.recentWins = recent.filter((n) => n > 0).length;
  next.recentLosses = recent.filter((n) => n < 0).length;
  const sum = recent.reduce((total, n) => total + n, 0);
  next.momentum = clamp(sum / 120, -1, 1);
  next.riskShift += next.momentum * 0.02 + (outcome.badBeat ? 0.15 : 0);

  next.frustration = clamp(next.frustration, 0, 1);
  next.tilt = clamp(next.tilt, 0, 1);
  next.confidence = clamp(next.confidence, 0, 1);
  next.riskShift = clamp(next.riskShift, -1, 1);
  return next;
}

/** The attribute set actually used for a decision, normalised to 0..1. */
export interface EffectiveStyle {
  aggression: number;
  bluff: number;
  risk: number;
  patience: number;
  adaptability: number;
  position: number;
  calling: number;
  deception: number;
  skill: number;
  tilt: number;
}

/**
 * Applies mood to the base attributes. Tilt pulls play in the archetype's own
 * direction: tight players get reckless, loose players can turn timid, stations
 * dig in, and aggressive players start bluffing more.
 */
export function effectiveStyle(profile: BotProfile, mood: EmotionalState): EffectiveStyle {
  const a = profile.attrs;
  const t = mood.tilt;
  const s: EffectiveStyle = {
    aggression: a.aggression / 100,
    bluff: a.bluff / 100,
    risk: a.risk / 100,
    patience: a.patience / 100,
    adaptability: a.adaptability / 100,
    position: a.position / 100,
    calling: a.calling / 100,
    deception: a.deception / 100,
    skill: profile.skill,
    tilt: t,
  };
  switch (profile.tiltStyle) {
    case 'reckless':
      s.aggression += 0.45 * t;
      s.bluff += 0.35 * t;
      s.patience -= 0.6 * t;
      s.risk += 0.4 * t;
      s.calling += 0.25 * t;
      break;
    case 'cautious':
      s.aggression -= 0.35 * t;
      s.patience += 0.3 * t;
      s.risk -= 0.4 * t;
      s.calling -= 0.2 * t;
      break;
    case 'sticky':
      s.calling += 0.5 * t;
      s.patience -= 0.3 * t;
      s.aggression -= 0.1 * t;
      break;
    case 'bluffy':
      s.bluff += 0.5 * t;
      s.aggression += 0.3 * t;
      s.patience -= 0.2 * t;
      break;
  }
  s.skill -= 0.3 * t;
  s.risk += mood.riskShift * 0.15 + (mood.confidence - 0.5) * 0.2;
  s.aggression += (mood.confidence - 0.5) * 0.15;
  for (const key of ['aggression', 'bluff', 'risk', 'patience', 'adaptability', 'position', 'calling', 'deception', 'skill'] as const) {
    s[key] = clamp(s[key], 0.01, 1);
  }
  return s;
}

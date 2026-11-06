import { emptyCounters, addCounters, type StatCounters, wilsonInterval } from '../stats/counters';

export type LeakSeverity = 'minor' | 'moderate' | 'major';
/**
 * `tendency`: outside the usual range, which is not proof of a mistake.
 * `supported`: the uncertainty interval is clear of the healthy range.
 */
export type LeakConfidence = 'tendency' | 'supported';

export interface LeakProgress {
  /** Frequency over each recorded window, oldest first. */
  series: number[];
  direction: 'improving' | 'worsening' | 'flat' | 'unknown';
  earlier: number | null;
  recent: number | null;
}

export interface Leak {
  id: string;
  title: string;
  evidence: string;
  sampleSize: number;
  sampleLabel: string;
  /** Rough size of the problem in BB per 100 hands. Always presented as an estimate. */
  estimatedImpactBB100: number;
  severity: LeakSeverity;
  confidence: LeakConfidence;
  correction: string;
  progress: LeakProgress;
  healthy: string;
  observed: number;
  low: number;
  high: number;
}

export interface LeakOptions {
  /** Counters for successive 25-hand windows, oldest first. */
  windows?: readonly StatCounters[];
}

interface FrequencyRule {
  id: string;
  title: string;
  num: (c: StatCounters) => number;
  den: (c: StatCounters) => number;
  sampleLabel: string;
  /** Healthy range for this frequency. */
  low: number;
  high: number;
  /** Fewest observations before saying anything. */
  minSample: number;
  /** How many times per 100 hands the spot comes up, and the value of each error, for impact. */
  impact: (excess: number, c: StatCounters) => number;
  evidence: (rate: string, c: StatCounters) => string;
  correctionHigh?: string;
  correctionLow?: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const perHundred = (den: number, hands: number) => (hands > 0 ? (den / hands) * 100 : 0);

/**
 * Each rule compares a measured frequency with a range typical of winning players.
 * Those ranges are guidelines, so a flagged leak is a tendency unless the sample
 * is big enough that the uncertainty interval sits clear of the range.
 */
const FREQUENCY_RULES: readonly FrequencyRule[] = [
  {
    id: 'ep_too_loose',
    title: 'Playing too many hands from early position',
    num: (c) => (c.byPosition.UTG?.vpip ?? 0) + (c.byPosition['UTG+1']?.vpip ?? 0) + (c.byPosition['UTG+2']?.vpip ?? 0) + (c.byPosition.MP?.vpip ?? 0),
    den: (c) => (c.byPosition.UTG?.decisions ?? 0) + (c.byPosition['UTG+1']?.decisions ?? 0) + (c.byPosition['UTG+2']?.decisions ?? 0) + (c.byPosition.MP?.decisions ?? 0),
    sampleLabel: 'early-position hands',
    low: 0,
    high: 0.24,
    minSample: 40,
    impact: (excess, c) => {
      const spots = (c.byPosition.UTG?.decisions ?? 0) + (c.byPosition['UTG+1']?.decisions ?? 0) + (c.byPosition['UTG+2']?.decisions ?? 0) + (c.byPosition.MP?.decisions ?? 0);
      return excess * perHundred(spots, c.hands) * 1.5;
    },
    evidence: (rate) => `You put chips in with ${rate} of hands from early positions. Winning players are usually at or below 24%.`,
    correctionHigh: 'Tighten up under the gun and in middle position. Most players behind you still have to act, so you need hands that play well against raises.',
  },
  {
    id: 'too_loose_overall',
    title: 'Playing too many hands overall',
    num: (c) => c.vpip,
    den: (c) => c.decisions,
    sampleLabel: 'hands with a preflop decision',
    low: 0,
    high: 0.34,
    minSample: 100,
    impact: (excess) => excess * 100 * 0.25,
    evidence: (rate) => `Your VPIP is ${rate}. Most consistent winners stay below 34% on tables of six or more.`,
    correctionHigh: 'Fold more of your weakest offsuit hands, starting with those you would need to fold to a raise anyway.',
  },
  {
    id: 'too_tight_overall',
    title: 'Playing too few hands',
    num: (c) => c.vpip,
    den: (c) => c.decisions,
    sampleLabel: 'hands with a preflop decision',
    low: 0.14,
    high: 1,
    minSample: 150,
    impact: (excess) => excess * 100 * 0.2,
    evidence: (rate) => `Your VPIP is only ${rate}. Opponents will be able to fold whenever you show interest.`,
    correctionLow: 'Widen your range in late position, where steals and position make extra hands profitable.',
  },
  {
    id: 'passive_preflop',
    title: 'Too passive before the flop',
    num: (c) => c.pfr,
    den: (c) => c.vpip,
    sampleLabel: 'voluntary preflop hands',
    low: 0.5,
    high: 1,
    minSample: 60,
    impact: (excess, c) => excess * perHundred(c.vpip, c.hands) * 0.6,
    evidence: (rate) => `You raised on ${rate} of the hands you chose to play. A low share means many limps and cold calls, which lose the initiative.`,
    correctionLow: 'Raise the hands you intend to play when you are first in, instead of limping.',
  },
  {
    id: 'folding_to_3bets',
    title: 'Folding too often to 3-bets',
    num: (c) => c.foldTo3Bet,
    den: (c) => c.faced3Bet,
    sampleLabel: 'times facing a 3-bet',
    low: 0,
    high: 0.72,
    minSample: 20,
    impact: (excess, c) => excess * perHundred(c.faced3Bet, c.hands) * 3,
    evidence: (rate) => `You folded to ${rate} of 3-bets after raising. Above about 72%, opponents profit by re-raising you with any two cards.`,
    correctionHigh: 'Defend more of your opening range against 3-bets, especially in position, either by calling or by 4-betting.',
  },
  {
    id: 'cbet_too_often',
    title: 'Overusing continuation bets',
    num: (c) => c.cbet,
    den: (c) => c.cbetOpp,
    sampleLabel: 'c-bet opportunities',
    low: 0,
    high: 0.82,
    minSample: 30,
    impact: (excess, c) => excess * perHundred(c.cbetOpp, c.hands) * 1.5,
    evidence: (rate) => `You continuation bet ${rate} of the time. Betting nearly every flop makes your bets easy to attack and burns chips on boards that miss you.`,
    correctionHigh: 'Check more often on boards that favour the caller, such as low connected boards, and with hands that have showdown value.',
  },
  {
    id: 'cbet_too_rarely',
    title: 'Missing continuation bets',
    num: (c) => c.cbet,
    den: (c) => c.cbetOpp,
    sampleLabel: 'c-bet opportunities',
    low: 0.35,
    high: 1,
    minSample: 30,
    impact: (excess, c) => excess * perHundred(c.cbetOpp, c.hands) * 1,
    evidence: (rate) => `You continuation bet only ${rate} of the time after raising preflop, giving up many pots that would have folded.`,
    correctionLow: 'Bet more on dry, high-card boards where your raising range hits hard and your opponent mostly misses.',
  },
  {
    id: 'folding_to_cbets',
    title: 'Folding too often to continuation bets',
    num: (c) => c.foldToCbet,
    den: (c) => c.facedCbet,
    sampleLabel: 'c-bets faced',
    low: 0,
    high: 0.68,
    minSample: 30,
    impact: (excess, c) => excess * perHundred(c.facedCbet, c.hands) * 1.5,
    evidence: (rate) => `You folded to ${rate} of continuation bets. Above about 68%, opponents can bet any two cards at a profit.`,
    correctionHigh: 'Continue with more pairs and draws, and raise some of your strong hands and semi-bluffs.',
  },
  {
    id: 'calling_river',
    title: 'Calling too many river bets',
    num: (c) => c.callBetRiver,
    den: (c) => c.facedBetRiver,
    sampleLabel: 'river bets faced',
    low: 0,
    high: 0.55,
    minSample: 25,
    impact: (excess, c) => excess * perHundred(c.facedBetRiver, c.hands) * 4,
    evidence: (rate, c) => {
      const shown = c.riverCallsToShowdown;
      const won = shown ? ` You won ${pct(c.wonRiverCalls / shown)} of those showdowns.` : '';
      return `You called ${rate} of river bets.${won} River bets lean strongly toward value at most stakes.`;
    },
    correctionHigh: 'Before calling on the river, list the bluffs your opponent can really have. Fold your weakest bluff-catchers against players who rarely bluff.',
  },
  {
    id: 'calling_river_raises',
    title: 'Calling river raises too often',
    num: (c) => c.calledRiverRaise,
    den: (c) => c.facedRiverRaise,
    sampleLabel: 'river raises faced',
    low: 0,
    high: 0.4,
    minSample: 8,
    impact: (excess, c) => excess * perHundred(c.facedRiverRaise, c.hands) * 8,
    evidence: (rate) => `You called ${rate} of river raises. A raise on the river is rarely a bluff.`,
    correctionHigh: 'Against a river raise, continue only with hands that beat the value bets your opponent would actually make.',
  },
  {
    id: 'bb_underdefend',
    title: 'Under-defending the big blind',
    num: (c) => c.bbDefend,
    den: (c) => c.bbFacedSteal,
    sampleLabel: 'late-position raises faced in the big blind',
    low: 0.3,
    high: 1,
    minSample: 25,
    impact: (excess, c) => excess * perHundred(c.bbFacedSteal, c.hands) * 2.5,
    evidence: (rate) => `You defended your big blind ${rate} of the time against late-position raises. You already have chips in, so the price is good.`,
    correctionLow: 'Defend wider against late-position opens, particularly suited hands and connected cards.',
  },
  {
    id: 'too_few_steals',
    title: 'Not stealing enough from late position',
    num: (c) => c.steal,
    den: (c) => c.stealOpp,
    sampleLabel: 'late-position first-in spots',
    low: 0.25,
    high: 1,
    minSample: 30,
    impact: (excess, c) => excess * perHundred(c.stealOpp, c.hands) * 1.2,
    evidence: (rate) => `You raised ${rate} of the time when folded to in the cutoff, button or small blind.`,
    correctionLow: 'Open wider on the button and in the cutoff, where only a couple of players can wake up with a hand.',
  },
  {
    id: 'bluffing_excessively',
    title: 'Excessive river bluffing',
    num: (c) => c.riverBetsLostAtShowdown,
    den: (c) => c.riverBets,
    sampleLabel: 'river bets and raises',
    low: 0,
    high: 0.35,
    minSample: 20,
    impact: (excess, c) => excess * perHundred(c.riverBets, c.hands) * 3,
    evidence: (rate) => `${rate} of your river bets were called and lost at showdown. That suggests your bluffs are getting looked up too often.`,
    correctionHigh: 'Choose river bluffs that block the hands your opponent would call with, and bluff less against players who call a lot.',
  },
  {
    id: 'poor_sizing_small',
    title: 'Bet sizes too small',
    num: (c) => c.tinyBets,
    den: (c) => c.betCount,
    sampleLabel: 'postflop bets and raises',
    low: 0,
    high: 0.15,
    minSample: 40,
    impact: (excess, c) => excess * perHundred(c.betCount, c.hands) * 1,
    evidence: (rate) => `${rate} of your postflop bets were under a quarter of the pot. These give opponents a great price and rarely fold anything out.`,
    correctionHigh: 'Use around half to three quarters of the pot as a default, adjusting for the board and your plan.',
  },
];

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function progressFor(rule: FrequencyRule, windows: readonly StatCounters[]): LeakProgress {
  const series = windows.filter((w) => rule.den(w) > 0).map((w) => rule.num(w) / rule.den(w));
  if (windows.length < 4) return { series, direction: 'unknown', earlier: null, recent: null };
  const half = Math.floor(windows.length / 2);
  const sum = (slice: readonly StatCounters[]) => {
    let num = 0;
    let den = 0;
    for (const w of slice) {
      num += rule.num(w);
      den += rule.den(w);
    }
    return den >= 6 ? num / den : null;
  };
  const earlier = sum(windows.slice(0, half));
  const recent = sum(windows.slice(half));
  if (earlier === null || recent === null) return { series, direction: 'unknown', earlier, recent };
  const target = (rule.low + rule.high) / 2;
  const before = Math.abs(earlier - target);
  const after = Math.abs(recent - target);
  const direction = after < before - 0.04 ? 'improving' : after > before + 0.04 ? 'worsening' : 'flat';
  return { series, direction, earlier, recent };
}

/** Finds leaks from recorded statistics. Nothing is reported without enough real data. */
export function findLeaks(counters: StatCounters, options: LeakOptions = {}): Leak[] {
  const windows = options.windows ?? [];
  const leaks: Leak[] = [];
  for (const rule of FREQUENCY_RULES) {
    const den = rule.den(counters);
    if (den < rule.minSample) continue;
    const num = rule.num(counters);
    const observed = num / den;
    const tooHigh = observed > rule.high;
    const tooLow = observed < rule.low;
    if (!tooHigh && !tooLow) continue;
    const interval = wilsonInterval(num, den);
    const excess = tooHigh ? observed - rule.high : rule.low - observed;
    const confidence: LeakConfidence = tooHigh ? (interval.low > rule.high ? 'supported' : 'tendency') : interval.high < rule.low ? 'supported' : 'tendency';
    const impact = clamp(rule.impact(excess, counters), 0, 40);
    const severity: LeakSeverity = impact >= 6 ? 'major' : impact >= 2 ? 'moderate' : 'minor';
    const correction = (tooHigh ? rule.correctionHigh : rule.correctionLow) ?? 'Review these spots in your hand history.';
    leaks.push({
      id: rule.id,
      title: rule.title,
      evidence: rule.evidence(pct(observed), counters),
      sampleSize: den,
      sampleLabel: rule.sampleLabel,
      estimatedImpactBB100: Number(impact.toFixed(1)),
      severity,
      confidence,
      correction,
      progress: progressFor(rule, windows),
      healthy: `${pct(rule.low)}-${pct(rule.high)}`,
      observed,
      low: interval.low,
      high: interval.high,
    });
  }

  // Positional leak: losing heavily from a seat where most players do fine.
  for (const [position, c] of Object.entries(counters.byPosition)) {
    if (position === 'SB' || position === 'BB' || c.hands < 80) continue;
    const bb100 = (c.bbNet / c.hands) * 100;
    if (bb100 > -15) continue;
    const severity: LeakSeverity = bb100 < -40 ? 'major' : 'moderate';
    leaks.push({
      id: `position_${position}`,
      title: `Losing from ${position}`,
      evidence: `You are losing ${Math.abs(bb100).toFixed(0)} BB/100 from ${position} over ${c.hands} hands. Seats outside the blinds should not lose this much.`,
      sampleSize: c.hands,
      sampleLabel: `hands from ${position}`,
      estimatedImpactBB100: Number(clamp((Math.abs(bb100) * c.hands) / Math.max(1, counters.hands), 0, 40).toFixed(1)),
      severity,
      confidence: 'tendency',
      correction: `Filter your hand history by ${position} and look at your biggest losses. Results swing a lot, so treat this as somewhere to look, not a proven error.`,
      progress: { series: [], direction: 'unknown', earlier: null, recent: null },
      healthy: 'above -15 BB/100',
      observed: bb100,
      low: bb100,
      high: bb100,
    });
  }

  // Poor all-in decisions need showdown equity: chips only tell you about luck.
  if (counters.allInShowdowns >= 12) {
    const avg = counters.allInEquitySum / counters.allInShowdowns;
    if (avg < 0.42) {
      leaks.push({
        id: 'allin_equity',
        title: 'Getting all-in behind too often',
        evidence: `Your average equity when the chips went in was ${pct(avg)} over ${counters.allInShowdowns} all-in showdowns.`,
        sampleSize: counters.allInShowdowns,
        sampleLabel: 'all-in showdowns',
        estimatedImpactBB100: Number(clamp(((0.5 - avg) * counters.allInShowdowns * 100 * 100) / Math.max(1, counters.hands), 0, 40).toFixed(1)),
        severity: avg < 0.36 ? 'major' : 'moderate',
        confidence: counters.allInShowdowns >= 40 ? 'supported' : 'tendency',
        correction: 'Tighten your stacking-off range. Ask what worse hands actually put all their chips in with you.',
        progress: { series: [], direction: 'unknown', earlier: null, recent: null },
        healthy: 'near or above 50%',
        observed: avg,
        low: avg,
        high: avg,
      });
    }
  }

  const severityRank = { major: 0, moderate: 1, minor: 2 };
  return leaks.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.estimatedImpactBB100 - a.estimatedImpactBB100);
}

export function sumWindows(windows: readonly StatCounters[]): StatCounters {
  const total = emptyCounters();
  for (const w of windows) addCounters(total, w);
  return total;
}

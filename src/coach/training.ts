import { publishStats, type StatCounters } from '../stats/counters';
import { findLeaks, type Leak, sumWindows } from './leaks';

export type PlayingLevel = 'Gathering data' | 'Learning the fundamentals' | 'Developing' | 'Solid' | 'Strong' | 'Elite';
export type DifficultyAdvice = 'keep' | 'raise' | 'lower';

export interface TrainingRecommendation {
  id: string;
  handsAtCreation: number;
  ts: number;
  level: PlayingLevel;
  strongest: string[];
  weakest: string[];
  focus: string;
  message: string;
  difficulty: DifficultyAdvice;
  difficultyReason: string;
  /** Share of recent reviewed decisions judged good or fine. */
  decisionQuality: number | null;
}

export interface TrainingInput {
  career: StatCounters;
  windows: readonly StatCounters[];
  currentDifficulty: number;
  /** Decision counts from coach reviews in the recent past. */
  reviewed: { good: number; fine: number; close: number; questionable: number; mistake: number };
  now: number;
}

/** Standard error of a win rate in BB/100, assuming about 90 BB/100 of per-hand noise. */
const winRateError = (hands: number) => (hands > 0 ? 90 / Math.sqrt(hands / 100) : Infinity);

function strengthsOf(c: StatCounters): string[] {
  const s = publishStats(c);
  const out: string[] = [];
  const inRange = (r: { value: number | null; n: number }, lo: number, hi: number, min: number) => r.value !== null && r.n >= min && r.value >= lo && r.value <= hi;
  if (inRange(s.vpip, 0.18, 0.3, 80)) out.push('Starting hand selection');
  if (c.vpip > 30 && c.pfr / c.vpip >= 0.65) out.push('Preflop aggression');
  if (inRange(s.cbet, 0.5, 0.78, 25)) out.push('Continuation betting frequency');
  if (inRange(s.wsd, 0.52, 0.75, 25)) out.push('Showdown selection');
  if (inRange(s.foldToCbet, 0.3, 0.6, 25)) out.push('Defending against continuation bets');
  if (inRange(s.steal, 0.32, 0.6, 25)) out.push('Late-position stealing');
  if (inRange(s.bbDefend, 0.32, 0.65, 20)) out.push('Big blind defence');
  return out.slice(0, 3);
}

function levelFor(hands: number, bb100: number | null, quality: number | null, leaks: readonly Leak[]): PlayingLevel {
  if (hands < 75) return 'Gathering data';
  const majors = leaks.filter((l) => l.severity === 'major').length;
  const q = quality ?? 0.6;
  const wr = bb100 ?? 0;
  const err = winRateError(hands);
  const confidentlyWinning = wr - err > 0;
  if (q >= 0.85 && majors === 0 && confidentlyWinning && hands >= 2000) return 'Elite';
  if (q >= 0.78 && majors === 0 && (confidentlyWinning || wr > 5)) return 'Strong';
  if (q >= 0.68 && majors <= 1) return 'Solid';
  if (q >= 0.55) return 'Developing';
  return 'Learning the fundamentals';
}

/**
 * Evaluates performance trends. Difficulty advice deliberately ignores short
 * upswings: raising needs a win rate whose uncertainty band sits above zero.
 */
export function buildRecommendation(input: TrainingInput): TrainingRecommendation {
  const { career, windows, currentDifficulty, reviewed, now } = input;
  const recent = sumWindows(windows.slice(-8));
  const sample = recent.hands >= 50 ? recent : career;
  const leaks = findLeaks(career, { windows });
  const stats = publishStats(career);
  const totalReviewed = reviewed.good + reviewed.fine + reviewed.close + reviewed.questionable + reviewed.mistake;
  const quality = totalReviewed >= 20 ? (reviewed.good + reviewed.fine + reviewed.close * 0.5) / totalReviewed : null;
  const level = levelFor(career.hands, stats.bb100.value, quality, leaks);
  const strongest = strengthsOf(sample);
  const weakest = leaks.slice(0, 3).map((l) => l.title);
  const hands = career.hands;

  let focus: string;
  let message: string;
  const top = leaks[0];
  if (hands < 75 || (!top && hands < 200)) {
    focus = 'Build a sample';
    message = `You have played ${hands} hands. Keep playing: patterns start to mean something after about 75 hands, and the leak finder gets much sharper after a few hundred.`;
  } else if (top) {
    focus = top.title;
    const improving = leaks.find((l) => l.progress.direction === 'improving');
    const lead = improving && improving.id !== top.id ? `${improving.title} is improving. ` : strongest.length ? `${strongest[0]} is holding up well. ` : '';
    message = `${lead}Your biggest remaining weakness looks like ${top.title.toLowerCase()}. ${top.correction}`;
  } else {
    focus = 'Keep your edge';
    message = `No clear leak stands out across ${hands} hands${strongest.length ? `, and ${strongest[0].toLowerCase()} looks good` : ''}. Use the hand history to review your largest pots, or try a higher difficulty.`;
  }

  const wr = stats.bb100.value ?? 0;
  const err = winRateError(hands);
  let difficulty: DifficultyAdvice = 'keep';
  let difficultyReason: string;
  if (hands < 500) {
    difficultyReason = `${hands} hands is too few to judge: results swing by about ±${Math.round(err)} BB/100 at this sample.`;
  } else if (wr - err > 5 && (quality === null || quality >= 0.7) && currentDifficulty < 10) {
    difficulty = 'raise';
    difficultyReason = `You are winning ${wr.toFixed(1)} BB/100 over ${hands.toLocaleString()} hands, and that is clear of the ±${Math.round(err)} uncertainty.`;
  } else if (wr + err < -10 && currentDifficulty > 1) {
    difficulty = 'lower';
    difficultyReason = `You are losing ${Math.abs(wr).toFixed(1)} BB/100 over ${hands.toLocaleString()} hands, beyond the ±${Math.round(err)} uncertainty. A softer table is a better place to work on this.`;
  } else {
    difficultyReason = `Your win rate of ${wr.toFixed(1)} BB/100 is within the ±${Math.round(err)} uncertainty at ${hands.toLocaleString()} hands, so there is no reason to change yet.`;
  }

  return {
    id: `train-${hands}-${now}`,
    handsAtCreation: hands,
    ts: now,
    level,
    strongest,
    weakest,
    focus,
    message,
    difficulty,
    difficultyReason,
    decisionQuality: quality,
  };
}

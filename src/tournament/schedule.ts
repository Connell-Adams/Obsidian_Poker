export type PayoutStructure = 'winner_takes_all' | 'top_heavy' | 'standard' | 'flat';

export const PAYOUT_LABELS: Record<PayoutStructure, string> = {
  winner_takes_all: 'Winner takes all',
  top_heavy: 'Top heavy',
  standard: 'Standard',
  flat: 'Flat',
};

export interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
}

export interface ScheduleConfig {
  startingSmallBlind: number;
  startingBigBlind: number;
  /** Percentage growth of blinds per level, e.g. 50. */
  blindIncreasePct: number;
  /** First level with antes, 0 for none. */
  anteFromLevel: number;
}

function niceChips(value: number): number {
  let step = 1;
  if (value >= 20) step = 5;
  if (value >= 100) step = 10;
  if (value >= 300) step = 25;
  if (value >= 1000) step = 50;
  if (value >= 4000) step = 100;
  if (value >= 20000) step = 500;
  if (value >= 100000) step = 1000;
  return Math.round(value / step) * step;
}

/** The whole schedule is computed from the configuration. Blinds strictly increase. */
export function blindLevelFor(config: ScheduleConfig, level: number): BlindLevel {
  if (!Number.isInteger(level) || level < 1) throw new Error('Levels start at 1');
  const growth = 1 + Math.max(1, config.blindIncreasePct) / 100;
  const ratio = config.startingSmallBlind / config.startingBigBlind;
  let bb = config.startingBigBlind;
  for (let l = 2; l <= level; l++) bb = Math.max(bb + 1, niceChips(bb * growth));
  const sb = level === 1 ? config.startingSmallBlind : Math.max(1, Math.round(bb * ratio));
  const ante = config.anteFromLevel > 0 && level >= config.anteFromLevel ? Math.max(1, niceChips(bb / 8)) : 0;
  return { level, smallBlind: Math.min(sb, bb), bigBlind: bb, ante };
}

/** How many places are paid for a field of this size. */
export function paidPlaces(entries: number, structure: PayoutStructure): number {
  if (entries <= 1 || structure === 'winner_takes_all') return 1;
  const share = structure === 'top_heavy' ? 0.1 : structure === 'flat' ? 0.25 : 0.15;
  return Math.max(entries <= 4 ? 1 : 2, Math.min(entries - 1, Math.max(1, Math.round(entries * share))));
}

/**
 * Prize for each paid place, first place first. Integer chips only and the sum is
 * always exactly the prize pool. A lower place never pays more than a higher one.
 */
export function computePayouts(prizePool: number, entries: number, structure: PayoutStructure): number[] {
  if (!Number.isInteger(prizePool) || prizePool < 0) throw new Error('Invalid prize pool');
  const places = paidPlaces(entries, structure);
  const decay = structure === 'top_heavy' ? 0.55 : structure === 'flat' ? 0.86 : 0.7;
  const weights: number[] = [];
  for (let i = 0; i < places; i++) weights.push(Math.pow(decay, i));
  const total = weights.reduce((a, b) => a + b, 0);
  const prizes = weights.map((w) => Math.floor((prizePool * w) / total));
  let remainder = prizePool - prizes.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % places) {
    prizes[i]++;
    remainder--;
  }
  return prizes;
}

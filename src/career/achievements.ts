import type { CareerProfile } from './career';

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  category: 'milestone' | 'tournament' | 'skill' | 'record';
  xp: number;
  check(p: CareerProfile): boolean;
}

/** Each is computed from recorded play, so none can be earned without having happened. */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'first_hand', name: 'Shuffle Up', description: 'Play your first hand.', category: 'milestone', xp: 10, check: (p) => p.handsPlayed >= 1 },
  { id: 'hands_100', name: 'Finding a Seat', description: 'Play 100 hands.', category: 'milestone', xp: 50, check: (p) => p.handsPlayed >= 100 },
  { id: 'hands_1000', name: 'Regular', description: 'Play 1,000 hands.', category: 'milestone', xp: 150, check: (p) => p.handsPlayed >= 1000 },
  { id: 'hands_10000', name: 'Grinder', description: 'Play 10,000 hands.', category: 'milestone', xp: 500, check: (p) => p.handsPlayed >= 10000 },
  { id: 'hands_50000', name: 'Iron Man', description: 'Play 50,000 hands.', category: 'milestone', xp: 1500, check: (p) => p.handsPlayed >= 50000 },
  { id: 'profit_10k', name: 'In the Black', description: 'Reach 10,000 chips of lifetime profit.', category: 'milestone', xp: 150, check: (p) => p.sessionPL >= 10000 },
  { id: 'profit_100k', name: 'High Roller', description: 'Reach 100,000 chips of lifetime profit.', category: 'milestone', xp: 600, check: (p) => p.sessionPL >= 100000 },
  { id: 'bankroll_1m', name: 'Seven Figures', description: 'Win 1,000,000 chips of lifetime profit.', category: 'milestone', xp: 1500, check: (p) => p.sessionPL >= 1000000 },
  { id: 'first_tournament', name: 'Shuffle and Deal', description: 'Finish your first tournament.', category: 'tournament', xp: 25, check: (p) => p.tournamentsPlayed >= 1 },
  { id: 'first_cash', name: 'In the Money', description: 'Cash in a tournament.', category: 'tournament', xp: 75, check: (p) => p.tournamentCashes >= 1 },
  { id: 'first_win', name: 'Champion', description: 'Win a tournament.', category: 'tournament', xp: 250, check: (p) => p.tournamentWins >= 1 },
  { id: 'wins_5', name: 'Serial Winner', description: 'Win 5 tournaments.', category: 'tournament', xp: 600, check: (p) => p.tournamentWins >= 5 },
  { id: 'wins_25', name: 'Hall of Fame', description: 'Win 25 tournaments.', category: 'tournament', xp: 2000, check: (p) => p.tournamentWins >= 25 },
  { id: 'cashes_10', name: 'Consistent', description: 'Cash in 10 tournaments.', category: 'tournament', xp: 300, check: (p) => p.tournamentCashes >= 10 },
  { id: 'pot_100bb', name: 'Big Pot Poker', description: 'Win a pot of at least 5,000 chips.', category: 'record', xp: 60, check: (p) => p.biggestPotWon >= 5000 },
  { id: 'pot_50k', name: 'Monster Pot', description: 'Win a pot of at least 50,000 chips.', category: 'record', xp: 300, check: (p) => p.biggestPotWon >= 50000 },
  { id: 'streak_5', name: 'Heater', description: 'Win 5 hands in a row.', category: 'record', xp: 60, check: (p) => p.longestWinStreak >= 5 },
  { id: 'streak_10', name: 'On Fire', description: 'Win 10 hands in a row.', category: 'record', xp: 250, check: (p) => p.longestWinStreak >= 10 },
  { id: 'session_10k', name: 'Great Session', description: 'Win 10,000 chips in one cash session.', category: 'record', xp: 150, check: (p) => p.bestCashSession >= 10000 },
  {
    id: 'winrate_500',
    name: 'Long-Run Winner',
    description: 'Hold a positive win rate over at least 500 hands.',
    category: 'skill',
    xp: 300,
    check: (p) => p.counters.hands >= 500 && p.counters.bbNet > 0,
  },
  {
    id: 'winrate_5000',
    name: 'Proven Winner',
    description: 'Hold at least 5 BB/100 over at least 5,000 hands.',
    category: 'skill',
    xp: 1000,
    check: (p) => p.counters.hands >= 5000 && (p.counters.bbNet / p.counters.hands) * 100 >= 5,
  },
  {
    id: 'disciplined',
    name: 'Disciplined',
    description: 'Keep VPIP between 18% and 30% over 500 hands.',
    category: 'skill',
    xp: 150,
    check: (p) => {
      const c = p.counters;
      if (c.decisions < 500) return false;
      const vpip = c.vpip / c.decisions;
      return vpip >= 0.18 && vpip <= 0.3;
    },
  },
  {
    id: 'showdown_shark',
    name: 'Showdown Shark',
    description: 'Win at least 55% of showdowns over 100 showdowns.',
    category: 'skill',
    xp: 200,
    check: (p) => p.counters.wtsd >= 100 && p.counters.wsd / p.counters.wtsd >= 0.55,
  },
];

export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, AchievementDef> = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Level curve: each level takes a little longer than the last. */
export function levelFromXp(xp: number): { level: number; xpIntoLevel: number; xpForNext: number } {
  let level = 1;
  let remaining = Math.max(0, xp);
  let needed = 100;
  while (remaining >= needed) {
    remaining -= needed;
    level++;
    needed = Math.round(100 * Math.pow(level, 1.35));
  }
  return { level, xpIntoLevel: remaining, xpForNext: needed };
}

const TITLES: ReadonlyArray<[number, string]> = [
  [1, 'Newcomer'],
  [3, 'Home Game Hero'],
  [6, 'Rounder'],
  [10, 'Card Room Regular'],
  [15, 'Mid-Stakes Grinder'],
  [20, 'Tournament Pro'],
  [30, 'High Stakes Regular'],
  [40, 'Road Warrior'],
  [50, 'Legend of the Felt'],
];

export function levelTitle(level: number): string {
  let title = TITLES[0][1];
  for (const [min, name] of TITLES) if (level >= min) title = name;
  return title;
}

import { NAMED_PROS } from '../ai/profiles';
import { SeededRng } from '../engine/rng';

/**
 * A local, simulated leaderboard: the named pros are fictional bots. Their numbers
 * change from the tournaments they actually play on this device, plus a small seeded
 * drift for play "elsewhere". Nothing here is shared or compared with real people.
 * A future online board would replace this module with a server-authoritative API.
 */
export interface ProRecord {
  name: string;
  avatar: number;
  bankroll: number;
  profit: number;
  tournamentWins: number;
  tournamentsPlayed: number;
  achievements: number;
}

export interface LeaderboardRow {
  name: string;
  avatar: number;
  isHuman: boolean;
  bankroll: number;
  profit: number;
  tournamentWins: number;
  achievements: number;
}

export function initialPros(): ProRecord[] {
  return NAMED_PROS.map((pro, i) => {
    const rng = new SeededRng(`pro-${pro.name}`);
    const profit = 15000 + rng.int(120000) - i * 2000;
    const tournamentsPlayed = 40 + rng.int(160);
    return {
      name: pro.name,
      avatar: pro.avatar,
      bankroll: 25000 + profit,
      profit,
      tournamentWins: 1 + rng.int(9),
      tournamentsPlayed,
      achievements: 4 + rng.int(12),
    };
  });
}

export function isValidPros(value: unknown): value is ProRecord[] {
  return Array.isArray(value) && value.every((p) => typeof p?.name === 'string' && Number.isFinite(p?.bankroll) && Number.isFinite(p?.profit) && Number.isFinite(p?.tournamentWins));
}

/** Applies the result of an event the named pros actually played in. */
export function applyTournamentResult(pros: ProRecord[], results: ReadonlyArray<{ name: string; prize: number; cost: number; won: boolean }>): ProRecord[] {
  const byName = new Map(results.map((r) => [r.name, r]));
  return pros.map((p) => {
    const r = byName.get(p.name);
    if (!r) return p;
    const delta = r.prize - r.cost;
    return {
      ...p,
      bankroll: Math.max(0, p.bankroll + delta),
      profit: p.profit + delta,
      tournamentsPlayed: p.tournamentsPlayed + 1,
      tournamentWins: p.tournamentWins + (r.won ? 1 : 0),
      achievements: p.achievements + (r.won && p.tournamentWins % 3 === 2 ? 1 : 0),
    };
  });
}

/** A little movement between visits, seeded so that it is reproducible. */
export function applyDrift(pros: ProRecord[], seed: string | number): ProRecord[] {
  const rng = new SeededRng(`drift-${seed}`);
  return pros.map((p) => {
    const delta = Math.round((rng.next() - 0.42) * 2400);
    return { ...p, bankroll: Math.max(0, p.bankroll + delta), profit: p.profit + delta };
  });
}

export function buildLeaderboard(pros: readonly ProRecord[], human: Omit<LeaderboardRow, 'isHuman'>): LeaderboardRow[] {
  const rows: LeaderboardRow[] = [
    { ...human, isHuman: true },
    ...pros.map((p) => ({
      name: p.name,
      avatar: p.avatar,
      isHuman: false,
      bankroll: p.bankroll,
      profit: p.profit,
      tournamentWins: p.tournamentWins,
      achievements: p.achievements,
    })),
  ];
  return rows.sort((a, b) => b.bankroll - a.bankroll);
}

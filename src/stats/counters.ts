import type { HandRecord, RecordedPlayer } from '../history/record';

/**
 * Raw counters. Every published statistic is a ratio of two of these, so each
 * has an explicit denominator and nothing is reported from a zero sample.
 *
 * Definitions:
 *  VPIP            voluntarily put chips in preflop / hands with a preflop decision
 *  PFR             raised preflop / hands with a preflop decision
 *  3-Bet           re-raised the first raise / times acting facing exactly one raise
 *  Fold to 3-Bet   folded / times the player made the first raise and then faced a re-raise
 *  4-Bet           re-raised / same denominator as Fold to 3-Bet
 *  C-Bet           bet the flop / times preflop aggressor acted with no flop bet in front
 *  Fold to C-Bet   folded / times facing a flop bet from the preflop aggressor
 *  WTSD            reached showdown / hands that saw the flop
 *  W$SD            won chips at showdown / hands reaching showdown
 *  AF              (postflop bets + raises) / postflop calls
 *  AFq             (postflop bets + raises) / (bets + raises + calls + folds) postflop
 *  BB/100          big blinds won per 100 hands dealt
 */
export interface PositionCounters {
  hands: number;
  decisions: number;
  vpip: number;
  pfr: number;
  net: number;
  bbNet: number;
}

export interface StatCounters {
  hands: number;
  decisions: number;
  vpip: number;
  pfr: number;
  threeBetOpp: number;
  threeBet: number;
  faced3Bet: number;
  foldTo3Bet: number;
  fourBet: number;
  cbetOpp: number;
  cbet: number;
  facedCbet: number;
  foldToCbet: number;
  sawFlop: number;
  wtsd: number;
  wsd: number;
  postBets: number;
  postRaises: number;
  postCalls: number;
  postFolds: number;
  postChecks: number;
  facedBetFlop: number;
  foldBetFlop: number;
  facedBetTurn: number;
  foldBetTurn: number;
  facedBetRiver: number;
  foldBetRiver: number;
  callBetRiver: number;
  raiseBetRiver: number;
  facedRiverRaise: number;
  calledRiverRaise: number;
  wonRiverCalls: number;
  riverCallsToShowdown: number;
  bbFacedSteal: number;
  bbDefend: number;
  stealOpp: number;
  steal: number;
  blindFacedSteal: number;
  blindFoldSteal: number;
  betCount: number;
  betPotRatioSum: number;
  tinyBets: number;
  hugeBets: number;
  riverBets: number;
  riverBetsLostAtShowdown: number;
  handsWon: number;
  allInShowdowns: number;
  allInEquitySum: number;
  allInEvDiff: number;
  net: number;
  bbNet: number;
  biggestPotWon: number;
  biggestPotLost: number;
  byPosition: Record<string, PositionCounters>;
}

export const emptyCounters = (): StatCounters => ({
  hands: 0,
  decisions: 0,
  vpip: 0,
  pfr: 0,
  threeBetOpp: 0,
  threeBet: 0,
  faced3Bet: 0,
  foldTo3Bet: 0,
  fourBet: 0,
  cbetOpp: 0,
  cbet: 0,
  facedCbet: 0,
  foldToCbet: 0,
  sawFlop: 0,
  wtsd: 0,
  wsd: 0,
  postBets: 0,
  postRaises: 0,
  postCalls: 0,
  postFolds: 0,
  postChecks: 0,
  facedBetFlop: 0,
  foldBetFlop: 0,
  facedBetTurn: 0,
  foldBetTurn: 0,
  facedBetRiver: 0,
  foldBetRiver: 0,
  callBetRiver: 0,
  raiseBetRiver: 0,
  facedRiverRaise: 0,
  calledRiverRaise: 0,
  wonRiverCalls: 0,
  riverCallsToShowdown: 0,
  bbFacedSteal: 0,
  bbDefend: 0,
  stealOpp: 0,
  steal: 0,
  blindFacedSteal: 0,
  blindFoldSteal: 0,
  betCount: 0,
  betPotRatioSum: 0,
  tinyBets: 0,
  hugeBets: 0,
  riverBets: 0,
  riverBetsLostAtShowdown: 0,
  handsWon: 0,
  allInShowdowns: 0,
  allInEquitySum: 0,
  allInEvDiff: 0,
  net: 0,
  bbNet: 0,
  biggestPotWon: 0,
  biggestPotLost: 0,
  byPosition: {},
});

/** Adds `b` into `a`. Biggest-pot fields take the maximum, everything else sums. */
export function addCounters(a: StatCounters, b: StatCounters): StatCounters {
  for (const key of Object.keys(b) as Array<keyof StatCounters>) {
    if (key === 'byPosition') continue;
    if (key === 'biggestPotWon' || key === 'biggestPotLost') a[key] = Math.max(a[key], b[key]);
    else (a[key] as number) += b[key] as number;
  }
  for (const [pos, c] of Object.entries(b.byPosition)) {
    const t = (a.byPosition[pos] ??= { hands: 0, decisions: 0, vpip: 0, pfr: 0, net: 0, bbNet: 0 });
    t.hands += c.hands;
    t.decisions += c.decisions;
    t.vpip += c.vpip;
    t.pfr += c.pfr;
    t.net += c.net;
    t.bbNet += c.bbNet;
  }
  return a;
}

export function isValidCounters(value: unknown): value is StatCounters {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const template = emptyCounters() as unknown as Record<string, unknown>;
  for (const key of Object.keys(template)) {
    if (key === 'byPosition') {
      if (typeof v[key] !== 'object' || v[key] === null) return false;
    } else if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) return false;
  }
  return true;
}

interface PlayerWalk {
  acted: boolean;
  vpip: boolean;
  pfr: boolean;
  /** This player made the first raise preflop. */
  firstRaiser: boolean;
  facedThreeBetPending: boolean;
  isPreflopAggressor: boolean;
  cbetDecisionDone: boolean;
}

/** Derives the counters for every player in one hand from its public action log. */
export function extractHandStats(record: HandRecord): Map<string, StatCounters> {
  const out = new Map<string, StatCounters>();
  const walks = new Map<number, PlayerWalk>();
  const bySeat = new Map<number, RecordedPlayer>();
  const bb = record.bb;

  for (const p of record.players) {
    const c = emptyCounters();
    c.hands = 1;
    out.set(p.id, c);
    bySeat.set(p.seat, p);
    walks.set(p.seat, { acted: false, vpip: false, pfr: false, firstRaiser: false, facedThreeBetPending: false, isPreflopAggressor: false, cbetDecisionDone: false });
    const pos = (c.byPosition[p.position] = { hands: 1, decisions: 0, vpip: 0, pfr: 0, net: p.net, bbNet: p.net / bb });
    pos.hands = 1;
  }

  let preflopRaises = 0;
  let preflopAggressorSeat: number | null = null;
  let flopBetBySeat: number | null = null;
  let flopRaised = false;
  let riverLastAggressiveKind: 'bet' | 'raise' | null = null;
  const riverCallers = new Set<number>();
  const riverBettors = new Set<number>();
  let sawFlopSeats = new Set<number>();
  let flopReached = false;
  const folded = new Set<number>();

  for (const e of record.events) {
    if (e.t === 'board' && e.street === 'flop') {
      flopReached = true;
      sawFlopSeats = new Set(record.players.filter((p) => !folded.has(p.seat)).map((p) => p.seat));
    }
    if (e.t !== 'action') continue;
    const p = bySeat.get(e.seat)!;
    const c = out.get(p.id)!;
    const w = walks.get(e.seat)!;
    const pos = c.byPosition[p.position];
    const aggressive = e.action === 'bet' || e.action === 'raise';
    if (e.action === 'fold') folded.add(e.seat);

    if (e.street === 'preflop') {
      if (!w.acted) {
        w.acted = true;
        c.decisions = 1;
        pos.decisions = 1;
        const firstIn = preflopRaises === 0;
        if (firstIn && (p.position === 'CO' || p.position === 'BTN' || p.position === 'SB')) {
          c.stealOpp = 1;
          if (e.action === 'raise') c.steal = 1;
        }
      }
      const stealer = preflopAggressorSeat !== null ? bySeat.get(preflopAggressorSeat)!.position : null;
      const facingSteal = preflopRaises === 1 && (stealer === 'CO' || stealer === 'BTN' || stealer === 'SB');
      if (facingSteal && (p.position === 'BB' || p.position === 'SB') && !w.pfr) {
        c.blindFacedSteal = 1;
        if (e.action === 'fold') c.blindFoldSteal = 1;
        if (p.position === 'BB') {
          c.bbFacedSteal = 1;
          if (e.action !== 'fold') c.bbDefend = 1;
        }
      }
      if (preflopRaises === 1 && !w.firstRaiser) {
        c.threeBetOpp = 1;
        if (e.action === 'raise') c.threeBet = 1;
      }
      if (w.firstRaiser && preflopRaises === 2 && !w.facedThreeBetPending) {
        w.facedThreeBetPending = true;
        c.faced3Bet = 1;
        if (e.action === 'fold') c.foldTo3Bet = 1;
        if (e.action === 'raise') c.fourBet = 1;
      }
      if (e.action === 'call' || e.action === 'raise') {
        if (!w.vpip) {
          w.vpip = true;
          c.vpip = 1;
          pos.vpip = 1;
        }
      }
      if (e.action === 'raise') {
        if (!w.pfr) {
          w.pfr = true;
          c.pfr = 1;
          pos.pfr = 1;
        }
        if (preflopRaises === 0) w.firstRaiser = true;
        preflopRaises++;
        preflopAggressorSeat = e.seat;
      }
    } else {
      // Bets and raises are sized against the pot before the action, call included for raises.
      if (aggressive) {
        const base = e.potBefore + e.facing;
        const raisePart = e.added - e.facing;
        if (base > 0 && raisePart > 0) {
          const ratio = raisePart / base;
          c.betCount++;
          c.betPotRatioSum += ratio;
          if (ratio < 0.25 && !e.allIn) c.tinyBets++;
          if (ratio > 1.5) c.hugeBets++;
        }
      }
      if (e.action === 'bet') c.postBets++;
      else if (e.action === 'raise') c.postRaises++;
      else if (e.action === 'call') c.postCalls++;
      else if (e.action === 'fold') c.postFolds++;
      else c.postChecks++;

      if (e.facing > 0) {
        if (e.street === 'flop') {
          c.facedBetFlop++;
          if (e.action === 'fold') c.foldBetFlop++;
        } else if (e.street === 'turn') {
          c.facedBetTurn++;
          if (e.action === 'fold') c.foldBetTurn++;
        } else {
          c.facedBetRiver++;
          if (e.action === 'fold') c.foldBetRiver++;
          if (e.action === 'call') {
            c.callBetRiver++;
            riverCallers.add(e.seat);
          }
          if (e.action === 'raise') c.raiseBetRiver++;
          if (riverLastAggressiveKind === 'raise') {
            c.facedRiverRaise++;
            if (e.action === 'call') c.calledRiverRaise++;
          }
        }
      }

      if (e.street === 'flop') {
        if (preflopAggressorSeat === e.seat && !w.cbetDecisionDone && flopBetBySeat === null) {
          w.cbetDecisionDone = true;
          c.cbetOpp = 1;
          if (e.action === 'bet') c.cbet = 1;
        }
        if (flopBetBySeat !== null && flopBetBySeat === preflopAggressorSeat && !flopRaised && e.seat !== flopBetBySeat) {
          c.facedCbet = 1;
          if (e.action === 'fold') c.foldToCbet = 1;
        }
        if (e.action === 'bet') flopBetBySeat = e.seat;
        if (e.action === 'raise') flopRaised = true;
      }
      if (e.street === 'river') {
        if (aggressive) {
          riverLastAggressiveKind = e.action as 'bet' | 'raise';
          riverBettors.add(e.seat);
          c.riverBets++;
        }
      }
    }
  }

  const showdownWinners = new Set<number>();
  if (record.wentToShowdown) {
    for (const pot of record.pots) {
      if (pot.eligible.length > 1) for (const w of pot.winners) showdownWinners.add(w.seat);
    }
  }

  for (const p of record.players) {
    const c = out.get(p.id)!;
    c.net = p.net;
    c.bbNet = p.net / bb;
    if (p.net > 0) {
      c.handsWon = 1;
      c.biggestPotWon = record.totalPot;
    } else if (p.net < 0) {
      c.biggestPotLost = -p.net;
    }
    if (flopReached && sawFlopSeats.has(p.seat)) {
      c.sawFlop = 1;
      if (record.wentToShowdown && !p.folded) {
        c.wtsd = 1;
        if (showdownWinners.has(p.seat)) c.wsd = 1;
      }
    }
    if (riverBettors.has(p.seat) && record.wentToShowdown && !p.folded && !showdownWinners.has(p.seat)) {
      c.riverBetsLostAtShowdown = 1;
    }
    if (riverCallers.has(p.seat) && record.wentToShowdown && !p.folded) {
      c.riverCallsToShowdown = 1;
      if (showdownWinners.has(p.seat)) c.wonRiverCalls = 1;
    }
  }

  if (record.allInEquity) {
    for (const entry of record.allInEquity) {
      const p = bySeat.get(entry.seat);
      if (!p) continue;
      const c = out.get(p.id)!;
      c.allInShowdowns = 1;
      c.allInEquitySum = entry.equity;
      c.allInEvDiff = entry.evDiff / bb;
    }
  }
  return out;
}

export interface Rate {
  /** Null when the denominator is zero: never reported as 0%. */
  value: number | null;
  n: number;
}

export const rate = (num: number, den: number): Rate => ({ value: den > 0 ? num / den : null, n: den });

export interface PublishedStats {
  hands: number;
  vpip: Rate;
  pfr: Rate;
  threeBet: Rate;
  foldTo3Bet: Rate;
  fourBet: Rate;
  cbet: Rate;
  foldToCbet: Rate;
  wtsd: Rate;
  wsd: Rate;
  showdownFreq: Rate;
  af: Rate;
  afq: Rate;
  bb100: Rate;
  riverCall: Rate;
  allInEquity: Rate;
  bbDefend: Rate;
  steal: Rate;
  avgBetSize: Rate;
  winRate: Rate;
}

export function publishStats(c: StatCounters): PublishedStats {
  const aggressive = c.postBets + c.postRaises;
  return {
    hands: c.hands,
    vpip: rate(c.vpip, c.decisions),
    pfr: rate(c.pfr, c.decisions),
    threeBet: rate(c.threeBet, c.threeBetOpp),
    foldTo3Bet: rate(c.foldTo3Bet, c.faced3Bet),
    fourBet: rate(c.fourBet, c.faced3Bet),
    cbet: rate(c.cbet, c.cbetOpp),
    foldToCbet: rate(c.foldToCbet, c.facedCbet),
    wtsd: rate(c.wtsd, c.sawFlop),
    wsd: rate(c.wsd, c.wtsd),
    showdownFreq: rate(c.wtsd, c.hands),
    af: { value: c.postCalls > 0 ? aggressive / c.postCalls : null, n: aggressive + c.postCalls },
    afq: rate(aggressive, aggressive + c.postCalls + c.postFolds),
    bb100: { value: c.hands > 0 ? (c.bbNet / c.hands) * 100 : null, n: c.hands },
    riverCall: rate(c.callBetRiver, c.facedBetRiver),
    allInEquity: rate(c.allInEquitySum, c.allInShowdowns),
    bbDefend: rate(c.bbDefend, c.bbFacedSteal),
    steal: rate(c.steal, c.stealOpp),
    avgBetSize: rate(c.betPotRatioSum, c.betCount),
    winRate: rate(c.handsWon, c.hands),
  };
}

/** Wilson score interval: how uncertain a frequency is given its sample size. */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

/** Per-table or per-session store of what has publicly been observed about each player. */
export class ObservedStats {
  private readonly byPlayer = new Map<string, StatCounters>();

  addRecord(record: HandRecord): void {
    for (const [id, delta] of extractHandStats(record)) {
      const existing = this.byPlayer.get(id);
      if (existing) addCounters(existing, delta);
      else this.byPlayer.set(id, delta);
    }
  }

  get(id: string): StatCounters | undefined {
    return this.byPlayer.get(id);
  }

  set(id: string, counters: StatCounters): void {
    this.byPlayer.set(id, counters);
  }

  entries(): IterableIterator<[string, StatCounters]> {
    return this.byPlayer.entries();
  }
}

/** Population priors the AI assumes before it has seen a player. */
const PRIOR = {
  vpip: 0.28,
  pfr: 0.16,
  threeBet: 0.07,
  foldTo3Bet: 0.55,
  cbet: 0.6,
  foldToCbet: 0.42,
  foldFlop: 0.38,
  foldTurn: 0.38,
  foldRiver: 0.4,
  afq: 0.35,
  wtsd: 0.3,
  steal: 0.3,
  blindFold: 0.6,
};

export interface PlayerRead {
  hands: number;
  vpip: number;
  pfr: number;
  threeBet: number;
  foldTo3Bet: number;
  cbet: number;
  foldToCbet: number;
  foldFlop: number;
  foldTurn: number;
  foldRiver: number;
  afq: number;
  wtsd: number;
  blindFold: number;
}

/** Population-average read: what a bot believes about an unknown or ignored player. */
export const PRIOR_READ: PlayerRead = {
  hands: 0,
  vpip: PRIOR.vpip,
  pfr: PRIOR.pfr,
  threeBet: PRIOR.threeBet,
  foldTo3Bet: PRIOR.foldTo3Bet,
  cbet: PRIOR.cbet,
  foldToCbet: PRIOR.foldToCbet,
  foldFlop: PRIOR.foldFlop,
  foldTurn: PRIOR.foldTurn,
  foldRiver: PRIOR.foldRiver,
  afq: PRIOR.afq,
  wtsd: PRIOR.wtsd,
  blindFold: PRIOR.blindFold,
};

/**
 * Observed stats shrunk toward the population. `k` pseudo-observations mean a
 * handful of hands barely moves a read, which keeps adaptation from overreacting.
 */
export function buildRead(c: StatCounters | undefined, k = 24): PlayerRead {
  if (!c) return PRIOR_READ;
  const shrink = (num: number, den: number, prior: number) => (num + prior * k) / (den + k);
  const aggressive = c.postBets + c.postRaises;
  return {
    hands: c.hands,
    vpip: shrink(c.vpip, c.decisions, PRIOR.vpip),
    pfr: shrink(c.pfr, c.decisions, PRIOR.pfr),
    threeBet: shrink(c.threeBet, c.threeBetOpp, PRIOR.threeBet),
    foldTo3Bet: shrink(c.foldTo3Bet, c.faced3Bet, PRIOR.foldTo3Bet),
    cbet: shrink(c.cbet, c.cbetOpp, PRIOR.cbet),
    foldToCbet: shrink(c.foldToCbet, c.facedCbet, PRIOR.foldToCbet),
    foldFlop: shrink(c.foldBetFlop, c.facedBetFlop, PRIOR.foldFlop),
    foldTurn: shrink(c.foldBetTurn, c.facedBetTurn, PRIOR.foldTurn),
    foldRiver: shrink(c.foldBetRiver, c.facedBetRiver, PRIOR.foldRiver),
    afq: shrink(aggressive, aggressive + c.postCalls + c.postFolds, PRIOR.afq),
    wtsd: shrink(c.wtsd, c.sawFlop, PRIOR.wtsd),
    blindFold: shrink(c.blindFoldSteal, c.blindFacedSteal, PRIOR.blindFold),
  };
}

/** Blends a player's read with the population by `weight` (0 ignores the observations). */
export function blendRead(read: PlayerRead, weight: number): PlayerRead {
  const w = Math.max(0, Math.min(1, weight));
  const mix = (x: number, prior: number) => prior + (x - prior) * w;
  return {
    hands: read.hands,
    vpip: mix(read.vpip, PRIOR.vpip),
    pfr: mix(read.pfr, PRIOR.pfr),
    threeBet: mix(read.threeBet, PRIOR.threeBet),
    foldTo3Bet: mix(read.foldTo3Bet, PRIOR.foldTo3Bet),
    cbet: mix(read.cbet, PRIOR.cbet),
    foldToCbet: mix(read.foldToCbet, PRIOR.foldToCbet),
    foldFlop: mix(read.foldFlop, PRIOR.foldFlop),
    foldTurn: mix(read.foldTurn, PRIOR.foldTurn),
    foldRiver: mix(read.foldRiver, PRIOR.foldRiver),
    afq: mix(read.afq, PRIOR.afq),
    wtsd: mix(read.wtsd, PRIOR.wtsd),
    blindFold: mix(read.blindFold, PRIOR.blindFold),
  };
}

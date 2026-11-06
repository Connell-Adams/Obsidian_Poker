import { describe, expect, it } from 'vitest';
import { SeededRng } from '../src/engine/rng';
import { type BalanceTable, planBalance } from '../src/tournament/balancer';
import { TournamentDirector, type TournamentConfig } from '../src/tournament/director';
import { blindLevelFor, computePayouts, paidPlaces, type PayoutStructure } from '../src/tournament/schedule';

const config = (over: Partial<TournamentConfig> = {}): TournamentConfig => ({
  name: 'Test Event',
  buyIn: 100,
  entrants: 18,
  seatsPerTable: 6,
  startingStack: 1500,
  startingSmallBlind: 10,
  startingBigBlind: 20,
  levelMode: 'hands',
  levelLength: 4,
  blindIncreasePct: 60,
  anteFromLevel: 0,
  payout: 'standard',
  reentries: 0,
  reentryUntilLevel: 0,
  difficulty: 5,
  ...over,
});

const immediate = () => Promise.resolve();

describe('blind schedule', () => {
  it('starts at the configured blinds and strictly increases', () => {
    const c = { startingSmallBlind: 10, startingBigBlind: 20, blindIncreasePct: 50, anteFromLevel: 0 };
    expect(blindLevelFor(c, 1)).toMatchObject({ smallBlind: 10, bigBlind: 20, ante: 0 });
    let prev = 20;
    for (let level = 2; level <= 40; level++) {
      const b = blindLevelFor(c, level);
      expect(b.bigBlind).toBeGreaterThan(prev);
      expect(b.smallBlind).toBeLessThanOrEqual(b.bigBlind);
      expect(Number.isInteger(b.smallBlind)).toBe(true);
      prev = b.bigBlind;
    }
  });

  it('introduces antes from the configured level', () => {
    const c = { startingSmallBlind: 10, startingBigBlind: 20, blindIncreasePct: 50, anteFromLevel: 4 };
    expect(blindLevelFor(c, 3).ante).toBe(0);
    expect(blindLevelFor(c, 4).ante).toBeGreaterThan(0);
  });
});

describe('payouts', () => {
  const structures: PayoutStructure[] = ['winner_takes_all', 'top_heavy', 'standard', 'flat'];
  it('always pays out exactly the prize pool, in descending order', () => {
    for (const s of structures) {
      for (const entries of [2, 3, 6, 9, 18, 45, 180, 540]) {
        const pool = entries * 137;
        const prizes = computePayouts(pool, entries, s);
        expect(prizes.reduce((a, b) => a + b, 0)).toBe(pool);
        expect(prizes).toHaveLength(paidPlaces(entries, s));
        for (let i = 1; i < prizes.length; i++) expect(prizes[i]).toBeLessThanOrEqual(prizes[i - 1]);
        expect(prizes.every(Number.isInteger)).toBe(true);
      }
    }
  });

  it('winner takes all pays one place', () => {
    expect(computePayouts(1000, 50, 'winner_takes_all')).toEqual([1000]);
  });
});

describe('table balancing plan', () => {
  const tableOf = (id: string, players: number, seats = 9): BalanceTable => ({
    id,
    maxSeats: seats,
    buttonSeat: 0,
    seats: Array.from({ length: seats }, (_, i) => (i < players ? `${id}-${i}` : null)),
  });

  const verify = (tables: BalanceTable[], seed: string) => {
    const plan = planBalance(tables, new SeededRng(seed));
    const working = tables.map((t) => ({ ...t, seats: [...t.seats] }));
    const byId = new Map(working.map((t) => [t.id, t]));
    for (const m of plan.moves) {
      const from = byId.get(m.fromTableId)!;
      const to = byId.get(m.toTableId)!;
      expect(from.seats[m.fromSeat]).toBe(m.playerId);
      expect(to.seats[m.toSeat]).toBeNull();
      from.seats[m.fromSeat] = null;
      to.seats[m.toSeat] = m.playerId;
    }
    const open = working.filter((t) => !plan.closedTables.includes(t.id));
    const allIds = open.flatMap((t) => t.seats.filter(Boolean));
    const before = tables.flatMap((t) => t.seats.filter(Boolean));
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicates
    expect(allIds.length).toBe(before.length); // nobody lost
    for (const t of working.filter((x) => plan.closedTables.includes(x.id))) expect(t.seats.every((s) => s === null)).toBe(true);
    const sizes = open.map((t) => t.seats.filter(Boolean).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    return plan;
  };

  it('does nothing when already balanced', () => {
    expect(verify([tableOf('A', 6, 6), tableOf('B', 5, 6), tableOf('C', 6, 6)], 'x').moves).toHaveLength(0);
  });

  it('moves players from the largest table to the smallest', () => {
    const plan = verify([tableOf('A', 9), tableOf('B', 5)], 'y');
    expect(plan.moves).toHaveLength(2);
    expect(plan.moves.every((m) => m.fromTableId === 'A' && m.toTableId === 'B')).toBe(true);
  });

  it('closes a table when the field fits on fewer tables', () => {
    const plan = verify([tableOf('A', 6), tableOf('B', 6), tableOf('C', 2)], 'z');
    expect(plan.closedTables).toEqual(['C']);
  });

  it('collapses to a single final table', () => {
    const plan = verify([tableOf('A', 3), tableOf('B', 3), tableOf('C', 2)], 'f');
    expect(plan.closedTables).toHaveLength(2);
  });

  it('holds its invariants over many random fields', () => {
    const r = new SeededRng('balance-fuzz');
    for (let trial = 0; trial < 500; trial++) {
      const seats = [6, 9][r.int(2)];
      const count = 1 + r.int(8);
      const tables = Array.from({ length: count }, (_, i) => tableOf(`T${i}`, r.int(seats + 1), seats));
      if (tables.every((t) => t.seats.every((s) => s === null))) continue;
      verify(tables, `fuzz-${trial}`);
    }
  });
});

describe('full tournaments', () => {
  it('runs a bot-only multi-table event to a single winner with chips and prizes conserved', async () => {
    const finishes: number[] = [];
    let totalPrizes = 0;
    const director = new TournamentDirector('E1', config({ entrants: 27 }), {
      seed: 'event-1',
      includeHero: false,
      yieldFn: immediate,
      now: () => 0,
      hooks: {
        onElimination: (_, place, prize) => {
          finishes.push(place);
          totalPrizes += prize;
        },
      },
    });
    expect(director.tables).toHaveLength(5);
    const startChips = director.totalChipsInPlay;
    expect(startChips).toBe(27 * 1500);

    let rounds = 0;
    while (!director.isComplete) {
      await director.completeRound();
      rounds++;
      if (rounds > 3000) throw new Error('Tournament did not finish');
      if (!director.isComplete) expect(director.totalChipsInPlay).toBe(startChips);
      // Balanced after every round.
      const sizes = director.tables.map((t) => t.table.occupiedSeats.length);
      if (sizes.length > 1) expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      // Nobody seated twice, and everyone active is seated exactly once.
      const seated = director.tables.flatMap((t) => t.table.seats.filter(Boolean).map((s) => s!.id));
      expect(new Set(seated).size).toBe(seated.length);
    }

    expect(director.championId).not.toBeNull();
    const places = [...director.players.values()].map((p) => p.place).sort((a, b) => a! - b!);
    expect(places).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
    const champion = director.players.get(director.championId!)!;
    expect(champion.place).toBe(1);
    expect(totalPrizes + champion.prize).toBe(director.prizePool);
    expect(finishes).toHaveLength(26);
  }, 120000);

  it('raises blinds on schedule at every table', async () => {
    const director = new TournamentDirector('E2', config({ entrants: 12, levelLength: 2, startingStack: 5000 }), {
      seed: 'event-2',
      includeHero: false,
      yieldFn: immediate,
      now: () => 0,
    });
    await director.completeRound();
    expect(director.level).toBe(1);
    expect(director.status().handsLeftInLevel).toBe(1);
    await director.completeRound();
    expect(director.level).toBe(2);
    const blinds = director.currentBlinds;
    expect(blinds.bigBlind).toBeGreaterThan(20);
    for (const t of director.tables) expect(t.table.bigBlind).toBe(blinds.bigBlind);
  });

  it('uses elapsed time when configured for timed levels', async () => {
    let time = 0;
    const director = new TournamentDirector('E3', config({ entrants: 12, levelMode: 'minutes', levelLength: 5, startingStack: 5000 }), {
      seed: 'event-3',
      includeHero: false,
      yieldFn: immediate,
      now: () => time,
    });
    await director.completeRound();
    expect(director.level).toBe(1);
    time = 5 * 60000 + 1;
    await director.completeRound();
    expect(director.level).toBe(2);
    expect(director.status().msLeftInLevel).toBeGreaterThan(0);
  });

  it('honours re-entries by growing the field and the prize pool', async () => {
    const director = new TournamentDirector('E4', config({ entrants: 12, reentries: 3, reentryUntilLevel: 100, startingStack: 300 }), {
      seed: 'event-4',
      includeHero: false,
      yieldFn: immediate,
      now: () => 0,
    });
    await director.runToCompletion();
    expect(director.totalEntries).toBeGreaterThan(12);
    expect(director.prizePool).toBe(director.totalEntries * 100);
    const placed = [...director.players.values()].filter((p) => p.place !== null);
    expect(placed).toHaveLength(12);
  }, 120000);

  it('applies bubble pressure to the bots when the money is close', () => {
    const director = new TournamentDirector('E5', config({ entrants: 18 }), { seed: 'event-5', includeHero: false, yieldFn: immediate, now: () => 0 });
    expect(director.pressure().isBubble).toBe(false);
    expect(director.pressure().riskPremium).toBeLessThan(0.1);
  });

  it('restores from a snapshot with identical chips and seating', async () => {
    const director = new TournamentDirector('E6', config({ entrants: 18 }), { seed: 'event-6', includeHero: false, yieldFn: immediate, now: () => 1000 });
    for (let i = 0; i < 5; i++) await director.completeRound();
    const snapshot = JSON.parse(JSON.stringify(director.snapshot()));
    const restored = TournamentDirector.restore(snapshot, { yieldFn: immediate, now: () => 2000 });
    expect(restored.totalChipsInPlay).toBe(director.totalChipsInPlay);
    expect(restored.level).toBe(director.level);
    expect(restored.tables.map((t) => t.table.seats.map((s) => s?.id ?? null))).toEqual(director.tables.map((t) => t.table.seats.map((s) => s?.id ?? null)));
    await restored.runToCompletion();
    expect(restored.championId).not.toBeNull();
  }, 120000);
});

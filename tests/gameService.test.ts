import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameService, isValidOpenSession } from '../src/app/gameService';
import { DEFAULT_STARTING_BANKROLL, type LedgerEntry } from '../src/career/career';
import type { HandRecord } from '../src/history/record';
import { MemoryStore } from '../src/persistence/db';
import { FakeClock } from '../src/session/clock';
import type { TableController } from '../src/session/tableController';
import type { TournamentConfig } from '../src/tournament/director';

const CASH = { smallBlind: 5, bigBlind: 10, buyIn: 1000, opponentStack: 1000, difficulty: 5, tables: ['6max', '2max'] as Array<'6max' | '2max'> };

const tournament = (over: Partial<TournamentConfig> = {}): TournamentConfig => ({
  name: 'Test Event',
  buyIn: 500,
  entrants: 12,
  seatsPerTable: 6,
  startingStack: 600,
  startingSmallBlind: 25,
  startingBigBlind: 50,
  levelMode: 'hands',
  levelLength: 3,
  blindIncreasePct: 60,
  anteFromLevel: 0,
  payout: 'standard',
  reentries: 0,
  reentryUntilLevel: 0,
  difficulty: 3,
  ...over,
});

/** Keeps the app moving: advances virtual time and lets promises settle, as the browser would. */
async function run(clock: FakeClock, until: () => boolean, onTick: () => void = () => undefined, maxSteps = 40000): Promise<void> {
  for (let i = 0; i < maxSteps && !until(); i++) {
    clock.advance(120);
    onTick();
    await Promise.resolve();
    await Promise.resolve();
    if (i % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!until()) throw new Error('Condition not reached');
}

function autoPlay(controllers: () => readonly TableController[], style: 'call' | 'fold' = 'call') {
  return () => {
    for (const c of controllers()) {
      const view = c.getView();
      if (view.phase === 'hero_turn' && view.legal) {
        const l = view.legal;
        if (style === 'fold') c.heroAct(l.canCheck ? { type: 'check' } : { type: 'fold' });
        else c.heroAct(l.canCheck ? { type: 'check' } : l.callAmount <= 60 ? { type: 'call' } : { type: 'fold' });
      }
    }
  };
}

const ledgerSum = (entries: LedgerEntry[]) => entries.reduce((sum, e) => sum + e.amount, 0);

describe('GameService integration', () => {
  let store: MemoryStore;
  let clock: FakeClock;

  beforeEach(() => {
    store = new MemoryStore();
    clock = new FakeClock();
    vi.stubGlobal('localStorage', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const boot = () => GameService.create({ store, clock });

  describe('cash sessions', () => {
    it('charges every table up front and pays back exactly what was won or lost', async () => {
      const service = await boot();
      expect(service.startCash(CASH).ok).toBe(true);
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 2000);
      const session = service.session!;
      const controllers = () => session.tables.filter((t) => !t.closed).map((t) => t.controller);
      const tick = autoPlay(controllers);

      await run(clock, () => session.stats.hands >= 25, () => {
        tick();
        for (const c of controllers()) {
          if (c.getView().needsRebuy) service.rebuy(c.config.id, 1000);
        }
      });

      for (const t of controllers()) service.leaveTable(t.config.id);
      await run(clock, () => service.session === null, tick);

      const expected = DEFAULT_STARTING_BANKROLL + session.stats.net;
      expect(service.career.bankroll).toBe(expected);
      await service.career.flush();
      expect(ledgerSum(await service.career.ledger())).toBe(expected);
      expect(service.lastSummary?.net).toBe(session.stats.net);
      expect(service.career.profile.handsPlayed).toBe(session.stats.hands);
      expect(service.career.profile.cashSessions).toBe(1);
    }, 120000);

    it('refuses a buy-in the bankroll cannot cover, charging nothing', async () => {
      const service = await boot();
      const result = service.startCash({ ...CASH, buyIn: DEFAULT_STARTING_BANKROLL });
      expect(result.ok).toBe(false);
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL);
      expect(service.session).toBeNull();
    });

    it('refuses a second game while one is running', async () => {
      const service = await boot();
      service.startCash(CASH);
      const bankroll = service.career.bankroll;
      expect(service.startCash(CASH).ok).toBe(false);
      expect(service.registerTournament(tournament(), 0).ok).toBe(false);
      expect(service.career.bankroll).toBe(bankroll);
      for (const t of service.session!.tables) t.controller.destroy();
    });

    it('rejects a top-up during a hand, never moving chips', async () => {
      const service = await boot();
      service.startCash({ ...CASH, tables: ['2max'] });
      const c = service.session!.tables[0].controller;
      await run(clock, () => c.isHandInProgress);
      const before = service.career.bankroll;
      expect(service.rebuy(c.config.id, 100).ok).toBe(false);
      expect(service.career.bankroll).toBe(before);
      c.destroy();
    });
  });

  describe('browser refresh', () => {
    /** Plays some hands, then throws away all in-memory state as a page reload would. */
    async function playThenRefresh(hands: number) {
      const service = await boot();
      service.startCash(CASH);
      const session = service.session!;
      const controllers = () => session.tables.map((t) => t.controller);
      await run(clock, () => session.stats.hands >= hands, () => {
        autoPlay(controllers)();
        for (const c of controllers()) if (c.getView().needsRebuy) service.rebuy(c.config.id, 1000);
      });
      // Wait for the between-hands save, then hard-stop mid-whatever.
      await run(clock, () => controllers().every((c) => !c.isHandInProgress) || true);
      await service.career.flush();
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const c of controllers()) c.destroy();
      return { before: session };
    }

    it('saves a hand and its chips together: history, stacks and bankroll always agree', async () => {
      const service = await boot();
      service.startCash(CASH);
      const session = service.session!;
      const controllers = () => session.tables.map((t) => t.controller);
      const tick = autoPlay(controllers);
      // Stop at the very moment a hand has just finished, inside the pause before the next one.
      let handsSeen = 0;
      await run(clock, () => session.stats.hands > handsSeen && session.stats.hands >= 5, () => {
        tick();
        for (const c of controllers()) if (c.getView().needsRebuy) service.rebuy(c.config.id, 1000);
        if (session.stats.hands < 5) handsSeen = session.stats.hands;
      });
      await service.career.flush();
      for (const c of controllers()) c.destroy();

      const reborn = await boot();
      const open = reborn.openSession!;
      if (open.kind !== 'cash') throw new Error('wrong kind');
      const hands = await reborn.loadHands();
      const handNet = hands.reduce((sum, h) => sum + h.heroNet, 0);
      const invested = open.tables.reduce((sum, t) => sum + t.invested, 0);
      const chips = open.tables.reduce((sum, t) => sum + t.seats.find((s) => s.isHuman)!.stack, 0);
      expect(hands.length).toBe(open.stats.hands);
      expect(reborn.career.profile.handsPlayed).toBe(open.stats.hands);
      expect(handNet).toBe(open.stats.net);
      expect(chips).toBe(invested + handNet);

      reborn.abandonOpenSession();
      await reborn.career.flush();
      expect(reborn.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL + handNet);
    }, 120000);

    it('cannot pay a table twice: a cash-out removes it from the saved session in one write', async () => {
      const service = await boot();
      service.startCash(CASH);
      const session = service.session!;
      const controllers = () => session.tables.filter((t) => !t.closed).map((t) => t.controller);
      const tick = autoPlay(controllers);
      await run(clock, () => session.stats.hands >= 3, tick);
      const first = session.tables[0].controller;
      service.leaveTable(first.config.id);
      await run(clock, () => session.tables[0].closed, tick);
      await service.career.flush();
      const bankrollAfterCashout = service.career.bankroll;
      for (const c of controllers()) c.destroy();

      const reborn = await boot();
      const open = reborn.openSession!;
      if (open.kind !== 'cash') throw new Error('wrong kind');
      expect(open.tables).toHaveLength(1);
      expect(open.tables[0].config.id).toBe(session.tables[1].controller.config.id);
      const remaining = open.tables[0].seats.find((s) => s.isHuman)!.stack;
      expect(reborn.career.bankroll).toBe(bankrollAfterCashout);
      reborn.abandonOpenSession();
      expect(reborn.career.bankroll).toBe(bankrollAfterCashout + remaining);
    }, 120000);

    it('saves a top-up with its chips, so a refresh right after cannot lose them', async () => {
      const service = await boot();
      service.startCash({ ...CASH, tables: ['2max'] });
      const session = service.session!;
      const c = session.tables[0].controller;
      const tick = autoPlay(() => [c]);
      await run(clock, () => session.stats.hands >= 1 && !c.isHandInProgress, tick);
      const stackBefore = c.table.seats[c.getView().heroSeat!]!.stack;
      const bankrollBefore = service.career.bankroll;
      expect(service.rebuy(c.config.id, 400).ok).toBe(true);
      expect(service.career.bankroll).toBe(bankrollBefore - 400);
      await service.career.flush();
      c.destroy();

      const reborn = await boot();
      const open = reborn.openSession!;
      if (open.kind !== 'cash') throw new Error('wrong kind');
      expect(open.tables[0].seats.find((s) => s.isHuman)!.stack).toBe(stackBefore + 400);
      expect(open.tables[0].invested).toBe(CASH.buyIn + 400);
      expect(reborn.career.bankroll).toBe(bankrollBefore - 400);
    }, 60000);

    it('refunds a tournament entry if the page closes before it starts', async () => {
      const service = await boot();
      service.registerTournament(tournament(), 300);
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 500);
      await service.career.flush();

      const reborn = await boot();
      expect(reborn.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL);
      expect(reborn.toasts.some((t) => /refunded/i.test(t.title))).toBe(true);
      await reborn.career.flush();
      // Only once, however many times the page loads.
      const third = await boot();
      expect(third.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL);
      expect(ledgerSum(await third.career.ledger())).toBe(DEFAULT_STARTING_BANKROLL);
      service.cancelPendingTournament();
    });

    it('offers the saved session, and cashing out credits it exactly once', async () => {
      await playThenRefresh(8);
      const service = await boot();
      expect(service.openSession?.kind).toBe('cash');
      const open = service.openSession!;
      if (open.kind !== 'cash') throw new Error('wrong kind');
      const chips = open.tables.reduce((sum, t) => sum + (t.seats.find((s) => s.isHuman)?.stack ?? 0), 0);
      const bankrollBefore = service.career.bankroll;
      service.abandonOpenSession();
      expect(service.career.bankroll).toBe(bankrollBefore + chips);
      await service.career.flush();
      await new Promise((resolve) => setTimeout(resolve, 5));

      // A further refresh must not find it again or pay twice.
      const again = await boot();
      expect(again.openSession).toBeNull();
      expect(again.career.bankroll).toBe(bankrollBefore + chips);
      expect(ledgerSum(await again.career.ledger())).toBe(again.career.bankroll);
    }, 120000);

    it('resumes with the same stacks and carries on with correct accounting', async () => {
      await playThenRefresh(8);
      const service = await boot();
      const open = service.openSession!;
      if (open.kind !== 'cash') throw new Error('wrong kind');
      const saved = open.tables.map((t) => t.seats.find((s) => s.isHuman)!.stack);
      const statsNet = open.stats.net;
      service.resumeOpenSession();
      const session = service.session!;
      expect(session.tables.map((t) => t.controller.getView().seats[0]!.stack)).toEqual(saved);
      expect(session.stats.net).toBe(statsNet);

      const controllers = () => session.tables.filter((t) => !t.closed).map((t) => t.controller);
      const tick = autoPlay(controllers);
      await run(clock, () => session.stats.hands >= 14, () => {
        tick();
        for (const c of controllers()) if (c.getView().needsRebuy) service.rebuy(c.config.id, 1000);
      });
      for (const c of controllers()) service.leaveTable(c.config.id);
      await run(clock, () => service.session === null, tick);
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL + session.stats.net);
    }, 120000);

    it('keeps hand history, statistics and career totals across a refresh', async () => {
      const { before } = await playThenRefresh(6);
      const service = await boot();
      expect(service.career.profile.handsPlayed).toBeGreaterThanOrEqual(6);
      expect(service.career.profile.counters.hands).toBe(service.career.profile.handsPlayed);
      const hands = await service.loadHands();
      expect(hands.length).toBe(service.career.profile.handsPlayed);
      expect(hands.every((h: HandRecord) => h.sessionId === before.id)).toBe(true);
    }, 120000);

    it('discards a damaged saved session rather than trusting it', async () => {
      const first = await boot();
      await first.career.flush();
      await store.commit([{ store: 'meta', key: 'openSession', value: { kind: 'cash', id: 'x', title: 'y', stats: {}, tables: [{ invested: 'lots', config: {}, seats: [{ stack: 1e9, seat: 'z' }] }] } }]);
      const service = await boot();
      expect(service.openSession).toBeNull();
      expect(service.toasts.some((t) => /could not be read/.test(t.title))).toBe(true);
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL);
    });

    it('validates saved session shapes', () => {
      expect(isValidOpenSession(null)).toBe(false);
      expect(isValidOpenSession({ kind: 'cash', id: 'a', title: 'b', stats: {}, tables: [] })).toBe(false);
      expect(isValidOpenSession({ kind: 'alien', id: 'a', title: 'b', stats: {} })).toBe(false);
      expect(isValidOpenSession({ kind: 'cash', id: 'a', title: 'b', stats: {}, tables: [{ invested: 100, config: {}, seats: [{ seat: 0, stack: 100 }] }] })).toBe(true);
    });
  });

  describe('tournaments', () => {
    it('charges the entry, pays the prize once and records the result', async () => {
      const service = await boot();
      expect(service.registerTournament(tournament(), 0).ok).toBe(true);
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 500);
      const session = service.session!;
      expect(session.director!.tables.length).toBe(2);
      const controllers = () => session.tables.map((t) => t.controller);
      const tick = autoPlay(controllers);
      await run(clock, () => service.session === null, tick, 80000);

      const hero = session.director!.hero!;
      expect(hero.place).not.toBeNull();
      expect(session.director!.isComplete).toBe(true);
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 500 + hero.prize);
      expect(service.career.profile.tournamentsPlayed).toBe(1);
      await service.career.flush();
      const entries = await service.career.ledger();
      expect(entries.filter((e) => e.kind === 'tournament_prize').length).toBe(hero.prize > 0 ? 1 : 0);
      expect(ledgerSum(entries)).toBe(service.career.bankroll);
      const allPrizes = [...session.director!.players.values()].reduce((sum, p) => sum + p.prize, 0);
      expect(allPrizes).toBe(session.director!.prizePool);
    }, 180000);

    it('refunds an entry cancelled before the start', async () => {
      const service = await boot();
      service.registerTournament(tournament(), 60);
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 500);
      expect(service.pendingTournament).not.toBeNull();
      service.cancelPendingTournament();
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL);
      expect(service.pendingTournament).toBeNull();
    });

    it('lets the player walk away and blinds their seat out', async () => {
      const service = await boot();
      service.registerTournament(tournament({ startingStack: 400 }), 0);
      const session = service.session!;
      const c = session.tables[0].controller;
      await run(clock, () => c.getView().phase === 'hero_turn');
      service.forfeitTournament();
      await run(clock, () => service.session === null, () => undefined, 80000);
      const hero = session.director!.hero!;
      expect(hero.place).not.toBeNull();
      expect(session.director!.isComplete).toBe(true);
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 500 + hero.prize);
    }, 180000);

    it('resumes a tournament after a refresh with chips conserved', async () => {
      const service = await boot();
      service.registerTournament(tournament({ entrants: 12, startingStack: 2000 }), 0);
      const session = service.session!;
      const controllers = () => session.tables.map((t) => t.controller);
      const tick = autoPlay(controllers, 'fold');
      await run(clock, () => session.stats.hands >= 3, tick, 80000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const c of controllers()) c.destroy();
      await service.career.flush();
      await new Promise((resolve) => setTimeout(resolve, 5));

      const reborn = await boot();
      expect(reborn.openSession?.kind).toBe('tournament');
      const open = reborn.openSession!;
      if (open.kind !== 'tournament') throw new Error('wrong kind');
      const seatedChips = open.snapshot.tables.flatMap((t) => t.seats).reduce((sum, s) => sum + (s?.stack ?? 0), 0);
      expect(seatedChips).toBe(12 * 2000);
      reborn.resumeOpenSession();
      const next = reborn.session!;
      expect(next.director!.totalChipsInPlay).toBe(12 * 2000);
      next.tables[0].controller.destroy();
    }, 120000);

    it('forfeiting a saved tournament keeps the entry fee spent', async () => {
      const service = await boot();
      service.registerTournament(tournament({ startingStack: 2000 }), 0);
      const session = service.session!;
      const controllers = () => session.tables.map((t) => t.controller);
      await run(clock, () => session.stats.hands >= 1, autoPlay(controllers, 'fold'), 80000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const c of controllers()) c.destroy();
      await service.career.flush();
      const reborn = await boot();
      reborn.abandonOpenSession();
      expect(reborn.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 500);
      expect(reborn.career.profile.tournamentsPlayed).toBe(1);
    }, 120000);
  });

  describe('coach pipeline', () => {
    it('produces a recommendation every 25 hands and stores it', async () => {
      const service = await boot();
      service.startCash({ ...CASH, tables: ['6max'] });
      const session = service.session!;
      const controllers = () => session.tables.map((t) => t.controller);
      const tick = autoPlay(controllers, 'fold');
      await run(clock, () => session.stats.hands >= 26, () => {
        tick();
        for (const c of controllers()) if (c.getView().needsRebuy) service.rebuy(c.config.id, 1000);
      });
      expect(service.windows.length).toBe(1);
      expect(service.recommendations.length).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const c of controllers()) c.destroy();
      const reborn = await boot();
      expect(reborn.recommendations.length).toBe(1);
      expect(reborn.windows.length).toBe(1);
    }, 120000);
  });

  describe('career management', () => {
    it('resets everything only when asked, and not during a session', async () => {
      const service = await boot();
      service.startCash({ ...CASH, tables: ['2max'] });
      await expect(service.resetCareer()).rejects.toThrow();
      service.session!.tables[0].controller.destroy();
      service.session = null;
      await service.resetCareer();
      expect(service.career.bankroll).toBe(DEFAULT_STARTING_BANKROLL);
      expect((await service.career.ledger()).length).toBe(1);
    });
  });
});

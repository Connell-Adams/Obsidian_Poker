import { describe, expect, it, vi } from 'vitest';
import { BotBrain } from '../src/ai/brain';
import { createBotProfile } from '../src/ai/profiles';
import { SeededRng } from '../src/engine/rng';
import type { HandRecord } from '../src/history/record';
import { FakeClock } from '../src/session/clock';
import { DEFAULT_TIMING, TableController, type TableHooks } from '../src/session/tableController';
import { viewPotConsistent } from '../src/session/tableView';

interface Setup {
  players?: number;
  maxSeats?: number;
  stack?: number;
  heroStack?: number;
  hero?: boolean;
  hooks?: TableHooks;
  seed?: string;
  timing?: Partial<typeof DEFAULT_TIMING>;
}

function makeTable(clock: FakeClock, id: string, setup: Setup = {}): TableController {
  const seed = setup.seed ?? id;
  const rng = new SeededRng(seed);
  const n = setup.players ?? 6;
  const seats = [];
  const withHero = setup.hero ?? true;
  for (let i = 0; i < n; i++) {
    if (withHero && i === 0) {
      seats.push({ seat: 0, id: `${id}-hero`, name: 'Hero', isHuman: true, avatar: 0, stack: setup.heroStack ?? setup.stack ?? 1000 });
    } else {
      const profile = createBotProfile({ id: `${id}-b${i}`, difficulty: 5, rng, name: `Bot${i}` });
      seats.push({ seat: i, id: profile.id, name: profile.name, isHuman: false, avatar: i, stack: setup.stack ?? 1000, brain: new BotBrain(profile, new SeededRng(`${seed}-${i}`)) });
    }
  }
  return new TableController(
    {
      id,
      name: id,
      sessionId: 's',
      mode: 'cash',
      maxSeats: setup.maxSeats ?? 6,
      smallBlind: 5,
      bigBlind: 10,
      ante: 0,
      timing: { ...DEFAULT_TIMING, botSpeedScale: 0.05, animationScale: 0.02, handPauseMs: 100, ...setup.timing },
    },
    seats,
    clock,
    rng,
    setup.hooks ?? {},
  );
}

const heroTurn = (c: TableController) => c.getView().phase === 'hero_turn';
const heroStack = (c: TableController) => c.getView().seats[0]?.stack ?? 0;

describe('hand loop', () => {
  it('plays hands to completion with hero decisions, keeping the view consistent with the engine', () => {
    const clock = new FakeClock();
    const records: HandRecord[] = [];
    const table = makeTable(clock, 't1', { hooks: { onHandComplete: (r) => records.push(r) } });
    table.start();
    let guard = 0;
    while (records.length < 30) {
      if (++guard > 200000) throw new Error('Table stalled');
      clock.advance(50);
      const view = table.getView();
      expect(viewPotConsistent(view)).toBe(true);
      if (heroTurn(table)) {
        const legal = view.legal!;
        expect(table.heroAct(legal.canCheck ? { type: 'check' } : { type: 'call' })).toBe(true);
      }
      if (view.needsRebuy) {
        table.addChips(0, 1000);
        table.resumeAfterRebuy();
      }
      // Busted bots get topped up so the table keeps running.
      for (const seat of table.table.occupiedSeats) {
        const s = table.table.seats[seat]!;
        if (s.stack === 0 && !table.isHandInProgress && seat !== 0) table.addChips(seat, 1000);
      }
    }
    table.destroy();
    for (const r of records) {
      expect(r.players.reduce((sum, p) => sum + p.net, 0)).toBe(0);
    }
  });

  it('shows the same stacks in the view as the engine holds after every hand', () => {
    const clock = new FakeClock();
    let checked = 0;
    const table: TableController = makeTable(clock, 't2', {
      hooks: {
        onHandComplete: () => {
          for (const seat of table.table.occupiedSeats) {
            expect(table.getView().seats[seat]!.stack).toBe(table.table.seats[seat]!.stack);
          }
          checked++;
        },
      },
    });
    table.start();
    let guard = 0;
    while (checked < 15) {
      if (++guard > 200000) throw new Error('Table stalled');
      clock.advance(50);
      if (heroTurn(table)) table.heroAct({ type: 'fold' });
    }
    table.destroy();
  });

  it('never exposes opponent hole cards in the view before they are shown', () => {
    const clock = new FakeClock();
    const table = makeTable(clock, 't3');
    table.start();
    clock.runUntil(() => heroTurn(table));
    const view = table.getView();
    for (const s of view.seats) {
      if (!s) continue;
      if (s.isHuman) expect(s.cards.every((c) => c !== null)).toBe(true);
      else expect(s.cards).toEqual([null, null]);
    }
    table.destroy();
  });
});

describe('player actions', () => {
  it('rejects illegal actions and acting out of turn, changing nothing', () => {
    const clock = new FakeClock();
    const table = makeTable(clock, 't4');
    table.start();
    expect(table.heroAct({ type: 'fold' })).toBe(false); // not dealt yet
    clock.runUntil(() => heroTurn(table));
    const stack = heroStack(table);
    const legal = table.getView().legal!;
    if (!legal.canCheck) expect(table.heroAct({ type: 'check' })).toBe(false);
    if (legal.canRaise) expect(table.heroAct({ type: 'raise', to: legal.maxTo + 100 })).toBe(false);
    expect(heroTurn(table)).toBe(true);
    expect(heroStack(table)).toBe(stack);
    table.destroy();
  });

  it('applies a safe default when the timer runs out: check when free, fold otherwise', () => {
    const clock = new FakeClock();
    const table = makeTable(clock, 't5', { timing: { actionTimerSec: 5 } });
    table.start();
    clock.runUntil(() => heroTurn(table));
    const legal = table.getView().legal!;
    const hand = table.table.currentHand!;
    const me = hand.playerAt(0)!;
    const startBet = me.streetBet;
    clock.advance(5100);
    if (legal.canCheck) expect(me.folded).toBe(false);
    else expect(me.folded).toBe(true);
    expect(me.streetBet).toBe(startBet);
    table.destroy();
  });

  it('warns near expiry through a timer effect', () => {
    const clock = new FakeClock();
    const effects: string[] = [];
    const table = makeTable(clock, 't6', { timing: { actionTimerSec: 8 }, hooks: { onEffect: (e) => effects.push(e.kind) } });
    table.start();
    clock.runUntil(() => heroTurn(table));
    expect(effects).toContain('your_turn');
    expect(effects).not.toContain('timer_warning');
    clock.advance(3100);
    expect(effects).toContain('timer_warning');
    table.destroy();
  });
});

describe('time bank', () => {
  it('extends the clock, spends the bank and cannot be used after acting', () => {
    const clock = new FakeClock();
    const table = makeTable(clock, 't7', { timing: { actionTimerSec: 5, timeBankSec: 20 } });
    table.start();
    expect(table.useTimeBank()).toBe(false); // not the player's turn
    clock.runUntil(() => heroTurn(table));
    const before = table.getView().deadline!;
    expect(table.useTimeBank(15)).toBe(true);
    expect(table.getView().deadline).toBe(before + 15000);
    expect(table.getView().timeBank).toBe(5);
    expect(table.useTimeBank(15)).toBe(true); // only 5 seconds left in the bank
    expect(table.getView().timeBank).toBe(0);
    expect(table.useTimeBank(15)).toBe(false); // empty
    clock.advance(20000); // inside the extended clock the hero has not timed out
    expect(heroTurn(table)).toBe(true);
    const legal = table.getView().legal!;
    table.heroAct(legal.canCheck ? { type: 'check' } : { type: 'fold' });
    expect(table.useTimeBank(5)).toBe(false); // already committed
    table.destroy();
  });

  it('replenishes on the configured schedule without exceeding the maximum', () => {
    const clock = new FakeClock();
    const table = makeTable(clock, 't8', { timing: { actionTimerSec: 30, timeBankSec: 20, timeBankRefillHands: 2, timeBankRefillSec: 4 } });
    table.start();
    clock.runUntil(() => heroTurn(table));
    table.useTimeBank(10);
    expect(table.getView().timeBank).toBe(10);
    let guard = 0;
    while (table.getView().handNumber < 5) {
      if (++guard > 200000) throw new Error('Stalled');
      clock.advance(50);
      if (heroTurn(table)) table.heroAct({ type: 'fold' });
    }
    expect(table.getView().timeBank).toBeGreaterThan(10);
    expect(table.getView().timeBank).toBeLessThanOrEqual(20);
    table.destroy();
  });
});

describe('pre-actions at the table', () => {
  /** Waits until it is not hero's turn yet but the hand is running. */
  const dealtAndWaiting = (clock: FakeClock, table: TableController) => {
    clock.runUntil(() => table.isHandInProgress);
  };

  it('check/fold folds to a bet when one is live', () => {
    const clock = new FakeClock();
    const table = makeTable(clock, 'p1');
    table.start();
    dealtAndWaiting(clock, table);
    table.setPreAction('check_fold');
    const hand = table.table.currentHand!;
    expect(table.getView().preAction?.kind).toBe('check_fold');
    clock.runUntil(() => hand.playerAt(0)!.folded || hand.isComplete || hand.playerAt(0)!.hasActed);
    const me = hand.playerAt(0)!;
    // Either it was free and checked, or there was a bet and it folded. Never a call.
    expect(me.folded || me.streetBet <= 10).toBe(true);
    table.destroy();
  });

  it('keeps pre-actions per table: arming one table leaves the others alone', () => {
    const clock = new FakeClock();
    const a = makeTable(clock, 'pa');
    const b = makeTable(clock, 'pb');
    a.start();
    b.start();
    clock.runUntil(() => a.isHandInProgress && b.isHandInProgress);
    a.setPreAction('fold_any');
    expect(a.getView().preAction?.kind).toBe('fold_any');
    expect(b.getView().preAction).toBeNull();
    a.destroy();
    b.destroy();
  });

  it('clears a pre-action when the next hand begins', () => {
    const clock = new FakeClock();
    const table = makeTable(clock, 'p2');
    table.start();
    clock.runUntil(() => heroTurn(table));
    table.heroAct({ type: 'fold' });
    const firstHand = table.getView().handNumber;
    table.setPreAction('call_any'); // ignored: hero has folded
    expect(table.getView().preAction).toBeNull();
    clock.runUntil(() => table.getView().handNumber > firstHand && table.isHandInProgress);
    expect(table.getView().preAction).toBeNull();
    table.destroy();
  });

  it('ignores pre-actions for a player who is all-in or has folded', () => {
    const clock = new FakeClock();
    const table = makeTable(clock, 'p3');
    table.start();
    clock.runUntil(() => heroTurn(table));
    table.heroAct({ type: 'allin' });
    table.setPreAction('check');
    expect(table.getView().preAction).toBeNull();
    table.destroy();
  });
});

describe('table independence', () => {
  it('runs four tables at once without chips or cards crossing over', () => {
    const clock = new FakeClock();
    const handsPerTable = new Map<string, number>();
    const totals = new Map<string, number>();
    const setups: Array<[string, number, number]> = [['A', 2, 2], ['B', 6, 6], ['C', 9, 9], ['D', 4, 9]];
    const tables = setups.map(([id, players, maxSeats]) =>
      makeTable(clock, id, {
        players,
        maxSeats,
        hooks: {
          onHandComplete: (record) => {
            handsPerTable.set(id, (handsPerTable.get(id) ?? 0) + 1);
            expect(record.tableId).toBe(id);
            expect(record.players.every((p) => p.id.startsWith(id))).toBe(true);
          },
        },
      }),
    );
    for (const t of tables) {
      totals.set(t.config.id, t.table.totalChips);
      t.start();
    }
    let guard = 0;
    while (setups.some(([id]) => (handsPerTable.get(id) ?? 0) < 12)) {
      if (++guard > 400000) throw new Error('Stalled');
      clock.advance(40);
      for (const t of tables) {
        const view = t.getView();
        if (view.phase === 'hero_turn') {
          const legal = view.legal!;
          t.heroAct(legal.canCheck ? { type: 'check' } : legal.callAmount < 40 ? { type: 'call' } : { type: 'fold' });
        }
        if (!t.isHandInProgress) expect(t.table.totalChips).toBe(totals.get(t.config.id));
        const hand = t.table.currentHand;
        if (hand) {
          const inPlay = hand.players.reduce((sum, p) => sum + p.stack + p.streetBet, hand.pot);
          expect(inPlay).toBeLessThanOrEqual(totals.get(t.config.id)!);
        }
      }
    }
    for (const t of tables) t.destroy();
    expect(clock.pending).toBe(0);
  });

  it('handles several tables waiting on the player at the same moment', () => {
    const clock = new FakeClock();
    const a = makeTable(clock, 'X');
    const b = makeTable(clock, 'Y');
    a.start();
    b.start();
    clock.runUntil(() => heroTurn(a) && heroTurn(b));
    const deadlineB = b.getView().deadline;
    a.heroAct({ type: 'fold' });
    expect(heroTurn(b)).toBe(true);
    expect(b.getView().deadline).toBe(deadlineB);
    a.destroy();
    b.destroy();
  });
});

describe('cleanup and leaving', () => {
  it('stops every timer on destroy', () => {
    const clock = new FakeClock();
    const table = makeTable(clock, 'c1');
    table.start();
    clock.advance(500);
    table.destroy();
    expect(clock.pending).toBe(0);
    const listener = vi.fn();
    table.subscribe(listener);
    clock.advance(5000);
    expect(listener).not.toHaveBeenCalled();
  });

  it('finishes the current hand with no extra chips committed when the player stands up', () => {
    const clock = new FakeClock();
    let stopped = false;
    const table = makeTable(clock, 'c2', { hooks: { onStopped: () => (stopped = true) } });
    table.start();
    clock.runUntil(() => heroTurn(table));
    const hand = table.table.currentHand!;
    const me = hand.playerAt(0)!;
    const contributed = me.contributed;
    table.requestLeave();
    expect(me.contributed).toBe(contributed);
    clock.runUntil(() => stopped);
    expect(table.isRunning).toBe(false);
    expect(table.getView().phase).toBe('finished');
  });
});

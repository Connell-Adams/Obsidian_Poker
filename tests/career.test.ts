import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { levelFromXp } from '../src/career/achievements';
import { Career, DEFAULT_STARTING_BANKROLL, type LedgerEntry, validateProfile } from '../src/career/career';
import { parseCards } from '../src/engine/cards';
import { Deck } from '../src/engine/deck';
import { Hand } from '../src/engine/hand';
import { SeededRng } from '../src/engine/rng';
import { buildHandRecord } from '../src/history/record';
import { IndexedDbStore, MemoryStore } from '../src/persistence/db';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings, saveSettings } from '../src/persistence/settings';

let time = 1000;
const now = () => time++;

function finishedRecord(heroWins: boolean, id = 'h1') {
  const heroFirst = heroWins ? 'Ah Kd Ad Kc' : 'Kd Ah Kc Ad';
  const hand = new Hand({
    handNumber: 1,
    players: [
      { seat: 0, id: 'hero', name: 'Hero', stack: 1000 },
      { seat: 1, id: 'bot', name: 'Bot', stack: 1000 },
    ],
    buttonSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    deck: Deck.stacked(parseCards(`${heroFirst} 2c 3s 7d 9c 2d 5s 3h 8h`), new SeededRng(1)),
  });
  hand.act(1, { type: 'allin' });
  hand.act(0, { type: 'call' });
  return buildHandRecord(hand, { id, sessionId: 's', tableId: 't', tableName: 't', mode: 'cash', maxSeats: 2, heroId: 'hero', now: now() });
}

describe('bankroll ledger', () => {
  it('starts with a ledger entry equal to the starting bankroll', async () => {
    const store = new MemoryStore();
    const career = await Career.load(store, now);
    expect(career.bankroll).toBe(DEFAULT_STARTING_BANKROLL);
    const entries = await career.ledger();
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe(DEFAULT_STARTING_BANKROLL);
  });

  it('deducts buy-ins and credits cash-outs exactly', async () => {
    const career = await Career.load(new MemoryStore(), now);
    expect(career.apply('cash_buyin', -5000, 'buy:1', 'Table 1').ok).toBe(true);
    expect(career.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 5000);
    expect(career.apply('cash_cashout', 7300, 'out:1', 'Cash out').ok).toBe(true);
    expect(career.bankroll).toBe(DEFAULT_STARTING_BANKROLL + 2300);
    expect(career.profile.cashBuyIns).toBe(5000);
    expect(career.profile.cashWinnings).toBe(7300);
    expect(career.netProfit).toBe(2300);
  });

  it('refuses overdrafts, fractional chips and repeated references', async () => {
    const career = await Career.load(new MemoryStore(), now);
    expect(career.apply('cash_buyin', -DEFAULT_STARTING_BANKROLL - 1, 'over', 'x').ok).toBe(false);
    expect(career.bankroll).toBe(DEFAULT_STARTING_BANKROLL);
    expect(career.apply('cash_cashout', 10.5, 'frac', 'x').ok).toBe(false);
    expect(career.apply('tournament_prize', 500, 'prize:1', 'x').ok).toBe(true);
    expect(career.apply('tournament_prize', 500, 'prize:1', 'x').ok).toBe(false);
    expect(career.bankroll).toBe(DEFAULT_STARTING_BANKROLL + 500);
  });

  it('keeps the balance consistent with the ledger sum after many operations', async () => {
    const career = await Career.load(new MemoryStore(), now);
    const r = new SeededRng('ledger');
    for (let i = 0; i < 500; i++) {
      const amount = (r.next() < 0.5 ? -1 : 1) * r.int(800);
      career.apply(amount < 0 ? 'cash_buyin' : 'cash_cashout', amount, `op:${i}`, 'x');
    }
    await career.flush();
    const entries = await career.ledger();
    expect(entries.reduce((sum, e) => sum + e.amount, 0)).toBe(career.bankroll);
    expect(career.bankroll).toBeGreaterThanOrEqual(0);
  });

  it('only allows reloads when nearly broke and never counts them as profit', async () => {
    const career = await Career.load(new MemoryStore(), now, 5000);
    expect(career.reload().ok).toBe(false);
    career.apply('cash_buyin', -4500, 'b', 'x');
    expect(career.reload().ok).toBe(true);
    expect(career.profile.reloads).toBeGreaterThan(0);
    expect(career.netProfit).toBe(-4500);
  });
});

describe('persistence across restarts', () => {
  it('reloads exactly the same bankroll, after a refresh', async () => {
    const store = new MemoryStore();
    const a = await Career.load(store, now);
    a.apply('cash_buyin', -3000, 'b1', 'x');
    a.recordHand(finishedRecord(true));
    await a.flush();
    const b = await Career.load(store, now);
    expect(b.bankroll).toBe(a.bankroll);
    expect(b.profile.handsPlayed).toBe(1);
    expect(b.loadWarning).toBeNull();
    // References survive too, so a repeated prize after a refresh is still refused.
    expect(b.apply('cash_buyin', -1, 'b1', 'x').ok).toBe(false);
  });

  it('works against real IndexedDB semantics, including atomic commits', async () => {
    const factory = new IDBFactory();
    const store = await IndexedDbStore.open(factory);
    const a = await Career.load(store, now);
    a.apply('tournament_fee', -1000, 'fee:1', 'x');
    await a.flush();
    const reopened = await IndexedDbStore.open(factory);
    const b = await Career.load(reopened, now);
    expect(b.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 1000);
    expect((await b.ledger()).length).toBe(2);
    await reopened.commit([{ store: 'meta', key: 'x', value: 1 }, { store: 'meta', key: 'y', value: 2 }]);
    expect(await reopened.get('meta', 'y')).toBe(2);
    await reopened.commit([{ store: 'meta', key: 'y' }]);
    expect(await reopened.get('meta', 'y')).toBeUndefined();
  });

  it('corrects a tampered bankroll from the ledger', async () => {
    const store = new MemoryStore();
    const a = await Career.load(store, now);
    a.apply('cash_buyin', -3000, 'b1', 'x');
    await a.flush();
    const profile = await store.get<Record<string, unknown>>('meta', 'profile');
    await store.commit([{ store: 'meta', key: 'profile', value: { ...profile, bankroll: 999999999 } }]);
    const b = await Career.load(store, now);
    expect(b.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 3000);
    expect(b.loadWarning).toMatch(/corrected/);
  });

  it('survives a corrupted profile by rebuilding it, keeping chips from the ledger', async () => {
    const store = new MemoryStore();
    const a = await Career.load(store, now);
    a.apply('cash_buyin', -2000, 'b1', 'x');
    await a.flush();
    await store.commit([{ store: 'meta', key: 'profile', value: 'garbage' }]);
    const b = await Career.load(store, now);
    expect(b.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 2000);
    expect(b.loadWarning).toMatch(/rebuilt/);
  });

  it('ignores malformed ledger rows', async () => {
    const store = new MemoryStore();
    const a = await Career.load(store, now);
    await a.flush();
    await store.commit([{ store: 'ledger', key: 'zzz', value: { amount: 'lots', ref: 1 } as unknown as LedgerEntry }]);
    const b = await Career.load(store, now);
    expect(b.bankroll).toBe(DEFAULT_STARTING_BANKROLL);
  });

  it('migrates a profile saved by an older version, keeping its data and defaulting new fields', async () => {
    const store = new MemoryStore();
    const a = await Career.load(store, now);
    a.apply('cash_buyin', -1500, 'b1', 'x');
    a.recordHand(finishedRecord(true));
    await a.flush();
    const saved = (await store.get<Record<string, unknown>>('meta', 'profile'))!;
    // An older save had none of these fields.
    delete saved.longestWinStreak;
    delete saved.longestLoseStreak;
    delete saved.currentStreak;
    delete saved.bestTournamentPlace;
    await store.commit([{ store: 'meta', key: 'profile', value: saved }]);
    const b = await Career.load(store, now);
    expect(b.loadWarning).toBeNull();
    expect(b.bankroll).toBe(DEFAULT_STARTING_BANKROLL - 1500);
    expect(b.profile.handsPlayed).toBe(1);
    expect(b.profile.longestWinStreak).toBe(0);
    expect(b.profile.bestTournamentPlace).toBeNull();
  });

  it('rejects invalid profiles at validation', () => {
    expect(validateProfile(null)).toBeNull();
    expect(validateProfile({ bankroll: -5 })).toBeNull();
    expect(validateProfile({ bankroll: 1.5 })).toBeNull();
    expect(validateProfile({ counters: { hands: 'x' } })).toBeNull();
  });
});

describe('hand history cannot move chips', () => {
  it('recording hands never changes the bankroll', async () => {
    const career = await Career.load(new MemoryStore(), now);
    const before = career.bankroll;
    career.recordHand(finishedRecord(true, 'a'));
    career.recordHand(finishedRecord(false, 'b'));
    expect(career.bankroll).toBe(before);
    expect(career.profile.handsPlayed).toBe(2);
  });
});

describe('progression', () => {
  it('unlocks achievements from recorded play only', async () => {
    const seen: string[] = [];
    const career = await Career.load(new MemoryStore(), now);
    career.setEvents({ onAchievement: (a) => seen.push(a.id) });
    expect(career.profile.achievements.first_hand).toBeUndefined();
    career.recordHand(finishedRecord(true));
    expect(seen).toContain('first_hand');
    expect(career.profile.achievements.first_hand).toBeDefined();
    const again = seen.length;
    career.recordHand(finishedRecord(true, 'h2'));
    expect(seen.filter((id) => id === 'first_hand')).toHaveLength(1);
    expect(seen.length).toBeGreaterThanOrEqual(again);
  });

  it('records tournament trophies and wins', async () => {
    const career = await Career.load(new MemoryStore(), now);
    career.recordTournamentFinish({ id: 'T', ts: 1, name: 'Big One', place: 1, entrants: 45, prize: 5000 }, true);
    expect(career.profile.tournamentWins).toBe(1);
    expect(career.profile.trophies).toHaveLength(1);
    expect(career.profile.achievements.first_win).toBeDefined();
    career.recordTournamentFinish({ id: 'U', ts: 2, name: 'Small', place: 30, entrants: 45, prize: 0 }, false);
    expect(career.profile.tournamentsPlayed).toBe(2);
    expect(career.profile.trophies).toHaveLength(1);
    expect(career.profile.bestTournamentPlace).toBe(1);
  });

  it('computes levels monotonically', () => {
    let prev = 0;
    for (let xp = 0; xp < 20000; xp += 137) {
      const { level, xpIntoLevel, xpForNext } = levelFromXp(xp);
      expect(level).toBeGreaterThanOrEqual(prev);
      expect(xpIntoLevel).toBeLessThan(xpForNext);
      prev = level;
    }
  });
});

describe('settings', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it('round-trips through storage', () => {
    const s = memory();
    saveSettings({ ...DEFAULT_SETTINGS, tableTheme: 'crimson', masterVolume: 0.2 }, s);
    const loaded = loadSettings(s);
    expect(loaded.tableTheme).toBe('crimson');
    expect(loaded.masterVolume).toBe(0.2);
  });

  it('falls back to defaults for corrupted or out-of-range values', () => {
    const s = memory();
    s.setItem('obsidian-room.settings', '{not json');
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    const cleaned = sanitizeSettings({ masterVolume: 99, tableTheme: 'neon-pink', actionTimerSec: -4, playerName: '   ', hudStats: ['vpip', 'nope'], betPresets: [0.5, 100] });
    expect(cleaned.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
    expect(cleaned.tableTheme).toBe(DEFAULT_SETTINGS.tableTheme);
    expect(cleaned.actionTimerSec).toBe(DEFAULT_SETTINGS.actionTimerSec);
    expect(cleaned.playerName).toBe(DEFAULT_SETTINGS.playerName);
    expect(cleaned.hudStats).toEqual(['vpip']);
    expect(cleaned.betPresets).toEqual([0.5]);
  });

  it('keeps defaults for settings added by a newer version', () => {
    const old = sanitizeSettings({ version: 0, masterVolume: 0.5 });
    expect(old.masterVolume).toBe(0.5);
    expect(old.layout).toBe(DEFAULT_SETTINGS.layout);
  });
});

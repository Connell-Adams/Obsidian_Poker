import type { HandRecord } from '../history/record';
import type { DataStore, WriteOp } from '../persistence/db';
import { addCounters, emptyCounters, extractHandStats, isValidCounters, type StatCounters } from '../stats/counters';
import { ACHIEVEMENTS, type AchievementDef, levelFromXp } from './achievements';

export type LedgerKind =
  | 'start'
  | 'cash_buyin'
  | 'cash_topup'
  | 'cash_cashout'
  | 'tournament_fee'
  | 'tournament_prize'
  | 'tournament_refund'
  | 'recovery'
  | 'reload';

export interface LedgerEntry {
  id: string;
  ts: number;
  kind: LedgerKind;
  /** Signed integer chips. */
  amount: number;
  balanceAfter: number;
  /** Unique reference: a second entry with the same ref is refused, preventing double payment. */
  ref: string;
  note: string;
}

export interface Trophy {
  id: string;
  ts: number;
  name: string;
  place: number;
  entrants: number;
  prize: number;
}

export interface CareerProfile {
  schema: number;
  createdAt: number;
  startingBankroll: number;
  bankroll: number;
  reloads: number;
  cashBuyIns: number;
  cashWinnings: number;
  tournamentFees: number;
  tournamentPayouts: number;
  handsPlayed: number;
  cashHands: number;
  tournamentHands: number;
  tournamentsPlayed: number;
  tournamentWins: number;
  tournamentCashes: number;
  cashSessions: number;
  bestCashSession: number;
  worstCashSession: number;
  biggestPotWon: number;
  biggestPotLost: number;
  bestTournamentPlace: number | null;
  xp: number;
  achievements: Record<string, number>;
  trophies: Trophy[];
  counters: StatCounters;
  longestWinStreak: number;
  longestLoseStreak: number;
  currentStreak: number;
}

export const PROFILE_SCHEMA = 1;
export const DEFAULT_STARTING_BANKROLL = 25000;
export const RELOAD_AMOUNT = 10000;
export const MAX_STORED_HANDS = 20000;
const PROFILE_KEY = 'profile';

export function newProfile(now: number, startingBankroll = DEFAULT_STARTING_BANKROLL): CareerProfile {
  return {
    schema: PROFILE_SCHEMA,
    createdAt: now,
    startingBankroll,
    bankroll: startingBankroll,
    reloads: 0,
    cashBuyIns: 0,
    cashWinnings: 0,
    tournamentFees: 0,
    tournamentPayouts: 0,
    handsPlayed: 0,
    cashHands: 0,
    tournamentHands: 0,
    tournamentsPlayed: 0,
    tournamentWins: 0,
    tournamentCashes: 0,
    cashSessions: 0,
    bestCashSession: 0,
    worstCashSession: 0,
    biggestPotWon: 0,
    biggestPotLost: 0,
    bestTournamentPlace: null,
    xp: 0,
    achievements: {},
    trophies: [],
    counters: emptyCounters(),
    longestWinStreak: 0,
    longestLoseStreak: 0,
    currentStreak: 0,
  };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Validates data read from storage. Returns null rather than trusting a bad record. */
export function validateProfile(raw: unknown): CareerProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Partial<CareerProfile>;
  const template = newProfile(0);
  const merged = { ...template, ...p } as CareerProfile;
  const intFields: Array<keyof CareerProfile> = [
    'startingBankroll',
    'bankroll',
    'reloads',
    'cashBuyIns',
    'cashWinnings',
    'tournamentFees',
    'tournamentPayouts',
    'handsPlayed',
    'tournamentsPlayed',
    'tournamentWins',
  ];
  for (const key of intFields) if (!isInt(merged[key])) return null;
  if (merged.bankroll < 0) return null;
  if (!isValidCounters(merged.counters)) return null;
  if (typeof merged.achievements !== 'object' || merged.achievements === null) return null;
  if (!Array.isArray(merged.trophies)) return null;
  return merged;
}

export type ApplyResult = { ok: true; entry: LedgerEntry } | { ok: false; error: string };

export interface CareerEvents {
  onAchievement?(def: AchievementDef): void;
  onChange?(): void;
}

/**
 * The only code allowed to change the bankroll. Each change writes the ledger entry
 * and the updated profile in one atomic transaction. The ledger is the source of
 * truth: on load the bankroll must equal the sum of the entries, and it is rebuilt
 * from them if a stored profile disagrees. Hand history cannot touch chips.
 */
export class Career {
  profile: CareerProfile;
  private readonly store: DataStore;
  private readonly refs = new Set<string>();
  private readonly now: () => number;
  private entrySeq = 0;
  private events: CareerEvents = {};
  private writeChain: Promise<void> = Promise.resolve();
  /** Set when loading had to repair or reset data, so the UI can tell the player. */
  loadWarning: string | null = null;

  private constructor(store: DataStore, profile: CareerProfile, now: () => number) {
    this.store = store;
    this.profile = profile;
    this.now = now;
  }

  static async load(store: DataStore, now: () => number = Date.now, startingBankroll = DEFAULT_STARTING_BANKROLL): Promise<Career> {
    const stored = await store.get<unknown>('meta', PROFILE_KEY);
    const entries = (await store.getAll<LedgerEntry>('ledger')).filter((e) => isInt(e?.amount) && typeof e?.ref === 'string');
    const ledgerSum = entries.reduce((sum, e) => sum + e.amount, 0);

    let profile = stored === undefined ? null : validateProfile(stored);
    const career = new Career(store, profile ?? newProfile(now(), startingBankroll), now);
    for (const e of entries) career.refs.add(e.ref);
    career.entrySeq = entries.length;

    if (entries.length === 0 && stored === undefined) {
      // First ever launch: the starting bankroll is itself a ledger entry.
      const created = career.profile;
      const entry = career.makeEntry('start', created.startingBankroll, 'start', 'Starting bankroll', created.startingBankroll);
      career.refs.add(entry.ref);
      await store.commit([
        { store: 'ledger', key: entry.id, value: entry },
        { store: 'meta', key: PROFILE_KEY, value: created },
      ]);
    } else if (!profile && stored !== undefined) {
      // The profile is unreadable. Chips survive through the ledger, other totals restart.
      const rebuilt = newProfile(now(), startingBankroll);
      rebuilt.bankroll = Math.max(0, ledgerSum);
      career.profile = rebuilt;
      career.loadWarning = 'Your career profile was damaged and has been rebuilt from the bankroll ledger. Lifetime statistics were reset.';
      await store.commit([{ store: 'meta', key: PROFILE_KEY, value: rebuilt }]);
    } else if (entries.length > 0 && career.profile.bankroll !== ledgerSum) {
      career.loadWarning = `Your saved bankroll (${career.profile.bankroll}) disagreed with the ledger (${ledgerSum}) and was corrected.`;
      career.profile.bankroll = Math.max(0, ledgerSum);
      await store.commit([{ store: 'meta', key: PROFILE_KEY, value: career.profile }]);
    }
    profile = career.profile;
    return career;
  }

  setEvents(events: CareerEvents): void {
    this.events = events;
  }

  get bankroll(): number {
    return this.profile.bankroll;
  }

  /** Lifetime profit excludes free reloads. */
  get netProfit(): number {
    return this.profile.bankroll - this.profile.startingBankroll - this.profile.reloads;
  }

  private makeEntry(kind: LedgerKind, amount: number, ref: string, note: string, balanceAfter: number): LedgerEntry {
    this.entrySeq++;
    return {
      id: `${this.now().toString().padStart(14, '0')}-${String(this.entrySeq).padStart(7, '0')}`,
      ts: this.now(),
      kind,
      amount,
      balanceAfter,
      ref,
      note,
    };
  }

  /** Writes are queued so they reach storage in order, each one atomic. */
  private enqueue(ops: WriteOp[]): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.store.commit(ops)).catch((error) => {
      console.error('Failed to save career data', error);
    });
    return this.writeChain;
  }

  /** Queues other writes behind the bankroll's, so they all reach storage in order. */
  queueWrite(ops: WriteOp[]): Promise<void> {
    return this.enqueue(ops);
  }

  /** Resolves when everything queued so far has reached storage. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  /**
   * Applies one bankroll change. Refuses non-integer amounts, repeated references
   * and anything that would take the balance below zero.
   */
  apply(kind: LedgerKind, amount: number, ref: string, note: string, extraOps: WriteOp[] = []): ApplyResult {
    if (!Number.isSafeInteger(amount)) return { ok: false, error: 'Chip amounts must be whole numbers' };
    if (this.refs.has(ref)) return { ok: false, error: `Already processed: ${ref}` };
    const balance = this.profile.bankroll + amount;
    if (balance < 0) return { ok: false, error: 'Not enough chips in your bankroll' };
    const entry = this.makeEntry(kind, amount, ref, note, balance);
    this.refs.add(ref);
    const p = this.profile;
    p.bankroll = balance;
    switch (kind) {
      case 'cash_buyin':
      case 'cash_topup':
        p.cashBuyIns += -amount;
        break;
      case 'cash_cashout':
      case 'recovery':
        p.cashWinnings += amount;
        break;
      case 'tournament_fee':
        p.tournamentFees += -amount;
        break;
      case 'tournament_prize':
        p.tournamentPayouts += amount;
        break;
      case 'tournament_refund':
        p.tournamentFees -= amount;
        break;
      case 'reload':
        p.reloads += amount;
        break;
      default:
    }
    this.enqueue([{ store: 'ledger', key: entry.id, value: entry }, { store: 'meta', key: PROFILE_KEY, value: p }, ...extraOps]);
    this.events.onChange?.();
    return { ok: true, entry };
  }

  hasRef(ref: string): boolean {
    return this.refs.has(ref);
  }

  async ledger(): Promise<LedgerEntry[]> {
    const entries = await this.store.getAll<LedgerEntry>('ledger');
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Free chips when the player can no longer afford to play. Tracked apart from profit. */
  reload(): ApplyResult {
    if (this.profile.bankroll >= RELOAD_AMOUNT / 10) return { ok: false, error: 'Reloads are only available when you are nearly out of chips' };
    return this.apply('reload', RELOAD_AMOUNT, `reload:${this.now()}:${this.entrySeq}`, 'Bankroll reload');
  }

  /** Records a completed hand for the player. Never changes the bankroll. */
  recordHand(record: HandRecord, extraOps: WriteOp[] = []): void {
    const hero = record.players.find((p) => p.isHuman);
    if (!hero) return;
    const delta = extractHandStats(record).get(hero.id);
    if (!delta) return;
    const p = this.profile;
    addCounters(p.counters, delta);
    p.handsPlayed++;
    if (record.mode === 'cash') p.cashHands++;
    else p.tournamentHands++;
    p.biggestPotWon = Math.max(p.biggestPotWon, hero.net > 0 ? record.totalPot : 0);
    p.biggestPotLost = Math.max(p.biggestPotLost, hero.net < 0 ? -hero.net : 0);
    p.xp += 1 + (hero.net > 0 ? 1 : 0);
    if (hero.net > 0) {
      p.currentStreak = p.currentStreak > 0 ? p.currentStreak + 1 : 1;
      p.longestWinStreak = Math.max(p.longestWinStreak, p.currentStreak);
    } else if (hero.net < 0) {
      p.currentStreak = p.currentStreak < 0 ? p.currentStreak - 1 : -1;
      p.longestLoseStreak = Math.max(p.longestLoseStreak, -p.currentStreak);
    }
    this.checkAchievements();
    this.enqueue([{ store: 'hands', key: record.id, value: record }, { store: 'meta', key: PROFILE_KEY, value: p }, ...extraOps]);
    this.events.onChange?.();
  }

  recordCashSessionClosed(net: number): void {
    const p = this.profile;
    p.cashSessions++;
    p.bestCashSession = Math.max(p.bestCashSession, net);
    p.worstCashSession = Math.min(p.worstCashSession, net);
    p.xp += Math.max(0, Math.floor(net / 100));
    this.checkAchievements();
    this.enqueue([{ store: 'meta', key: PROFILE_KEY, value: p }]);
    this.events.onChange?.();
  }

  recordTournamentFinish(trophy: Trophy, cashed: boolean): void {
    const p = this.profile;
    p.tournamentsPlayed++;
    if (cashed) p.tournamentCashes++;
    if (trophy.place === 1) p.tournamentWins++;
    p.bestTournamentPlace = p.bestTournamentPlace === null ? trophy.place : Math.min(p.bestTournamentPlace, trophy.place);
    if (cashed) p.trophies = [trophy, ...p.trophies].slice(0, 200);
    p.xp += 20 + (cashed ? 40 : 0) + (trophy.place === 1 ? 200 : 0);
    this.checkAchievements();
    this.enqueue([{ store: 'meta', key: PROFILE_KEY, value: p }]);
    this.events.onChange?.();
  }

  private checkAchievements(): void {
    const p = this.profile;
    for (const def of ACHIEVEMENTS) {
      if (p.achievements[def.id] === undefined && def.check(p)) {
        p.achievements[def.id] = this.now();
        p.xp += def.xp;
        this.events.onAchievement?.(def);
      }
    }
  }

  get level(): { level: number; xpIntoLevel: number; xpForNext: number } {
    return levelFromXp(this.profile.xp);
  }

  /** Wipes the entire career, starting over. Only ever called from an explicit confirmation. */
  async reset(startingBankroll = DEFAULT_STARTING_BANKROLL): Promise<void> {
    await this.flush();
    await this.store.clear();
    this.refs.clear();
    this.entrySeq = 0;
    this.profile = newProfile(this.now(), startingBankroll);
    const entry = this.makeEntry('start', startingBankroll, 'start', 'Starting bankroll', startingBankroll);
    this.refs.add(entry.ref);
    await this.store.commit([
      { store: 'ledger', key: entry.id, value: entry },
      { store: 'meta', key: PROFILE_KEY, value: this.profile },
    ]);
    this.events.onChange?.();
  }
}

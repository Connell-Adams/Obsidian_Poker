import { BotBrain } from '../ai/brain';
import type { EmotionalState } from '../ai/emotions';
import { type BotProfile, createBotProfile, NAMED_PROS } from '../ai/profiles';
import { AudioManager } from '../audio/audioManager';
import { Career, type LedgerKind, MAX_STORED_HANDS, RELOAD_AMOUNT } from '../career/career';
import { applyDrift, applyTournamentResult, initialPros, isValidPros, type ProRecord } from '../career/leaderboard';
import type { HandReview } from '../coach/analyzer';
import type { EquityQuery, EquityQueryResult } from '../coach/equityQuery';
import type { CoachRequest, CoachResponse } from '../coach/protocol';
import { buildRecommendation, type TrainingRecommendation } from '../coach/training';
import { computeAllInEquity } from '../coach/allIn';
import { reviewHand } from '../coach/analyzer';
import { runEquityQuery } from '../coach/equityQuery';
import { createRng, SeededRng } from '../engine/rng';
import type { HandRecord } from '../history/record';
import { type DataStore, openDataStore, type WriteOp } from '../persistence/db';
import { animationScale, loadSettings, saveSettings, type Settings } from '../persistence/settings';
import { type Clock, realClock } from '../session/clock';
import { DEFAULT_TIMING, type SeatPlayerSpec, type TableConfig, TableController, type TimingSettings } from '../session/tableController';
import { addCounters, emptyCounters, extractHandStats, isValidCounters, ObservedStats, type StatCounters } from '../stats/counters';
import { HERO_ID, TournamentDirector, type TournamentConfig, type TournamentSnapshot, type TournamentStatus } from '../tournament/director';

export type TableFormat = '2max' | '6max' | '9max' | 'random';

export interface CashConfig {
  smallBlind: number;
  bigBlind: number;
  /** Bankroll chips taken to each table. */
  buyIn: number;
  /** Chips each opponent starts with. */
  opponentStack: number;
  difficulty: number;
  tables: TableFormat[];
}

export interface SessionStats {
  hands: number;
  net: number;
  bbNet: number;
  biggestPot: number;
  bestWinStreak: number;
  worstLoseStreak: number;
  streak: number;
  startedAt: number;
  /** Cumulative net after each hand. */
  curve: number[];
  counters: StatCounters;
}

export interface ActiveTable {
  controller: TableController;
  format: TableFormat;
  /** Chips this table has taken from the bankroll. */
  invested: number;
  closed: boolean;
}

export interface SessionSummary {
  kind: 'cash' | 'tournament';
  title: string;
  net: number;
  hands: number;
  durationMs: number;
  biggestPot: number;
  detail: string;
}

export interface ActiveSession {
  kind: 'cash' | 'tournament';
  id: string;
  title: string;
  tables: ActiveTable[];
  stats: SessionStats;
  cash?: CashConfig;
  director?: TournamentDirector;
  /** After the hero busts, the rest of the event is simulated. */
  simulatingRest?: boolean;
}

interface SavedSeat {
  seat: number;
  id: string;
  name: string;
  isHuman: boolean;
  avatar: number;
  stack: number;
  profile?: BotProfile;
  mood?: EmotionalState;
}

interface SavedCashTable {
  config: TableConfig;
  format: TableFormat;
  invested: number;
  seats: SavedSeat[];
  buttonSeat: number;
  handCount: number;
  timeBank: number;
  observed: Array<[string, StatCounters]>;
}

export type OpenSession =
  | { kind: 'cash'; id: string; title: string; cash: CashConfig; stats: SessionStats; tables: SavedCashTable[]; savedAt: number }
  | { kind: 'tournament'; id: string; title: string; stats: SessionStats; snapshot: TournamentSnapshot; heroTimeBank: number; savedAt: number };

export interface PendingTournament {
  id: string;
  config: TournamentConfig;
  startsAt: number;
  timing: TimingSettings;
}

export interface Toast {
  id: number;
  kind: 'info' | 'achievement' | 'level' | 'coach' | 'warning';
  title: string;
  body?: string;
}

const OPEN_SESSION_KEY = 'openSession';
const PENDING_TOURNAMENT_KEY = 'pendingTournament';
const CURRENT_WINDOW_KEY = 'currentWindow';
const WINDOWS_KEY = 'windows';
const RECOMMENDATIONS_KEY = 'recommendations';
const PROS_KEY = 'pros';
const REVIEW_TOTALS_KEY = 'reviewTotals';
const WINDOW_HANDS = 25;

export const CASH_STAKES: ReadonlyArray<{ label: string; sb: number; bb: number }> = [
  { label: 'Micro', sb: 5, bb: 10 },
  { label: 'Low', sb: 10, bb: 20 },
  { label: 'Mid', sb: 25, bb: 50 },
  { label: 'High', sb: 50, bb: 100 },
  { label: 'Nosebleed', sb: 250, bb: 500 },
];

type ReviewTotals = { good: number; fine: number; close: number; questionable: number; mistake: number };
const emptyTotals = (): ReviewTotals => ({ good: 0, fine: 0, close: 0, questionable: 0, mistake: 0 });

function newStats(now: number): SessionStats {
  return { hands: 0, net: 0, bbNet: 0, biggestPot: 0, bestWinStreak: 0, worstLoseStreak: 0, streak: 0, startedAt: now, curve: [], counters: emptyCounters() };
}

/** Everything the interface talks to. Game loops live here, so they keep running across screens. */
export class GameService {
  readonly store: DataStore;
  readonly career: Career;
  readonly audio: AudioManager;
  settings: Settings;
  session: ActiveSession | null = null;
  pendingTournament: PendingTournament | null = null;
  /** A saved game found at launch, waiting for the player to resume or cash out. */
  openSession: OpenSession | null = null;
  lastSummary: SessionSummary | null = null;
  reentryPrompt: { fee: number; resolve: (accepted: boolean) => void } | null = null;
  toasts: Toast[] = [];
  windows: StatCounters[] = [];
  recommendations: TrainingRecommendation[] = [];
  pros: ProRecord[] = [];
  reviewTotals: ReviewTotals = emptyTotals();
  /** The most recent reviewed hands, newest first, for the coach panel. */
  recentReviews: Array<{ record: HandRecord; review: HandReview }> = [];

  private readonly reviews = new Map<string, HandReview>();
  private version = 0;
  private listeners = new Set<() => void>();
  private heroTurnQueue: string[] = [];
  private toastSeq = 1;
  private currentWindow = emptyCounters();
  private tableSeq = 1;
  private readonly seedRng = createRng();
  private worker: Worker | null = null;
  private workerFailed = false;
  private requestSeq = 1;
  private pendingRequests = new Map<number, { resolve: (r: CoachResponse) => void; reject: (e: Error) => void }>();
  private pendingStartTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly clock: Clock;

  private constructor(store: DataStore, career: Career, settings: Settings, clock: Clock) {
    this.clock = clock;
    this.store = store;
    this.career = career;
    this.settings = settings;
    this.audio = new AudioManager(settings);
    career.setEvents({
      onAchievement: (def) => this.pushToast({ kind: 'achievement', title: `Achievement: ${def.name}`, body: def.description }),
      onChange: () => this.bump(),
    });
  }

  static async create(options: { store?: DataStore; clock?: Clock } = {}): Promise<GameService> {
    const store = options.store ?? (await openDataStore());
    const career = await Career.load(store);
    const service = new GameService(store, career, loadSettings(), options.clock ?? realClock);
    await service.loadExtras();
    await service.trimStoredHands();
    if (career.loadWarning) service.pushToast({ kind: 'warning', title: 'Saved data was repaired', body: career.loadWarning });
    if (!store.durable) service.pushToast({ kind: 'warning', title: 'Progress will not be saved', body: 'This browser is blocking storage, so your career will reset when the page closes.' });
    return service;
  }

  private async loadExtras(): Promise<void> {
    const windows = await this.store.get<StatCounters[]>('meta', WINDOWS_KEY);
    if (Array.isArray(windows)) this.windows = windows;
    const recs = await this.store.get<TrainingRecommendation[]>('meta', RECOMMENDATIONS_KEY);
    if (Array.isArray(recs)) this.recommendations = recs;
    const pros = await this.store.get<unknown>('meta', PROS_KEY);
    this.pros = isValidPros(pros) ? pros : initialPros();
    const totals = await this.store.get<ReviewTotals>('meta', REVIEW_TOTALS_KEY);
    if (totals && typeof totals.good === 'number') this.reviewTotals = totals;
    const currentWindow = await this.store.get<unknown>('meta', CURRENT_WINDOW_KEY);
    if (isValidCounters(currentWindow)) this.currentWindow = currentWindow;
    // A tournament that never started when the page closed: give the entry back.
    const pending = await this.store.get<{ id: string; buyIn: number; name: string }>('meta', PENDING_TOURNAMENT_KEY);
    if (pending && typeof pending.id === 'string' && Number.isInteger(pending.buyIn)) {
      this.career.apply('tournament_refund', pending.buyIn, `trefund:${pending.id}`, `Refund: ${pending.name}`, [{ store: 'meta', key: PENDING_TOURNAMENT_KEY }]);
      this.pushToast({ kind: 'info', title: 'Entry refunded', body: `${pending.name} had not started when the page closed.` });
    }
    const open = await this.store.get<unknown>('meta', OPEN_SESSION_KEY);
    if (open !== undefined) {
      if (isValidOpenSession(open)) this.openSession = open;
      else {
        await this.store.commit([{ store: 'meta', key: OPEN_SESSION_KEY }]);
        this.pushToast({ kind: 'warning', title: 'A saved session could not be read', body: 'It looked damaged and was discarded rather than trusted.' });
      }
    }
  }

  /** Keeps storage bounded by dropping the oldest hands and their reviews. */
  private async trimStoredHands(): Promise<void> {
    if ((await this.store.count('hands')) <= MAX_STORED_HANDS) return;
    const hands = await this.store.getAll<HandRecord>('hands');
    hands.sort((a, b) => a.ts - b.ts);
    const excess = hands.slice(0, hands.length - MAX_STORED_HANDS);
    await this.store.commit(excess.flatMap((h): WriteOp[] => [{ store: 'hands', key: h.id }, { store: 'reviews', key: h.id }]));
  }

  // ------------------------------------------------------------ subscription

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  pushToast(toast: Omit<Toast, 'id'>): void {
    const id = this.toastSeq++;
    this.toasts = [...this.toasts.slice(-3), { ...toast, id }];
    this.bump();
    setTimeout(() => this.dismissToast(id), toast.kind === 'coach' ? 9000 : 6000);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.bump();
  }

  // ------------------------------------------------------------ settings

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.audio.setLevels(this.settings);
    const timing = this.timingFromSettings();
    for (const t of this.session?.tables ?? []) {
      t.controller.setTiming({ actionTimerSec: timing.actionTimerSec, animationScale: timing.animationScale, botSpeedScale: timing.botSpeedScale });
    }
    this.bump();
  }

  timingFromSettings(): TimingSettings {
    const s = this.settings;
    return {
      ...DEFAULT_TIMING,
      actionTimerSec: s.actionTimerSec,
      timeBankSec: s.timeBankSec,
      timeBankRefillSec: s.timeBankRefillSec,
      timeBankRefillHands: s.timeBankRefillHands,
      animationScale: animationScale(s.animationSpeed),
      botSpeedScale: s.botSpeed,
    };
  }

  // ------------------------------------------------------------ hero turn focus

  /** The table the player should deal with next: the one that has waited longest. */
  get focusedTableId(): string | null {
    return this.heroTurnQueue[0] ?? null;
  }

  get pendingTurnCount(): number {
    return this.heroTurnQueue.length;
  }

  private onHeroTurn(controller: TableController, active: boolean): void {
    const id = controller.config.id;
    this.heroTurnQueue = this.heroTurnQueue.filter((x) => x !== id);
    if (active) this.heroTurnQueue.push(id);
    this.bump();
  }

  // ------------------------------------------------------------ cash games

  /** Creates the seats for one table, with the hero always in seat 0. */
  private buildCashSeats(config: CashConfig, format: TableFormat, tableId: string): { maxSeats: number; seats: SeatPlayerSpec[] } {
    const rng = this.seedRng;
    let maxSeats = format === '2max' ? 2 : format === '6max' ? 6 : 9;
    let players = maxSeats;
    if (format === 'random') {
      players = 2 + rng.int(8);
      maxSeats = players <= 2 ? 2 : players <= 6 ? 6 : 9;
    }
    const seats: SeatPlayerSpec[] = [{ seat: 0, id: HERO_ID, name: this.settings.playerName, isHuman: true, avatar: this.settings.avatar, stack: config.buyIn }];
    const taken = new Set<string>([this.settings.playerName]);
    // With fewer players than seats, spread them around the table.
    const openSeats = Array.from({ length: maxSeats - 1 }, (_, i) => i + 1);
    for (let i = openSeats.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [openSeats[i], openSeats[j]] = [openSeats[j], openSeats[i]];
    }
    const chosen = openSeats.slice(0, players - 1).sort((a, b) => a - b);
    chosen.forEach((seat) => {
      const spec = this.newCashBot(config, tableId, taken);
      taken.add(spec.name);
      seats.push({ ...spec, seat });
    });
    return { maxSeats, seats };
  }

  private newCashBot(config: CashConfig, tableId: string, taken: ReadonlySet<string>): Omit<SeatPlayerSpec, 'seat'> {
    // Unique across refreshes too: the counter restarts when a saved session resumes.
    const id = `${tableId}-bot-${this.seedRng.int(1e9).toString(36)}-${this.tableSeq++}`;
    const profile = createBotProfile({ id, difficulty: config.difficulty, rng: this.seedRng, takenNames: taken });
    const preferred = profile.archetype === 'short_stack' ? profile.buyInBB * config.bigBlind : config.opponentStack;
    const stack = Math.max(config.bigBlind * 10, Math.round(preferred * (0.85 + this.seedRng.next() * 0.3)));
    return { id, name: profile.name, isHuman: false, avatar: profile.avatar, stack, brain: new BotBrain(profile, new SeededRng(`${id}-${this.seedRng.next()}`)) };
  }

  /** Starts a cash session. Every table's buy-in is charged up front or nothing happens. */
  startCash(config: CashConfig): { ok: true } | { ok: false; error: string } {
    if (this.session) return { ok: false, error: 'Finish your current session first' };
    if (config.tables.length < 1 || config.tables.length > 4) return { ok: false, error: 'Choose between one and four tables' };
    if (!Number.isInteger(config.buyIn) || config.buyIn < config.bigBlind * 2) return { ok: false, error: 'The buy-in must be at least 2 big blinds' };
    const total = config.buyIn * config.tables.length;
    if (total > this.career.bankroll) return { ok: false, error: `You need ${total.toLocaleString()} chips for that but have ${this.career.bankroll.toLocaleString()}` };

    const id = `s-${Date.now()}-${this.seedRng.int(1e6)}`;
    const session: ActiveSession = { kind: 'cash', id, title: `Cash ${config.smallBlind}/${config.bigBlind}`, tables: [], stats: newStats(Date.now()), cash: config };
    this.session = session;
    config.tables.forEach((format, i) => {
      const tableId = `${id}-t${i + 1}`;
      const { maxSeats, seats } = this.buildCashSeats(config, format, tableId);
      const controller = this.makeCashController(session, tableId, `Table ${i + 1}`, maxSeats, seats);
      session.tables.push({ controller, format, invested: config.buyIn, closed: false });
    });
    // Paying and recording the seats are one transaction: chips cannot vanish in between.
    const note = config.tables.length > 1 ? `Buy-in, ${config.tables.length} tables` : 'Buy-in';
    const paid = this.career.apply('cash_buyin', -total, `buyin:${id}`, note, this.openSessionOps());
    if (!paid.ok) {
      for (const t of session.tables) t.controller.destroy();
      this.session = null;
      return { ok: false, error: paid.error };
    }
    for (const t of session.tables) t.controller.start();
    this.bump();
    return { ok: true };
  }

  private makeCashController(session: ActiveSession, tableId: string, name: string, maxSeats: number, seats: readonly SeatPlayerSpec[], observed?: ObservedStats): TableController {
    const cash = session.cash!;
    const config: TableConfig = {
      id: tableId,
      name,
      sessionId: session.id,
      mode: 'cash',
      maxSeats,
      smallBlind: cash.smallBlind,
      bigBlind: cash.bigBlind,
      ante: 0,
      timing: this.timingFromSettings(),
    };
    return new TableController(
      config,
      seats,
      this.clock,
      createRng(),
      {
        onHandComplete: (record) => this.absorbHand(record),
        onEffect: (effect) => this.audio.play(effect),
        onHeroTurnChange: (c, active) => this.onHeroTurn(c, active),
        onStopped: (c) => this.onCashTableStopped(session, c),
        onSeatBusted: (seat, c) => this.onCashSeatBusted(session, seat, c),
        beforeNextHand: (c) => {
          this.manageCashBots(session, c);
          this.persistOpenSession();
          return true;
        },
      },
      observed,
    );
  }

  private onCashSeatBusted(session: ActiveSession, seat: number, c: TableController): void {
    if (c.getView().heroSeat === seat) return;
    const cash = session.cash!;
    const leaving = c.removePlayer(seat);
    c.addSystemChat(`${leaving.name} is out of chips and leaves the table.`);
    const taken = new Set(c.getView().seats.flatMap((s) => (s ? [s.name] : [])));
    const bot = this.newCashBot(cash, c.config.id, taken);
    c.seatPlayer({ ...bot, seat });
    c.addSystemChat(`${bot.name} sits down with ${bot.stack.toLocaleString()} chips.`);
  }

  /** Bots top up, and every so often a regular leaves and a new face arrives. */
  private manageCashBots(session: ActiveSession, c: TableController): void {
    const cash = session.cash!;
    const rng = this.seedRng;
    for (const seat of c.table.occupiedSeats) {
      if (seat === c.getView().heroSeat) continue;
      const s = c.table.seats[seat]!;
      const brain = c.brainOf(s.id);
      const short = brain?.profile.archetype === 'short_stack';
      if (!short && s.stack < cash.opponentStack * 0.4 && rng.next() < 0.45) {
        c.addChips(seat, Math.round(cash.opponentStack * 0.85) - s.stack);
      } else if (rng.next() < 0.004) {
        const leaving = c.removePlayer(seat);
        const taken = new Set(c.getView().seats.flatMap((v) => (v ? [v.name] : [])));
        const bot = this.newCashBot(cash, c.config.id, taken);
        c.seatPlayer({ ...bot, seat });
        c.addSystemChat(`${leaving.name} leaves. ${bot.name} takes the seat.`);
      }
    }
  }

  /** Spends bankroll chips on more chips at a table, between hands only. */
  rebuy(tableId: string, amount: number): { ok: true } | { ok: false; error: string } {
    const session = this.session;
    const table = session?.tables.find((t) => t.controller.config.id === tableId);
    if (!session || !table || session.kind !== 'cash') return { ok: false, error: 'No such table' };
    const c = table.controller;
    if (c.isHandInProgress) return { ok: false, error: 'You can only add chips between hands' };
    const heroSeat = c.getView().heroSeat;
    if (heroSeat === null) return { ok: false, error: 'You are not seated' };
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'Enter a whole number of chips' };
    if (amount > this.career.bankroll) return { ok: false, error: 'Not enough chips in your bankroll' };
    const ref = `topup:${session.id}:${tableId}:${table.invested}:${c.getView().handNumber}`;
    if (this.career.hasRef(ref)) return { ok: false, error: 'That top-up was already made' };
    // Update the table first so the snapshot written with the payment already holds the chips.
    table.invested += amount;
    c.addChips(heroSeat, amount);
    const result = this.career.apply('cash_topup', -amount, ref, 'Top-up', this.openSessionOps());
    if (!result.ok) throw new Error(`Top-up failed after validation: ${result.error}`);
    if (c.getView().phase === 'waiting') c.resumeAfterRebuy();
    this.bump();
    return { ok: true };
  }

  leaveTable(tableId: string): void {
    const table = this.session?.tables.find((t) => t.controller.config.id === tableId);
    if (!table || table.closed) return;
    // A busted player who was waiting to rebuy has nothing to finish.
    table.controller.requestLeave();
    this.bump();
  }

  private onCashTableStopped(session: ActiveSession, c: TableController): void {
    const table = session.tables.find((t) => t.controller === c);
    if (!table || table.closed) return;
    table.closed = true;
    const heroSeat = c.getView().heroSeat;
    const chips = heroSeat !== null ? (c.table.seats[heroSeat]?.stack ?? 0) : 0;
    // The credit and the removal of this table from the saved session are one transaction.
    if (chips > 0) this.career.apply('cash_cashout', chips, `cashout:${session.id}:${c.config.id}`, `Cash out, ${c.config.name}`, this.openSessionOps());
    else this.career.queueWrite(this.openSessionOps());
    this.heroTurnQueue = this.heroTurnQueue.filter((id) => id !== c.config.id);
    c.destroy();
    if (session.tables.every((t) => t.closed)) this.closeCashSession(session);
    this.bump();
  }

  private closeCashSession(session: ActiveSession): void {
    const invested = session.tables.reduce((sum, t) => sum + t.invested, 0);
    const chipsBack = session.stats.net + invested;
    const net = chipsBack - invested;
    this.career.recordCashSessionClosed(net);
    this.finishSession(session, {
      kind: 'cash',
      title: session.title,
      net,
      hands: session.stats.hands,
      durationMs: Date.now() - session.stats.startedAt,
      biggestPot: session.stats.biggestPot,
      detail: `${session.tables.length} table${session.tables.length > 1 ? 's' : ''}`,
    });
  }

  private finishSession(session: ActiveSession, summary: SessionSummary): void {
    this.lastSummary = summary;
    const ops: WriteOp[] = [
      { store: 'sessions', key: session.id, value: { ...summary, id: session.id, endedAt: Date.now(), curve: session.stats.curve.slice(-1000) } },
      { store: 'meta', key: OPEN_SESSION_KEY },
    ];
    this.pros = applyDrift(this.pros, session.id);
    ops.push({ store: 'meta', key: PROS_KEY, value: this.pros });
    void this.career.queueWrite(ops);
    this.session = null;
    this.heroTurnQueue = [];
    this.bump();
  }

  // ------------------------------------------------------------ tournaments

  /** Pays the entry and schedules the start. The fee is refunded if cancelled before it begins. */
  registerTournament(config: TournamentConfig, startDelaySec: number): { ok: true } | { ok: false; error: string } {
    if (this.session || this.pendingTournament) return { ok: false, error: 'Finish your current session first' };
    const id = `T${Date.now().toString(36)}${this.seedRng.int(1e4)}`;
    const paid = this.career.apply('tournament_fee', -config.buyIn, `tfee:${id}:1`, `Entry: ${config.name}`, [
      { store: 'meta', key: PENDING_TOURNAMENT_KEY, value: { id, buyIn: config.buyIn, name: config.name } },
    ]);
    if (!paid.ok) return { ok: false, error: paid.error };
    const timing = this.timingFromSettings();
    if (startDelaySec <= 0) {
      this.startTournament(id, config, timing);
      return { ok: true };
    }
    this.pendingTournament = { id, config, startsAt: Date.now() + startDelaySec * 1000, timing };
    this.pendingStartTimer = setTimeout(() => {
      const pending = this.pendingTournament;
      if (!pending) return;
      this.pendingTournament = null;
      this.startTournament(pending.id, pending.config, pending.timing);
    }, startDelaySec * 1000);
    this.bump();
    return { ok: true };
  }

  cancelPendingTournament(): void {
    const pending = this.pendingTournament;
    if (!pending) return;
    if (this.pendingStartTimer) clearTimeout(this.pendingStartTimer);
    this.pendingTournament = null;
    this.career.apply('tournament_refund', pending.config.buyIn, `trefund:${pending.id}`, `Refund: ${pending.config.name}`, [{ store: 'meta', key: PENDING_TOURNAMENT_KEY }]);
    this.bump();
  }

  private directorHooks(id: string, config: TournamentConfig, session: ActiveSession) {
    return {
      onElimination: (player: { name: string; isHuman: boolean }, place: number, prize: number) => {
        const tableId = session.tables[0]?.controller;
        const prizeText = prize > 0 ? ` and wins ${prize.toLocaleString()}` : '';
        if (!player.isHuman) tableId?.addSystemChat(`${player.name} finishes ${ordinal(place)}${prizeText}.`);
        this.bump();
      },
      onHeroFinished: (place: number, prize: number, entries: number) => this.onHeroFinished(session, id, config, place, prize, entries),
      onComplete: () => this.onTournamentComplete(session, config),
      onLevelUp: (level: { level: number; smallBlind: number; bigBlind: number; ante: number }) => {
        session.tables[0]?.controller.addSystemChat(`Level ${level.level}: blinds are now ${level.smallBlind}/${level.bigBlind}${level.ante ? `, ante ${level.ante}` : ''}.`);
      },
      onHeroMoved: (from: string, to: string) => {
        session.tables[0]?.controller.addSystemChat(`Table balance: you move from ${from} to ${to}.`);
        this.pushToast({ kind: 'info', title: 'Table move', body: `You moved from ${from} to ${to}.` });
      },
      askReentry: () => this.askHeroReentry(session, id, config),
      onUpdate: () => this.bump(),
    };
  }

  private startTournament(id: string, config: TournamentConfig, timing: TimingSettings, restored?: { snapshot: TournamentSnapshot; heroTimeBank: number; stats: SessionStats }): void {
    const session: ActiveSession = { kind: 'tournament', id, title: config.name, tables: [], stats: restored?.stats ?? newStats(Date.now()) };
    const hooks = this.directorHooks(id, config, session);
    const director = restored
      ? TournamentDirector.restore(restored.snapshot, { hooks })
      : new TournamentDirector(id, config, { seed: `${id}-${this.seedRng.next()}`, heroName: this.settings.playerName, heroAvatar: this.settings.avatar, hooks });
    session.director = director;
    this.session = session;

    const heroTable = director.heroTable;
    if (!heroTable) throw new Error('The hero has no table');
    const resolve = (pid: string) => {
      const p = director.players.get(pid);
      return { avatar: p?.avatar ?? 0, isHuman: p?.isHuman ?? false, brain: director.brains.get(pid) };
    };
    const seats: SeatPlayerSpec[] = heroTable.table.occupiedSeats.map((seat) => {
      const s = heroTable.table.seats[seat]!;
      const info = resolve(s.id);
      return { seat, id: s.id, name: s.name, stack: s.stack, isHuman: info.isHuman, avatar: info.avatar, brain: info.brain };
    });
    const controllerConfig: TableConfig = {
      id: `${id}-hero`,
      name: heroTable.name,
      sessionId: id,
      mode: 'tournament',
      tournamentId: id,
      maxSeats: config.seatsPerTable,
      smallBlind: heroTable.table.smallBlind,
      bigBlind: heroTable.table.bigBlind,
      ante: heroTable.table.ante,
      timing,
    };
    const controller = new TableController(
      controllerConfig,
      seats,
      this.clock,
      createRng(),
      {
        onHandComplete: (record) => this.absorbHand(record),
        onEffect: (effect) => this.audio.play(effect),
        onHeroTurnChange: (c, active) => this.onHeroTurn(c, active),
        tournamentPressure: () => director.pressure(),
        onStopped: () => {
          if (this.session === session) this.continueWithoutHero(session);
        },
        beforeNextHand: async (c) => {
          await director.completeRound();
          const hero = director.hero;
          if (!hero || hero.status !== 'active' || director.isComplete) return false;
          const table = director.heroTable;
          if (!table) return false;
          c.syncFromTable(table.table, table.name, resolve);
          if (director.tables.length === 1) c.setBanner('FINAL TABLE');
          else c.setBanner(null);
          this.persistOpenSession();
          return true;
        },
      },
      director.observed,
      heroTable.table,
    );
    if (restored) controller.getView().timeBank = restored.heroTimeBank;
    session.tables.push({ controller, format: config.seatsPerTable === 2 ? '2max' : config.seatsPerTable <= 6 ? '6max' : '9max', invested: 0, closed: false });
    // Now that it is running, the saved game takes over from the pending entry.
    void this.career.queueWrite([...this.openSessionOps(), { store: 'meta', key: PENDING_TOURNAMENT_KEY }]);
    controller.start();
    this.bump();
  }

  private askHeroReentry(session: ActiveSession, id: string, config: TournamentConfig): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.career.bankroll < config.buyIn) {
        resolve(false);
        return;
      }
      const timeout = setTimeout(() => settle(false), 30000);
      const settle = (accepted: boolean) => {
        clearTimeout(timeout);
        this.reentryPrompt = null;
        let ok = accepted;
        if (accepted) {
          const entries = session.director?.hero?.entries ?? 1;
          const paid = this.career.apply('tournament_fee', -config.buyIn, `tfee:${id}:${entries + 1}`, `Re-entry: ${config.name}`);
          ok = paid.ok;
          if (!paid.ok) this.pushToast({ kind: 'warning', title: 'Re-entry failed', body: paid.error });
        }
        this.bump();
        resolve(ok);
      };
      this.reentryPrompt = { fee: config.buyIn, resolve: settle };
      this.bump();
    });
  }

  private onHeroFinished(session: ActiveSession, id: string, config: TournamentConfig, place: number, prize: number, entries: number): void {
    const clearSaved: WriteOp[] = [{ store: 'meta', key: OPEN_SESSION_KEY }];
    if (prize > 0) this.career.apply('tournament_prize', prize, `tprize:${id}`, `${ordinal(place)} in ${config.name}`, clearSaved);
    else void this.career.queueWrite(clearSaved);
    const director = session.director!;
    const cost = config.buyIn * entries;
    this.career.recordTournamentFinish({ id, ts: Date.now(), name: config.name, place, entrants: director.totalEntries, prize }, prize > 0);
    this.audio.play({ kind: place === 1 ? 'victory' : 'elimination', tableId: id, chips: 0, bigBlind: 1 });
    this.lastSummary = {
      kind: 'tournament',
      title: config.name,
      net: prize - cost,
      hands: session.stats.hands,
      durationMs: Date.now() - session.stats.startedAt,
      biggestPot: session.stats.biggestPot,
      detail: `Finished ${ordinal(place)} of ${director.totalEntries}${prize > 0 ? `, won ${prize.toLocaleString()}` : ''}`,
    };
    this.bump();
  }

  /** Leaves the tournament. As in a real event, the seat stays dealt in and blinds away. */
  forfeitTournament(): void {
    const session = this.session;
    if (!session?.director) return;
    session.director.heroAbsent = true;
    session.tables[0]?.controller.requestLeave();
    this.bump();
  }

  /** The hero is out: finish the remaining field through the normal simulation, then close. */
  private continueWithoutHero(session: ActiveSession): void {
    for (const t of session.tables) {
      t.closed = true;
      t.controller.destroy();
    }
    this.heroTurnQueue = [];
    const director = session.director!;
    director.heroAbsent = true;
    if (director.isComplete) {
      this.closeTournamentSession(session);
      return;
    }
    session.simulatingRest = true;
    this.bump();
    void director.runToCompletion(() => this.bump()).catch((error) => {
      console.error('Tournament simulation failed', error);
      this.closeTournamentSession(session);
    });
  }

  private onTournamentComplete(session: ActiveSession, config: TournamentConfig): void {
    const director = session.director!;
    const proNames = new Set(NAMED_PROS.map((p) => p.name));
    const results = [...director.players.values()]
      .filter((p) => proNames.has(p.name))
      .map((p) => ({ name: p.name, prize: p.prize, cost: config.buyIn * p.entries, won: p.place === 1 }));
    this.pros = applyTournamentResult(this.pros, results);
    if (session.simulatingRest) setTimeout(() => this.closeTournamentSession(session), 0);
  }

  private closeTournamentSession(session: ActiveSession): void {
    if (this.session !== session) return;
    const director = session.director!;
    void this.store.commit([{ store: 'tournaments', key: session.id, value: { id: session.id, name: session.title, standings: director.standings().slice(0, 100), status: director.status(), ts: Date.now() } }]);
    const summary = this.lastSummary ?? {
      kind: 'tournament' as const,
      title: session.title,
      net: 0,
      hands: session.stats.hands,
      durationMs: Date.now() - session.stats.startedAt,
      biggestPot: session.stats.biggestPot,
      detail: 'Tournament complete',
    };
    this.lastTournamentResult = { status: director.status(), standings: director.standings() };
    this.finishSession(session, summary);
  }

  lastTournamentResult: { status: TournamentStatus; standings: ReturnType<TournamentDirector['standings']> } | null = null;

  // ------------------------------------------------------------ hand intake

  /** Decision quality from every stored coach review, for the career screen. */
  get decisionQuality(): number | null {
    const t = this.reviewTotals;
    const total = t.good + t.fine + t.close + t.questionable + t.mistake;
    return total >= 20 ? (t.good + t.fine + t.close * 0.5) / total : null;
  }

  private absorbHand(record: HandRecord): void {
    const session = this.session;
    if (!session) return;
    const heroPlayer = record.players.find((p) => p.isHuman);
    if (!heroPlayer) return;
    const delta = extractHandStats(record).get(heroPlayer.id);
    if (delta) {
      const s = session.stats;
      addCounters(s.counters, delta);
      addCounters(this.currentWindow, delta);
      s.hands++;
      s.net += heroPlayer.net;
      s.bbNet += heroPlayer.net / record.bb;
      s.biggestPot = Math.max(s.biggestPot, record.totalPot);
      s.curve.push(s.net);
      if (heroPlayer.net > 0) {
        s.streak = s.streak > 0 ? s.streak + 1 : 1;
        s.bestWinStreak = Math.max(s.bestWinStreak, s.streak);
      } else if (heroPlayer.net < 0) {
        s.streak = s.streak < 0 ? s.streak - 1 : -1;
        s.worstLoseStreak = Math.max(s.worstLoseStreak, -s.streak);
      }
    }
    const levelBefore = this.career.level.level;
    // One transaction: the hand, its effect on the stacks and the totals are saved together.
    // A refresh can therefore never keep a hand in the history while undoing its chips.
    this.career.recordHand(record, [...this.openSessionOps(), { store: 'meta', key: CURRENT_WINDOW_KEY, value: this.currentWindow }]);
    if (this.career.level.level > levelBefore) {
      this.pushToast({ kind: 'level', title: `Level ${this.career.level.level} reached` });
    }
    this.requestReview(record, heroPlayer.id);
    if (this.currentWindow.hands >= WINDOW_HANDS) this.closeWindow();
    this.bump();
  }

  /** Every 25 hands, the coach re-evaluates performance. */
  private closeWindow(): void {
    this.windows = [...this.windows, this.currentWindow].slice(-200);
    this.currentWindow = emptyCounters();
    const difficulty = this.session?.cash?.difficulty ?? this.session?.director?.config.difficulty ?? 5;
    const rec = buildRecommendation({
      career: this.career.profile.counters,
      windows: this.windows,
      currentDifficulty: difficulty,
      reviewed: this.reviewTotals,
      now: Date.now(),
    });
    this.recommendations = [rec, ...this.recommendations].slice(0, 40);
    void this.career.queueWrite([
      { store: 'meta', key: WINDOWS_KEY, value: this.windows },
      { store: 'meta', key: CURRENT_WINDOW_KEY, value: this.currentWindow },
      { store: 'meta', key: RECOMMENDATIONS_KEY, value: this.recommendations },
    ]);
    if (this.settings.coachAuto) this.pushToast({ kind: 'coach', title: 'Training recommendation', body: rec.message });
  }

  // ------------------------------------------------------------ coach

  private ensureWorker(): Worker | null {
    if (this.worker || this.workerFailed || typeof Worker === 'undefined') return this.worker;
    try {
      this.worker = new Worker(new URL('../coach/worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<CoachResponse>) => {
        const pending = this.pendingRequests.get(event.data.requestId);
        if (!pending) return;
        this.pendingRequests.delete(event.data.requestId);
        if (event.data.kind === 'error') pending.reject(new Error(event.data.error));
        else pending.resolve(event.data);
      };
      this.worker.onerror = (event) => {
        console.warn('Coach worker failed, falling back to the main thread', event.message);
        this.workerFailed = true;
        this.worker = null;
        for (const p of this.pendingRequests.values()) p.reject(new Error('Worker failed'));
        this.pendingRequests.clear();
      };
    } catch {
      this.workerFailed = true;
    }
    return this.worker;
  }

  private sendToWorker(request: CoachRequest): Promise<CoachResponse> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error('Worker unavailable'));
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.requestId, { resolve, reject });
      worker.postMessage(request);
    });
  }

  /** Reviews a finished hand off the main thread, keeping the tables responsive. */
  private requestReview(record: HandRecord, heroId: string): void {
    const counters: Array<[string, StatCounters]> = [];
    const session = this.session;
    const table = session?.tables.find((t) => t.controller.config.id === record.tableId) ?? session?.tables[0];
    const observed = session?.director?.observed ?? table?.controller.observed;
    if (observed) {
      for (const p of record.players) {
        const c = observed.get(p.id);
        if (c) counters.push([p.id, c]);
      }
    }
    const requestId = this.requestSeq++;
    this.sendToWorker({ kind: 'review', requestId, record, counters, iterations: 6000 })
      .then((response) => {
        if (response.kind === 'review') this.applyReview(record, heroId, response.review, response.allInEquity);
      })
      .catch(() => {
        // No worker: run a lighter analysis in small enough pieces to keep things smooth.
        const map = new Map(counters);
        const rng = new SeededRng(record.id);
        const review = reviewHand(record, { iterations: 1500, rng, countersOf: (id) => map.get(id) });
        this.applyReview(record, heroId, review, computeAllInEquity(record, rng, 3000));
      });
  }

  private applyReview(record: HandRecord, heroId: string, review: HandReview | null, allInEquity: HandRecord['allInEquity']): void {
    const ops: WriteOp[] = [];
    if (allInEquity) {
      record.allInEquity = allInEquity;
      ops.push({ store: 'hands', key: record.id, value: record });
      const hero = record.players.find((p) => p.id === heroId);
      const entry = hero && allInEquity.find((a) => a.seat === hero.seat);
      if (entry) {
        const c = this.career.profile.counters;
        c.allInShowdowns++;
        c.allInEquitySum += entry.equity;
        c.allInEvDiff += entry.evDiff / record.bb;
      }
    }
    if (review) {
      this.reviews.set(record.id, review);
      this.recentReviews = [{ record, review }, ...this.recentReviews].slice(0, 50);
      ops.push({ store: 'reviews', key: record.id, value: review });
      for (const d of review.decisions) this.reviewTotals[d.verdict]++;
      ops.push({ store: 'meta', key: REVIEW_TOTALS_KEY, value: this.reviewTotals });
      if (review.mistakes > 0 && this.settings.coachAuto) {
        const worst = [...review.decisions].sort((a, b) => b.evLossBB - a.evLossBB)[0];
        this.pushToast({ kind: 'coach', title: `Coach: ${record.tableName} hand #${record.handNumber}`, body: worst.text });
      }
    }
    if (ops.length) void this.store.commit(ops);
    this.bump();
  }

  async getReview(handId: string): Promise<HandReview | undefined> {
    return this.reviews.get(handId) ?? (await this.store.get<HandReview>('reviews', handId));
  }

  /** Runs an equity calculation in the worker when available. */
  async runEquity(query: EquityQuery): Promise<EquityQueryResult> {
    try {
      const response = await this.sendToWorker({ kind: 'equity', requestId: this.requestSeq++, query });
      if (response.kind === 'equity') return response.result;
    } catch (error) {
      // A readable validation error came from the worker: show it rather than recomputing.
      if (error instanceof Error && error.message !== 'Worker unavailable' && error.message !== 'Worker failed') throw error;
    }
    return runEquityQuery(query, createRng());
  }

  async loadHands(): Promise<HandRecord[]> {
    return this.store.getAll<HandRecord>('hands');
  }

  // ------------------------------------------------------------ refresh recovery

  private persistOpenSession(): void {
    const ops = this.openSessionOps();
    if (ops.length) void this.career.queueWrite(ops);
  }

  /** The write that records the session as it stands, to be committed with whatever changed it. */
  private openSessionOps(): WriteOp[] {
    const session = this.session;
    if (!session) return [];
    let value: OpenSession;
    if (session.kind === 'cash') {
      if (session.tables.every((t) => t.closed)) return [{ store: 'meta', key: OPEN_SESSION_KEY }];
      value = {
        kind: 'cash',
        id: session.id,
        title: session.title,
        cash: session.cash!,
        stats: session.stats,
        savedAt: Date.now(),
        tables: session.tables.filter((t) => !t.closed).map((t) => {
          const c = t.controller;
          return {
            config: c.config,
            format: t.format,
            invested: t.invested,
            buttonSeat: c.table.buttonSeat,
            handCount: c.table.handCount,
            timeBank: c.getView().timeBank,
            observed: [...c.observed.entries()],
            seats: c.snapshotSeats().map((s) => ({ ...s, profile: c.brainOf(s.id)?.profile, mood: c.brainOf(s.id)?.mood })),
          };
        }),
      };
    } else {
      if (!session.director || session.director.hero?.status !== 'active' || session.director.heroAbsent) return [];
      value = {
        kind: 'tournament',
        id: session.id,
        title: session.title,
        stats: session.stats,
        snapshot: session.director.snapshot(),
        heroTimeBank: session.tables[0]?.controller.getView().timeBank ?? 0,
        savedAt: Date.now(),
      };
    }
    return [{ store: 'meta', key: OPEN_SESSION_KEY, value }];
  }

  /** Picks up a saved session where the last completed hand left off. */
  resumeOpenSession(): void {
    const open = this.openSession;
    if (!open) return;
    this.openSession = null;
    if (open.kind === 'tournament') {
      this.startTournament(open.id, open.snapshot.config, this.timingFromSettings(), { snapshot: open.snapshot, heroTimeBank: open.heroTimeBank, stats: open.stats });
      return;
    }
    const session: ActiveSession = { kind: 'cash', id: open.id, title: open.title, tables: [], stats: open.stats, cash: open.cash };
    this.session = session;
    for (const saved of open.tables) {
      const observed = new ObservedStats();
      for (const [id, counters] of saved.observed) observed.set(id, counters);
      const seats: SeatPlayerSpec[] = saved.seats.map((s) => ({
        seat: s.seat,
        id: s.id,
        name: s.name,
        isHuman: s.isHuman,
        avatar: s.avatar,
        stack: s.stack,
        brain: s.profile ? new BotBrain(s.profile, new SeededRng(`${s.id}-${Date.now()}`), s.mood) : undefined,
      }));
      const controller = this.makeCashController(session, saved.config.id, saved.config.name, saved.config.maxSeats, seats, observed);
      controller.table.buttonSeat = saved.buttonSeat;
      controller.table.handCount = saved.handCount;
      controller.getView().timeBank = saved.timeBank;
      session.tables.push({ controller, format: saved.format, invested: saved.invested, closed: false });
    }
    this.persistOpenSession();
    for (const t of session.tables) t.controller.start();
    this.bump();
  }

  /** Settles a saved session at its last completed hand, once only. */
  abandonOpenSession(): void {
    const open = this.openSession;
    if (!open) return;
    this.openSession = null;
    if (open.kind === 'cash') {
      const chips = open.tables.reduce((sum, t) => sum + (t.seats.find((s) => s.isHuman)?.stack ?? 0), 0);
      if (chips > 0) this.career.apply('recovery' as LedgerKind, chips, `recovery:${open.id}`, 'Recovered chips from an interrupted session', [{ store: 'meta', key: OPEN_SESSION_KEY }]);
      const invested = open.tables.reduce((sum, t) => sum + t.invested, 0);
      this.career.recordCashSessionClosed(chips - invested);
      this.pushToast({ kind: 'info', title: 'Session settled', body: `${chips.toLocaleString()} chips returned to your bankroll.` });
    } else {
      const left = open.snapshot.players.filter((p) => p.status === 'active').length;
      this.career.recordTournamentFinish({ id: open.id, ts: Date.now(), name: open.snapshot.config.name, place: left, entrants: open.snapshot.totalEntries, prize: 0 }, false);
      this.pushToast({ kind: 'info', title: 'Tournament forfeited', body: 'Your entry stays in the prize pool.' });
    }
    void this.career.queueWrite([{ store: 'meta', key: OPEN_SESSION_KEY }]);
    this.bump();
  }

  // ------------------------------------------------------------ career actions

  reloadBankroll(): void {
    const result = this.career.reload();
    if (!result.ok) this.pushToast({ kind: 'warning', title: 'Reload not available', body: result.error });
    else this.pushToast({ kind: 'info', title: 'Bankroll reloaded', body: `${RELOAD_AMOUNT.toLocaleString()} free chips added. They do not count as profit.` });
    this.bump();
  }

  async resetCareer(): Promise<void> {
    if (this.session) throw new Error('Finish your current session first');
    await this.career.reset();
    this.windows = [];
    this.recommendations = [];
    this.recentReviews = [];
    this.reviews.clear();
    this.reviewTotals = emptyTotals();
    this.pros = initialPros();
    this.lastSummary = null;
    this.currentWindow = emptyCounters();
    this.bump();
  }
}

/** Saved games come from storage, so they are checked before they can touch the bankroll. */
export function isValidOpenSession(value: unknown): value is OpenSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<OpenSession>;
  const chipsOk = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
  if (typeof v.id !== 'string' || typeof v.title !== 'string' || typeof v.stats !== 'object' || v.stats === null) return false;
  if (v.kind === 'cash') {
    const tables = (v as { tables?: unknown }).tables;
    if (!Array.isArray(tables) || tables.length === 0) return false;
    return tables.every((t: Partial<SavedCashTable>) => chipsOk(t?.invested) && typeof t?.config === 'object' && Array.isArray(t?.seats) && t.seats.every((s) => chipsOk(s?.stack) && Number.isInteger(s?.seat)));
  }
  if (v.kind === 'tournament') {
    const snapshot = (v as { snapshot?: Partial<TournamentSnapshot> }).snapshot;
    return !!snapshot && typeof snapshot.config === 'object' && Array.isArray(snapshot.players) && Array.isArray(snapshot.tables) && chipsOk(snapshot.totalEntries);
  }
  return false;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  return `${n}${rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th'}`;
}

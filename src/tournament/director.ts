import { BotBrain } from '../ai/brain';
import type { EmotionalState } from '../ai/emotions';
import { type BotProfile, createBotProfile, NAMED_PROS } from '../ai/profiles';
import { buildPublicView, type TournamentPressure } from '../ai/view';
import { type Rng, SeededRng } from '../engine/rng';
import { PokerTable, type SeatedPlayer } from '../engine/table';
import { buildHandRecord, type HandRecord } from '../history/record';
import { ObservedStats, type StatCounters } from '../stats/counters';
import { type BalanceTable, planBalance } from './balancer';
import { type BlindLevel, blindLevelFor, computePayouts, paidPlaces, type PayoutStructure } from './schedule';

export type LevelMode = 'hands' | 'minutes';

export interface TournamentConfig {
  name: string;
  /** Bankroll chips per entry. */
  buyIn: number;
  entrants: number;
  seatsPerTable: number;
  startingStack: number;
  startingSmallBlind: number;
  startingBigBlind: number;
  levelMode: LevelMode;
  /** Hands or minutes per level. */
  levelLength: number;
  blindIncreasePct: number;
  anteFromLevel: number;
  payout: PayoutStructure;
  /** Extra entries allowed per player, 0 for a freezeout. */
  reentries: number;
  /** Re-entry closes after this level. */
  reentryUntilLevel: number;
  difficulty: number;
}

export interface TPlayer {
  id: string;
  name: string;
  isHuman: boolean;
  avatar: number;
  profile: BotProfile | null;
  mood?: EmotionalState;
  status: 'active' | 'out';
  /** 1 is the winner. Set when finally eliminated. */
  place: number | null;
  prize: number;
  entries: number;
  tableId: string | null;
}

export interface StandingRow {
  id: string;
  name: string;
  isHuman: boolean;
  chips: number;
  status: 'active' | 'out';
  place: number | null;
  prize: number;
  tableName: string | null;
}

export interface TournamentStatus {
  name: string;
  playersLeft: number;
  totalEntries: number;
  tableCount: number;
  level: BlindLevel;
  nextLevel: BlindLevel;
  levelMode: LevelMode;
  handsLeftInLevel: number | null;
  msLeftInLevel: number | null;
  averageStack: number;
  prizePool: number;
  payouts: number[];
  paidPlaces: number;
  isFinalTable: boolean;
  isBubble: boolean;
  isComplete: boolean;
  heroPlace: number | null;
  heroPrize: number;
  championName: string | null;
  handsPlayed: number;
}

export interface ManagedTable {
  id: string;
  name: string;
  table: PokerTable;
}

export interface DirectorHooks {
  /** A finished hand from any table in the tournament. */
  onRecord?(record: HandRecord): void;
  onElimination?(player: TPlayer, place: number, prize: number): void;
  /** The hero is out for good. Pay the prize here. */
  onHeroFinished?(place: number, prize: number, entries: number): void;
  onComplete?(championId: string): void;
  onLevelUp?(level: BlindLevel): void;
  onHeroMoved?(fromName: string, toName: string): void;
  /** The hero's physical table contents changed. */
  onHeroTableChanged?(): void;
  /** Ask whether the hero wants to re-enter. The fee is charged inside this callback. */
  askReentry?(): Promise<boolean>;
  onUpdate?(): void;
}

const HERO_ID = 'hero';

/**
 * Runs a whole multi-table tournament. Every table plays through the real engine and
 * real AI. Hands are synchronised: each time the hero's table finishes a hand, every
 * other table plays one, then eliminations, level changes and balancing happen between
 * hands, so chips and seats are always consistent.
 */
export class TournamentDirector {
  readonly id: string;
  readonly config: TournamentConfig;
  readonly observed: ObservedStats;
  readonly players = new Map<string, TPlayer>();
  readonly brains = new Map<string, BotBrain>();
  tables: ManagedTable[] = [];

  level = 1;
  handsInLevel = 0;
  handsPlayed = 0;
  totalEntries = 0;
  isComplete = false;
  championId: string | null = null;
  startedAt: number;
  /** The hero has left: their seat keeps being dealt in and checks or folds until blinded out. */
  heroAbsent = false;
  private readonly rng: Rng;
  private readonly hooks: DirectorHooks;
  private readonly now: () => number;
  private readonly yieldFn: () => Promise<void>;
  private handSeq = 0;
  private levelStartedAt: number;
  private tableSeq = 0;

  constructor(
    id: string,
    config: TournamentConfig,
    options: { seed: string | number; heroName?: string; heroAvatar?: number; now?: () => number; yieldFn?: () => Promise<void>; hooks?: DirectorHooks; includeHero?: boolean },
  ) {
    this.id = id;
    this.config = config;
    this.rng = new SeededRng(options.seed);
    this.hooks = options.hooks ?? {};
    this.now = options.now ?? Date.now;
    this.yieldFn = options.yieldFn ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
    this.observed = new ObservedStats();
    this.startedAt = this.now();
    this.levelStartedAt = this.startedAt;
    if (!(options.includeHero === false)) this.addHero(options.heroName ?? 'You', options.heroAvatar ?? 0);
    this.addBots();
    this.seatEveryone();
    this.rememberStacks();
  }

  private addHero(name: string, avatar: number): void {
    this.players.set(HERO_ID, { id: HERO_ID, name, isHuman: true, avatar, profile: null, status: 'active', place: null, prize: 0, entries: 1, tableId: null });
    this.totalEntries++;
  }

  private addBots(): void {
    const taken = new Set<string>([...this.players.values()].map((p) => p.name));
    let pro = 0;
    const humans = this.players.size;
    for (let i = humans; i < this.config.entrants; i++) {
      const id = `t${this.id}-b${i}`;
      // A handful of the named professionals play in every event, spread through the field.
      const usePro = pro < NAMED_PROS.length && i % 7 === 3;
      const named = usePro ? NAMED_PROS[pro++] : null;
      const profile = createBotProfile({
        id,
        difficulty: this.config.difficulty,
        rng: this.rng,
        archetype: named?.archetype,
        name: named?.name,
        avatar: named?.avatar,
        takenNames: taken,
      });
      taken.add(profile.name);
      this.players.set(id, { id, name: profile.name, isHuman: false, avatar: profile.avatar, profile, status: 'active', place: null, prize: 0, entries: 1, tableId: null });
      this.brains.set(id, new BotBrain(profile, new SeededRng(`${this.id}-${id}`)));
      this.totalEntries++;
    }
  }

  private makeTable(): ManagedTable {
    const n = ++this.tableSeq;
    const blinds = this.currentBlinds;
    const table = new PokerTable({
      maxSeats: this.config.seatsPerTable,
      smallBlind: blinds.smallBlind,
      bigBlind: blinds.bigBlind,
      ante: blinds.ante,
      rng: new SeededRng(`${this.id}-table-${n}`),
    });
    return { id: `${this.id}-T${n}`, name: `Table ${n}`, table };
  }

  private seatEveryone(): void {
    const ids = [...this.players.keys()];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const seatsPerTable = this.config.seatsPerTable;
    const count = Math.max(1, Math.ceil(ids.length / seatsPerTable));
    for (let t = 0; t < count; t++) this.tables.push(this.makeTable());
    ids.forEach((id, index) => {
      const managed = this.tables[index % count];
      const seat = managed.table.firstEmptySeat();
      const p = this.players.get(id)!;
      managed.table.sit(seat, { id, name: p.name, stack: this.config.startingStack });
      p.tableId = managed.id;
    });
  }

  // ------------------------------------------------------------------- queries

  get currentBlinds(): BlindLevel {
    return blindLevelFor(this.config, this.level);
  }

  get activePlayers(): TPlayer[] {
    return [...this.players.values()].filter((p) => p.status === 'active');
  }

  get prizePool(): number {
    return this.config.buyIn * this.totalEntries;
  }

  get hero(): TPlayer | undefined {
    return this.players.get(HERO_ID);
  }

  get heroTable(): ManagedTable | undefined {
    const hero = this.hero;
    return hero?.tableId ? this.tables.find((t) => t.id === hero.tableId) : undefined;
  }

  stackOf(id: string): number {
    for (const t of this.tables) {
      const s = t.table.seats.find((x) => x?.id === id);
      if (s) return s.stack;
    }
    return 0;
  }

  get totalChipsInPlay(): number {
    return this.tables.reduce((sum, t) => sum + t.table.totalChips, 0);
  }

  status(): TournamentStatus {
    const left = this.activePlayers.length;
    const places = paidPlaces(this.totalEntries, this.config.payout);
    const blinds = this.currentBlinds;
    const hero = this.hero;
    const levelMs = this.config.levelLength * 60000;
    return {
      name: this.config.name,
      playersLeft: left,
      totalEntries: this.totalEntries,
      tableCount: this.tables.length,
      level: blinds,
      nextLevel: blindLevelFor(this.config, this.level + 1),
      levelMode: this.config.levelMode,
      handsLeftInLevel: this.config.levelMode === 'hands' ? Math.max(0, this.config.levelLength - this.handsInLevel) : null,
      msLeftInLevel: this.config.levelMode === 'minutes' ? Math.max(0, levelMs - (this.now() - this.levelStartedAt)) : null,
      averageStack: left > 0 ? Math.round(this.totalChipsInPlay / left) : 0,
      prizePool: this.prizePool,
      payouts: computePayouts(this.prizePool, this.totalEntries, this.config.payout),
      paidPlaces: places,
      isFinalTable: this.tables.length === 1 && !this.isComplete,
      isBubble: left === places + 1,
      isComplete: this.isComplete,
      heroPlace: hero?.place ?? null,
      heroPrize: hero?.prize ?? 0,
      championName: this.championId ? (this.players.get(this.championId)?.name ?? null) : null,
      handsPlayed: this.handsPlayed,
    };
  }

  standings(): StandingRow[] {
    const nameOf = new Map(this.tables.map((t) => [t.id, t.name]));
    return [...this.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        isHuman: p.isHuman,
        chips: p.status === 'active' ? this.stackOf(p.id) : 0,
        status: p.status,
        place: p.place,
        prize: p.prize,
        tableName: p.tableId ? (nameOf.get(p.tableId) ?? null) : null,
      }))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        if (a.status === 'active') return b.chips - a.chips;
        return (a.place ?? 0) - (b.place ?? 0);
      });
  }

  pressure(): TournamentPressure {
    const left = this.activePlayers.length;
    const places = paidPlaces(this.totalEntries, this.config.payout);
    const inMoney = left <= places;
    const isBubble = !inMoney && left <= Math.ceil(places * 1.12) + 1;
    const finalTable = this.tables.length === 1;
    let riskPremium = 0.03;
    if (isBubble) riskPremium = left === places + 1 ? 0.3 : 0.2;
    else if (finalTable) riskPremium = 0.14;
    else if (inMoney) riskPremium = 0.09;
    return {
      playersLeft: left,
      paidPlaces: places,
      averageStack: left > 0 ? this.totalChipsInPlay / left : 0,
      isBubble,
      inTheMoney: inMoney,
      finalTable,
      riskPremium,
      blindLevel: this.level,
    };
  }

  // ------------------------------------------------------------------- playing

  /** Plays one complete hand on a background table through the normal engine. */
  private playBackgroundHand(managed: ManagedTable): void {
    const { table } = managed;
    if (table.activeSeats.length < 2) return;
    const hand = table.startHand();
    const pressure = this.pressure();
    let guard = 0;
    while (!hand.isComplete) {
      if (++guard > 400) throw new Error('Runaway background hand');
      const seat = hand.actorSeat!;
      const player = hand.playerAt(seat)!;
      const brain = this.brains.get(player.id);
      const legal = hand.legalActions(seat)!;
      const decision = brain
        ? brain.decide(buildPublicView(hand, seat, pressure), (id) => this.observed.get(id), true).action
        : legal.canCheck
          ? ({ type: 'check' } as const)
          : ({ type: 'fold' } as const);
      const result = hand.act(seat, decision);
      if (!result.ok) throw new Error(`Illegal background action by ${player.name}: ${result.error}`);
    }
    const record = buildHandRecord(hand, {
      id: `${managed.id}-${hand.handNumber}-${++this.handSeq}`,
      sessionId: this.id,
      tableId: managed.id,
      tableName: managed.name,
      mode: 'tournament',
      tournamentId: this.id,
      level: this.level,
      maxSeats: this.config.seatsPerTable,
      heroId: null,
      now: this.now(),
    });
    table.settleHand();
    this.absorbRecord(record);
  }

  private absorbRecord(record: HandRecord): void {
    this.observed.addRecord(record);
    for (const p of record.players) {
      const brain = this.brains.get(p.id);
      brain?.observeHand({
        netBB: p.net / record.bb,
        stackFraction: p.net / Math.max(1, p.startStack),
        badBeat: record.badBeatSeats.includes(p.seat),
        wonShowdown: record.wentToShowdown && p.net > 0,
      });
    }
    this.hooks.onRecord?.(record);
  }

  /**
   * The step between hero hands: every other table plays a hand, then the field is
   * updated. Returns when all tables are ready for the next hand.
   */
  async completeRound(): Promise<void> {
    if (this.isComplete) return;
    const heroTableId = this.hero?.status === 'active' && !this.heroAbsent ? this.hero.tableId : null;
    for (const managed of this.tables) {
      if (managed.id === heroTableId) continue;
      this.playBackgroundHand(managed);
      await this.yieldFn();
    }
    this.handsPlayed++;
    await this.processEliminations();
    this.advanceLevel();
    this.rebalance();
    this.hooks.onUpdate?.();
  }

  private async processEliminations(): Promise<void> {
    const busted: Array<{ managed: ManagedTable; seat: number; player: TPlayer; startStack: number }> = [];
    for (const managed of this.tables) {
      for (const seat of managed.table.occupiedSeats) {
        const s = managed.table.seats[seat]!;
        if (s.stack !== 0) continue;
        const player = this.players.get(s.id)!;
        busted.push({ managed, seat, player, startStack: this.lastStartStack.get(s.id) ?? 0 });
      }
    }
    if (busted.length === 0) {
      this.rememberStacks();
      return;
    }

    // Everyone busting in the same round is ranked by who started the hand with more chips.
    busted.sort((a, b) => a.startStack - b.startStack);
    const stillOut: typeof busted = [];
    for (const b of busted) {
      const reentered = await this.tryReenter(b.player, b.managed, b.seat);
      if (!reentered) stillOut.push(b);
    }

    let place = this.activePlayers.length;
    const payouts = computePayouts(this.prizePool, this.totalEntries, this.config.payout);
    for (const b of stillOut) {
      const finishing = place--;
      const prize = finishing <= payouts.length ? payouts[finishing - 1] : 0;
      b.player.status = 'out';
      b.player.place = finishing;
      b.player.prize = prize;
      b.player.tableId = null;
      b.managed.table.seats[b.seat] = null;
      this.hooks.onElimination?.(b.player, finishing, prize);
      if (b.player.isHuman) this.hooks.onHeroFinished?.(finishing, prize, b.player.entries);
    }

    const active = this.activePlayers;
    if (active.length === 1) {
      const champion = active[0];
      champion.status = 'out';
      champion.place = 1;
      champion.prize = payouts[0];
      this.isComplete = true;
      this.championId = champion.id;
      if (champion.isHuman) this.hooks.onHeroFinished?.(1, payouts[0], champion.entries);
      this.hooks.onComplete?.(champion.id);
    }
    this.rememberStacks();
  }

  private lastStartStack = new Map<string, number>();

  /** Stacks at the start of the next hand, used to order simultaneous eliminations. */
  rememberStacks(): void {
    for (const t of this.tables) {
      for (const s of t.table.seats) if (s) this.lastStartStack.set(s.id, s.stack);
    }
  }

  private async tryReenter(player: TPlayer, managed: ManagedTable, seat: number): Promise<boolean> {
    const { reentries, reentryUntilLevel } = this.config;
    if (reentries <= 0 || this.level > reentryUntilLevel || player.entries > reentries) return false;
    let accepted: boolean;
    if (player.isHuman) {
      accepted = this.hooks.askReentry ? await this.hooks.askReentry() : false;
    } else {
      accepted = this.rng.next() < 0.35;
    }
    if (!accepted) return false;
    player.entries++;
    this.totalEntries++;
    const s = managed.table.seats[seat]!;
    s.stack = this.config.startingStack;
    this.brains.get(player.id)?.observeHand({ netBB: 0, stackFraction: 0, badBeat: false, wonShowdown: false });
    this.lastStartStack.set(player.id, s.stack);
    return true;
  }

  private advanceLevel(): void {
    const before = this.level;
    if (this.config.levelMode === 'hands') {
      this.handsInLevel++;
      while (this.handsInLevel >= this.config.levelLength) {
        this.handsInLevel -= this.config.levelLength;
        this.level++;
      }
    } else {
      const levelMs = this.config.levelLength * 60000;
      while (this.now() - this.levelStartedAt >= levelMs) {
        this.levelStartedAt += levelMs;
        this.level++;
      }
    }
    if (this.level !== before) {
      const blinds = this.currentBlinds;
      for (const t of this.tables) {
        t.table.smallBlind = blinds.smallBlind;
        t.table.bigBlind = blinds.bigBlind;
        t.table.ante = blinds.ante;
      }
      this.hooks.onLevelUp?.(blinds);
    }
  }

  private rebalance(): void {
    if (this.isComplete) return;
    // Remove tables that are completely empty.
    const emptied = this.tables.filter((t) => t.table.occupiedSeats.length === 0 && t.id !== this.hero?.tableId);
    if (emptied.length) this.tables = this.tables.filter((t) => !emptied.includes(t));

    const input: BalanceTable[] = this.tables.map((t) => ({
      id: t.id,
      maxSeats: t.table.maxSeats,
      buttonSeat: t.table.buttonSeat < 0 ? 0 : t.table.buttonSeat,
      seats: t.table.seats.map((s) => s?.id ?? null),
    }));
    const plan = planBalance(input, this.rng);
    if (plan.moves.length === 0 && plan.closedTables.length === 0) return;

    const byId = new Map(this.tables.map((t) => [t.id, t]));
    const heroFromName = this.heroTable?.name ?? null;
    let heroTarget: ManagedTable | null = null;

    for (const move of plan.moves) {
      const from = byId.get(move.fromTableId)!;
      const to = byId.get(move.toTableId)!;
      const seated: SeatedPlayer = from.table.seats[move.fromSeat]!;
      from.table.seats[move.fromSeat] = null;
      to.table.seats[move.toSeat] = seated;
      const p = this.players.get(move.playerId)!;
      p.tableId = to.id;
      if (p.isHuman) heroTarget = to;
    }

    const stayingHeroTable = this.heroTable;
    this.tables = this.tables.filter((t) => !plan.closedTables.includes(t.id));
    if (heroTarget && heroFromName && stayingHeroTable) this.hooks.onHeroMoved?.(heroFromName, heroTarget.name);
    this.hooks.onHeroTableChanged?.();
  }

  /** Plays out the rest of the event with no human, for when the hero is out. */
  async runToCompletion(onTick?: () => void, maxRounds = 100000): Promise<void> {
    let rounds = 0;
    while (!this.isComplete) {
      if (++rounds > maxRounds) throw new Error('Tournament failed to finish');
      await this.completeRound();
      onTick?.();
    }
  }

  // ------------------------------------------------------------------- snapshots

  snapshot(): TournamentSnapshot {
    return {
      kind: 'tournament',
      id: this.id,
      config: this.config,
      level: this.level,
      handsInLevel: this.handsInLevel,
      handsPlayed: this.handsPlayed,
      totalEntries: this.totalEntries,
      elapsedInLevelMs: this.now() - this.levelStartedAt,
      elapsedMs: this.now() - this.startedAt,
      tableSeq: this.tableSeq,
      players: [...this.players.values()].map((p) => ({ ...p, mood: this.brains.get(p.id)?.mood })),
      tables: this.tables.map((t) => ({
        id: t.id,
        name: t.name,
        buttonSeat: t.table.buttonSeat,
        handCount: t.table.handCount,
        seats: t.table.seats.map((s) => (s ? { id: s.id, name: s.name, stack: s.stack } : null)),
      })),
      observed: [...this.observed.entries()].filter(([id]) => this.players.get(id)?.status === 'active'),
    };
  }

  /** Rebuilds a director from a between-hands snapshot. Interrupted hands are simply not replayed. */
  static restore(snapshot: TournamentSnapshot, options: { hooks?: DirectorHooks; now?: () => number; yieldFn?: () => Promise<void> }): TournamentDirector {
    const director = Object.create(TournamentDirector.prototype) as TournamentDirector;
    const now = options.now ?? Date.now;
    const mutable = director as unknown as Record<string, unknown>;
    mutable.id = snapshot.id;
    mutable.config = snapshot.config;
    mutable.observed = new ObservedStats();
    mutable.players = new Map<string, TPlayer>();
    mutable.brains = new Map<string, BotBrain>();
    mutable.rng = new SeededRng(`${snapshot.id}-${now()}`);
    mutable.hooks = options.hooks ?? {};
    mutable.now = now;
    mutable.yieldFn = options.yieldFn ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
    mutable.handSeq = snapshot.handsPlayed * 100;
    mutable.tableSeq = snapshot.tableSeq;
    mutable.lastStartStack = new Map<string, number>();
    director.level = snapshot.level;
    director.handsInLevel = snapshot.handsInLevel;
    director.handsPlayed = snapshot.handsPlayed;
    director.totalEntries = snapshot.totalEntries;
    director.isComplete = false;
    director.championId = null;
    director.startedAt = now() - snapshot.elapsedMs;
    mutable.levelStartedAt = now() - snapshot.elapsedInLevelMs;
    director.tables = [];

    for (const p of snapshot.players) {
      director.players.set(p.id, p);
      if (p.profile && p.status === 'active') {
        director.brains.set(p.id, new BotBrain(p.profile, new SeededRng(`${snapshot.id}-${p.id}-${now()}`), p.mood));
      }
    }
    const blinds = director.currentBlinds;
    for (const t of snapshot.tables) {
      const table = new PokerTable({ maxSeats: snapshot.config.seatsPerTable, smallBlind: blinds.smallBlind, bigBlind: blinds.bigBlind, ante: blinds.ante, rng: new SeededRng(`${t.id}-${now()}`) });
      table.buttonSeat = t.buttonSeat;
      table.handCount = t.handCount;
      t.seats.forEach((s, i) => {
        if (s) table.sit(i, { id: s.id, name: s.name, stack: s.stack });
      });
      director.tables.push({ id: t.id, name: t.name, table });
    }
    for (const [id, counters] of snapshot.observed) director.observed.set(id, counters);
    director.rememberStacks();
    return director;
  }
}

export interface TournamentSnapshot {
  kind: 'tournament';
  id: string;
  config: TournamentConfig;
  level: number;
  handsInLevel: number;
  handsPlayed: number;
  totalEntries: number;
  elapsedInLevelMs: number;
  elapsedMs: number;
  tableSeq: number;
  players: TPlayer[];
  tables: Array<{ id: string; name: string; buttonSeat: number; handCount: number; seats: Array<{ id: string; name: string; stack: number } | null> }>;
  observed: Array<[string, StatCounters]>;
}

export { HERO_ID, type Rng };

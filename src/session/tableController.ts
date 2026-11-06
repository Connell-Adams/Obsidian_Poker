import { BotBrain } from '../ai/brain';
import type { ChatTrigger } from '../ai/chat';
import { buildPublicView, type TournamentPressure } from '../ai/view';
import { type Card, cardsToString } from '../engine/cards';
import type { Hand, HandEvent, PlayerAction } from '../engine/hand';
import type { Rng } from '../engine/rng';
import { PokerTable } from '../engine/table';
import { buildHandRecord, type GameMode, type HandRecord } from '../history/record';
import { ObservedStats } from '../stats/counters';
import type { Clock } from './clock';
import { type PreAction, type PreActionKind, resolvePreAction } from './preActions';
import {
  applyEvent,
  type ChatLine,
  emptySeatView,
  type InitialSeat,
  resetForHand,
  type SeatView,
  type TableView,
  type ViewContext,
} from './tableView';

export type EffectKind =
  | 'deal'
  | 'burn'
  | 'board'
  | 'check'
  | 'call'
  | 'bet'
  | 'raise'
  | 'fold'
  | 'allin'
  | 'collect'
  | 'award'
  | 'showdown'
  | 'your_turn'
  | 'timer_warning'
  | 'victory'
  | 'defeat'
  | 'elimination';

export interface TableEffect {
  kind: EffectKind;
  tableId: string;
  /** Chips involved, used to scale chip sounds with the apparent size of the pot. */
  chips: number;
  bigBlind: number;
}

export interface TimingSettings {
  /** Seconds the player gets to act. */
  actionTimerSec: number;
  /** Seconds of extra time per session or tournament. */
  timeBankSec: number;
  /** Seconds added to the time bank every `timeBankRefillHands` hands. */
  timeBankRefillSec: number;
  timeBankRefillHands: number;
  /** Multiplies presentation delays: 0 turns animations off. */
  animationScale: number;
  /** Multiplies bot thinking time. */
  botSpeedScale: number;
  /** Pause after a hand before dealing the next. */
  handPauseMs: number;
}

export const DEFAULT_TIMING: TimingSettings = {
  actionTimerSec: 20,
  timeBankSec: 60,
  timeBankRefillSec: 5,
  timeBankRefillHands: 10,
  animationScale: 1,
  botSpeedScale: 1,
  handPauseMs: 2600,
};

export interface TableConfig {
  id: string;
  name: string;
  sessionId: string;
  mode: GameMode;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  timing: TimingSettings;
  tournamentId?: string;
}

export interface SeatPlayerSpec {
  seat: number;
  id: string;
  name: string;
  isHuman: boolean;
  avatar: number;
  stack: number;
  brain?: BotBrain;
}

export interface TableHooks {
  /** Called once per completed hand, with the settled table, before anything else moves. */
  onHandComplete?(record: HandRecord, controller: TableController): void;
  /**
   * Awaited between hands. Tournaments use this to run other tables and move players.
   * Returning false stops the table.
   */
  beforeNextHand?(controller: TableController): Promise<boolean> | boolean;
  /** Cash tables replace busted bots or request a rebuy here. */
  onSeatBusted?(seat: number, controller: TableController): void;
  onEffect?(effect: TableEffect): void;
  /** Hero's turn started (true) or ended (false). */
  onHeroTurnChange?(controller: TableController, active: boolean): void;
  /** The table has stopped for good: the player stood up or the loop was told to end. */
  onStopped?(controller: TableController): void;
  tournamentPressure?(): TournamentPressure | undefined;
  /** A unique id for a hand record. */
  nextHandId?(): string;
}

const clampChat = (chat: ChatLine[]): ChatLine[] => (chat.length > 40 ? chat.slice(-40) : chat);

/** Minimum time between bot chat lines at one table, so chat stays occasional. */
const CHAT_COOLDOWN_MS = 12000;
/** A pre-action never fires instantly: this keeps the table readable. */
const PRE_ACTION_DELAY_MS = 350;

/**
 * Runs one table: the hand loop, pacing, bots, the player's clock and pre-actions.
 * The engine stays authoritative. The controller feeds engine events to the view
 * reducer with delays for animation, and nothing it renders can change a result.
 * Each controller owns its own PokerTable, RNG, timers and view: no state is shared.
 */
export class TableController {
  readonly config: TableConfig;
  table: PokerTable;
  readonly observed: ObservedStats;
  readonly heroId: string | null;
  private readonly clock: Clock;
  private hooks: TableHooks;
  private brains = new Map<string, BotBrain>();
  private meta = new Map<string, { avatar: number; isHuman: boolean }>();

  private view: TableView;
  private listeners = new Set<() => void>();

  private hand: Hand | null = null;
  private eventIndex = 0;
  private timers = new Set<number>();
  private clockTimer: number | null = null;
  private warnTimer: number | null = null;
  private running = false;
  private destroyed = false;
  private actionKey = 1;
  private chatKey = 1;
  private lastChatAt = -Infinity;
  private heroTurnActive = false;
  private leaveRequested = false;
  private handsSinceRefill = 0;
  private stopped = false;

  constructor(config: TableConfig, seats: readonly SeatPlayerSpec[], clock: Clock, rng: Rng, hooks: TableHooks = {}, observed?: ObservedStats, existingTable?: PokerTable) {
    this.config = config;
    this.clock = clock;
    this.hooks = hooks;
    this.observed = observed ?? new ObservedStats();
    this.table = existingTable ?? new PokerTable({ maxSeats: config.maxSeats, smallBlind: config.smallBlind, bigBlind: config.bigBlind, ante: config.ante, rng });
    let heroId: string | null = null;
    let heroSeat: number | null = null;
    const seatViews: Array<SeatView | null> = new Array(config.maxSeats).fill(null);
    for (const s of seats) {
      if (!existingTable) this.table.sit(s.seat, { id: s.id, name: s.name, stack: s.stack });
      this.meta.set(s.id, { avatar: s.avatar, isHuman: s.isHuman });
      if (s.brain) this.brains.set(s.id, s.brain);
      if (s.isHuman) {
        heroId = s.id;
        heroSeat = s.seat;
      }
      seatViews[s.seat] = emptySeatView(s as InitialSeat);
    }
    this.heroId = heroId;
    this.view = {
      tableId: config.id,
      tableName: config.name,
      maxSeats: config.maxSeats,
      heroSeat,
      handNumber: 0,
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      ante: config.ante,
      street: 'preflop',
      board: [],
      pot: 0,
      potTotal: 0,
      buttonSeat: null,
      sbSeat: null,
      bbSeat: null,
      seats: seatViews,
      actorSeat: null,
      phase: 'waiting',
      deadline: null,
      clockTotal: config.timing.actionTimerSec * 1000,
      legal: null,
      preAction: null,
      preActionNote: null,
      timeBank: config.timing.timeBankSec,
      timeBankActive: false,
      burnCount: 0,
      muckCount: 0,
      dealKey: 0,
      collectKey: 0,
      awardKey: 0,
      chat: [],
      banner: null,
      lastHandSummary: null,
      winners: [],
      isHeroInHand: false,
      leaveRequested: false,
      needsRebuy: false,
    };
  }

  // ---------------------------------------------------------------- subscription

  /** For useSyncExternalStore: each table notifies only its own subscribers. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): TableView => this.view;

  setHooks(hooks: TableHooks): void {
    this.hooks = hooks;
  }

  private setView(next: TableView): void {
    this.view = next;
    for (const l of this.listeners) l();
  }

  private effect(kind: EffectKind, chips = 0): void {
    this.hooks.onEffect?.({ kind, tableId: this.config.id, chips, bigBlind: this.table.bigBlind });
  }

  private later(fn: () => void, ms: number): number {
    const id = this.clock.setTimeout(() => {
      this.timers.delete(id);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private clearAllTimers(): void {
    for (const id of this.timers) this.clock.clearTimeout(id);
    this.timers.clear();
    this.clearHeroClock();
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running || this.destroyed) return;
    this.running = true;
    this.later(() => this.nextHand(), 300);
  }

  /** Stops every timer. Safe to call repeatedly. */
  destroy(): void {
    this.destroyed = true;
    this.running = false;
    this.clearAllTimers();
    this.listeners.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentHandNumber(): number {
    return this.view.handNumber;
  }

  get isHandInProgress(): boolean {
    return this.hand !== null && !this.hand.isComplete;
  }

  brainOf(id: string): BotBrain | undefined {
    return this.brains.get(id);
  }

  setTiming(timing: Partial<TimingSettings>): void {
    Object.assign(this.config.timing, timing);
  }

  setBlinds(smallBlind: number, bigBlind: number, ante: number): void {
    this.table.smallBlind = smallBlind;
    this.table.bigBlind = bigBlind;
    this.table.ante = ante;
    this.setView({ ...this.view, smallBlind, bigBlind, ante });
  }

  /**
   * Points this controller at a table's current seating. Tournaments call it between
   * hands, after balancing, whether the hero stayed or moved to another table.
   */
  syncFromTable(table: PokerTable, name: string, resolve: (id: string) => { avatar: number; isHuman: boolean; brain?: BotBrain }): void {
    if (this.isHandInProgress) throw new Error('Cannot change tables during a hand');
    const moved = table !== this.table;
    this.table = table;
    this.config.name = name;
    let heroSeat: number | null = null;
    const seats: Array<SeatView | null> = new Array(this.config.maxSeats).fill(null);
    table.seats.forEach((s, seat) => {
      if (!s) return;
      const info = resolve(s.id);
      this.meta.set(s.id, { avatar: info.avatar, isHuman: info.isHuman });
      if (info.brain) this.brains.set(s.id, info.brain);
      if (info.isHuman) heroSeat = seat;
      seats[seat] = emptySeatView({ seat, id: s.id, name: s.name, isHuman: info.isHuman, avatar: info.avatar, stack: s.stack });
    });
    this.setView({
      ...this.view,
      tableName: name,
      seats,
      heroSeat,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      ante: table.ante,
      board: moved ? [] : this.view.board,
      winners: moved ? [] : this.view.winners,
      buttonSeat: moved ? null : this.view.buttonSeat,
      sbSeat: moved ? null : this.view.sbSeat,
      bbSeat: moved ? null : this.view.bbSeat,
    });
  }

  /** Between-hands state for resuming after a refresh. Interrupted hands are not saved. */
  snapshotSeats(): Array<{ seat: number; id: string; name: string; isHuman: boolean; avatar: number; stack: number }> {
    return this.table.occupiedSeats.map((seat) => {
      const s = this.table.seats[seat]!;
      const meta = this.meta.get(s.id);
      return { seat, id: s.id, name: s.name, isHuman: meta?.isHuman ?? false, avatar: meta?.avatar ?? 0, stack: s.stack };
    });
  }

  /** Adds a player between hands: replacement bots and tournament moves use this. */
  seatPlayer(spec: SeatPlayerSpec): void {
    if (this.isHandInProgress) throw new Error('Cannot seat a player during a hand');
    this.table.sit(spec.seat, { id: spec.id, name: spec.name, stack: spec.stack });
    this.meta.set(spec.id, { avatar: spec.avatar, isHuman: spec.isHuman });
    if (spec.brain) this.brains.set(spec.id, spec.brain);
    const seats = [...this.view.seats];
    seats[spec.seat] = emptySeatView(spec as InitialSeat);
    const update: Partial<TableView> = { seats };
    if (spec.isHuman) update.heroSeat = spec.seat;
    this.setView({ ...this.view, ...update });
  }

  removePlayer(seat: number): { id: string; name: string; stack: number } {
    if (this.isHandInProgress) throw new Error('Cannot remove a player during a hand');
    const removed = this.table.leave(seat);
    const seats = [...this.view.seats];
    seats[seat] = null;
    const update: Partial<TableView> = { seats };
    if (this.view.heroSeat === seat) update.heroSeat = null;
    this.setView({ ...this.view, ...update });
    return removed;
  }

  /** Adds chips to the hero's stack between hands, after the bankroll has paid for them. */
  addChips(seat: number, chips: number): void {
    if (this.isHandInProgress) throw new Error('Cannot add chips during a hand');
    if (!Number.isInteger(chips) || chips <= 0) throw new Error('Invalid chip amount');
    const s = this.table.seats[seat];
    if (!s) throw new Error('Empty seat');
    s.stack += chips;
    const seats = this.view.seats.map((v) => (v && v.seat === seat ? { ...v, stack: s.stack, sittingOut: false } : v));
    this.setView({ ...this.view, seats, needsRebuy: false });
  }

  setBanner(banner: string | null): void {
    this.setView({ ...this.view, banner });
  }

  addSystemChat(text: string): void {
    this.pushChat(null, 'Dealer', text, 'system');
  }

  private pushChat(seat: number | null, name: string, text: string, kind: ChatLine['kind']): void {
    const line: ChatLine = { key: this.chatKey++, seat, name, text, kind };
    this.setView({ ...this.view, chat: clampChat([...this.view.chat, line]) });
  }

  private botChat(seat: number, trigger: ChatTrigger): void {
    const s = this.table.seats[seat];
    if (!s) return;
    const brain = this.brains.get(s.id);
    if (!brain) return;
    const now = this.clock.now();
    if (now - this.lastChatAt < CHAT_COOLDOWN_MS) return;
    const line = brain.say(trigger);
    if (line) {
      this.lastChatAt = now;
      this.pushChat(seat, s.name, line, 'chat');
    }
  }

  // ---------------------------------------------------------------- hand loop

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.clearAllTimers();
    this.setView({ ...this.view, phase: 'finished', actorSeat: null, deadline: null, legal: null });
    this.hooks.onStopped?.(this);
  }

  private nextHand(): void {
    if (!this.running) return;
    if (this.leaveRequested) {
      this.stop();
      return;
    }
    if (this.table.activeSeats.length < 2) {
      this.setView({ ...this.view, phase: 'waiting' });
      return;
    }
    const hand = this.table.startHand();
    this.hand = hand;
    this.eventIndex = 0;
    const heroHolds = this.heroId ? hand.players.some((p) => p.id === this.heroId) : false;
    const view = resetForHand(this.view, hand.handNumber);
    this.setView({
      ...view,
      phase: 'dealing',
      smallBlind: hand.smallBlind,
      bigBlind: hand.bigBlind,
      ante: hand.ante,
      preAction: null,
      preActionNote: null,
      isHeroInHand: heroHolds,
      needsRebuy: false,
    });
    this.handsSinceRefill++;
    const { timeBankRefillHands, timeBankRefillSec, timeBankSec } = this.config.timing;
    if (timeBankRefillHands > 0 && this.handsSinceRefill >= timeBankRefillHands) {
      this.handsSinceRefill = 0;
      this.setView({ ...this.view, timeBank: Math.min(timeBankSec, this.view.timeBank + timeBankRefillSec) });
    }
    this.pump();
  }

  private viewContext(): ViewContext {
    const hand = this.hand;
    return {
      ownCards: (seat, index) => {
        const p = hand?.playerAt(seat);
        return p && p.id === this.heroId ? p.hole[index] : null;
      },
      positionOf: (seat) => hand?.playerAt(seat)?.position ?? null,
      actionKey: this.actionKey++,
    };
  }

  /** How long each engine event stays on screen before the next one. */
  private presentationDelay(e: HandEvent): number {
    const scale = this.config.timing.animationScale;
    switch (e.t) {
      case 'hand_start':
        return 300 * scale;
      case 'post':
        return e.kind === 'ante' ? 40 * scale : 220 * scale;
      case 'deal_hole':
        return 85 * scale;
      case 'action':
        return 420 * scale;
      case 'uncalled':
        return 350 * scale;
      case 'collect':
        return 420 * scale;
      case 'burn':
        return 260 * scale;
      case 'board':
        return (e.street === 'flop' ? 850 : 650) * scale;
      case 'allin_reveal':
        return 900 * scale;
      case 'show':
        return 800 * scale;
      case 'muck':
        return 400 * scale;
      case 'award':
        return 900 * scale;
      case 'hand_end':
        return 0;
    }
  }

  private effectFor(e: HandEvent): void {
    switch (e.t) {
      case 'deal_hole':
        this.effect('deal');
        break;
      case 'post':
        if (e.kind !== 'ante') this.effect('bet', e.amount);
        break;
      case 'action':
        if (e.allIn && e.action !== 'fold') this.effect('allin', e.added);
        else if (e.action === 'fold') this.effect('fold');
        else this.effect(e.action, e.added);
        break;
      case 'collect':
        this.effect('collect', e.pot);
        break;
      case 'burn':
        this.effect('burn');
        break;
      case 'board':
        this.effect('board');
        break;
      case 'show':
        this.effect('showdown');
        break;
      case 'award':
        this.effect('award', e.amount);
        break;
      default:
    }
  }

  /** Feeds pending engine events to the view with pacing, then asks for the next action. */
  private pump(): void {
    const hand = this.hand;
    if (!hand || this.destroyed) return;
    while (this.eventIndex < hand.events.length) {
      const e = hand.events[this.eventIndex++];
      this.setView(applyEvent(this.view, e, this.viewContext()));
      this.effectFor(e);
      if (e.t === 'action' && e.allIn && e.action !== 'fold') this.botChat(e.seat, 'all_in');
      const delay = this.presentationDelay(e);
      if (delay >= 12) {
        this.later(() => this.pump(), delay);
        return;
      }
    }
    if (hand.isComplete) this.finishHand();
    else this.promptActor();
  }

  private promptActor(): void {
    const hand = this.hand!;
    const seat = hand.actorSeat!;
    const player = hand.playerAt(seat)!;
    if (player.id === this.heroId) this.promptHero(seat);
    else this.promptBot(seat);
  }

  private promptBot(seat: number): void {
    const hand = this.hand!;
    const player = hand.playerAt(seat)!;
    const brain = this.brains.get(player.id);
    const pressure = this.hooks.tournamentPressure?.();
    const view = buildPublicView(hand, seat, pressure);

    // A player with no brain (a disconnected hero placeholder) simply checks or folds.
    const decision = brain ? brain.decide(view, (id) => this.observed.get(id)) : null;
    const thinking = brain && decision ? brain.thinkTime(decision, view) : { ms: 900, kind: 'normal' as const };
    const ms = Math.max(120, thinking.ms * this.config.timing.botSpeedScale);
    const now = this.clock.now();
    this.setView({ ...this.view, actorSeat: seat, phase: 'bot_thinking', deadline: now + ms, clockTotal: ms, legal: null });

    if (thinking.kind === 'tank' && ms > 3000) {
      this.later(() => {
        if (this.hand === hand && hand.actorSeat === seat) this.botChat(seat, 'long_tank');
      }, ms * 0.6);
    }
    this.later(() => {
      if (this.hand !== hand || hand.actorSeat !== seat) return;
      const action = decision ? decision.action : this.safeDefault(seat);
      const result = hand.act(seat, action);
      if (!result.ok) {
        // Never freeze a table on a bad decision: fall back and report it loudly in development.
        console.error(`Bot ${player.name} attempted an illegal action`, action, result.error);
        hand.act(seat, this.safeDefault(seat));
      }
      this.pump();
    }, ms);
  }

  private safeDefault(seat: number): PlayerAction {
    const legal = this.hand!.legalActions(seat);
    return legal?.canCheck ? { type: 'check' } : { type: 'fold' };
  }

  private promptHero(seat: number): void {
    const hand = this.hand!;
    const legal = hand.legalActions(seat)!;

    // Leaving the table: never commit more chips while standing up.
    if (this.leaveRequested) {
      this.later(() => this.commitHero(legal.canCheck ? { type: 'check' } : { type: 'fold' }), 200);
      return;
    }

    const armed = this.view.preAction;
    if (armed) {
      const resolution = resolvePreAction(armed, legal, hand.handNumber);
      if (resolution.kind === 'execute') {
        this.setView({ ...this.view, actorSeat: seat, phase: 'presenting', preAction: null, preActionNote: null, legal: null });
        this.later(() => {
          if (this.hand === hand && hand.actorSeat === seat) this.commitHero(resolution.action);
        }, PRE_ACTION_DELAY_MS * Math.max(0.3, this.config.timing.animationScale));
        return;
      }
      if (resolution.kind === 'cancel') {
        this.setView({ ...this.view, preAction: null, preActionNote: resolution.reason });
      }
    }

    const total = this.config.timing.actionTimerSec * 1000;
    const deadline = this.clock.now() + total;
    this.setView({ ...this.view, actorSeat: seat, phase: 'hero_turn', deadline, clockTotal: total, legal, timeBankActive: false });
    this.heroTurnActive = true;
    this.hooks.onHeroTurnChange?.(this, true);
    this.effect('your_turn');
    this.armHeroClock(deadline);
  }

  private armHeroClock(deadline: number): void {
    this.clearHeroClock();
    const now = this.clock.now();
    const remaining = deadline - now;
    this.clockTimer = this.clock.setTimeout(() => this.onHeroTimeout(), remaining);
    const warnIn = remaining - 5000;
    if (warnIn > 0) this.warnTimer = this.clock.setTimeout(() => this.effect('timer_warning'), warnIn);
  }

  private clearHeroClock(): void {
    if (this.clockTimer !== null) this.clock.clearTimeout(this.clockTimer);
    if (this.warnTimer !== null) this.clock.clearTimeout(this.warnTimer);
    this.clockTimer = null;
    this.warnTimer = null;
  }

  private onHeroTimeout(): void {
    this.clockTimer = null;
    if (!this.heroTurnActive || !this.hand) return;
    const seat = this.hand.actorSeat;
    if (seat === null) return;
    this.pushChat(null, 'Dealer', 'Time expired: automatic check or fold.', 'system');
    this.commitHero(this.safeDefault(seat));
  }

  /** The only path by which a player's action reaches the engine at this table. */
  private commitHero(action: PlayerAction): boolean {
    const hand = this.hand;
    if (!hand || hand.isComplete) return false;
    const seat = hand.actorSeat;
    if (seat === null) return false;
    const player = hand.playerAt(seat)!;
    if (player.id !== this.heroId) return false;
    const result = hand.act(seat, action);
    if (!result.ok) {
      this.setView({ ...this.view, preActionNote: result.error });
      return false;
    }
    this.clearHeroClock();
    if (this.heroTurnActive) {
      this.heroTurnActive = false;
      this.hooks.onHeroTurnChange?.(this, false);
    }
    this.setView({ ...this.view, legal: null, deadline: null, phase: 'presenting', preActionNote: null, timeBankActive: false });
    this.pump();
    return true;
  }

  // ---------------------------------------------------------------- player API

  /** Applies a player decision. Returns false, changing nothing, if it is not their turn or illegal. */
  heroAct(action: PlayerAction): boolean {
    if (!this.heroTurnActive) return false;
    return this.commitHero(action);
  }

  /** Arms or clears a pre-action for this table only. */
  setPreAction(kind: PreActionKind | null, multiple?: number): void {
    const hand = this.hand;
    if (!hand || hand.isComplete || !this.heroId) return;
    const me = hand.players.find((p) => p.id === this.heroId);
    if (!me || me.folded || me.allIn) return;
    if (kind === null) {
      this.setView({ ...this.view, preAction: null, preActionNote: null });
      return;
    }
    const pre: PreAction = { kind, multiple, handNumber: hand.handNumber };
    this.setView({ ...this.view, preAction: pre, preActionNote: null });
  }

  /**
   * Spends time bank seconds on the current decision. Refused once the action has
   * been committed, when it is not the player's turn, or when the bank is empty.
   */
  useTimeBank(seconds = 15): boolean {
    if (!this.heroTurnActive || this.view.phase !== 'hero_turn' || this.view.deadline === null) return false;
    const spend = Math.min(seconds, Math.floor(this.view.timeBank));
    if (spend <= 0) return false;
    const deadline = this.view.deadline + spend * 1000;
    const remaining = deadline - this.clock.now();
    this.setView({ ...this.view, deadline, clockTotal: Math.max(this.view.clockTotal, remaining), timeBank: this.view.timeBank - spend, timeBankActive: true });
    this.armHeroClock(deadline);
    return true;
  }

  /** Stand up: the hand in progress is finished with check/fold, then the table stops. */
  requestLeave(): void {
    this.leaveRequested = true;
    if (this.heroTurnActive && this.hand) {
      const seat = this.hand.actorSeat;
      if (seat !== null) this.commitHero(this.safeDefault(seat));
    }
    this.setView({ ...this.view, leaveRequested: true, preAction: null });
    if (!this.hand) this.stop();
  }

  get isLeaving(): boolean {
    return this.leaveRequested;
  }

  // ---------------------------------------------------------------- end of hand

  private finishHand(): void {
    const hand = this.hand!;
    const heroPlayer = this.heroId ? hand.players.find((p) => p.id === this.heroId) : undefined;
    const record = buildHandRecord(hand, {
      id: this.hooks.nextHandId?.() ?? `${this.config.id}-${hand.handNumber}-${this.clock.now()}`,
      sessionId: this.config.sessionId,
      tableId: this.config.id,
      tableName: this.config.name,
      mode: this.config.mode,
      tournamentId: this.config.tournamentId,
      maxSeats: this.config.maxSeats,
      heroId: this.heroId,
      now: this.clock.now(),
    });

    this.table.settleHand();
    this.observed.addRecord(record);

    for (const p of record.players) {
      const brain = this.brains.get(p.id);
      if (brain) {
        brain.observeHand({
          netBB: p.net / record.bb,
          stackFraction: p.net / Math.max(1, p.startStack),
          badBeat: record.badBeatSeats.includes(p.seat),
          wonShowdown: record.wentToShowdown && p.net > 0,
        });
      }
    }
    this.chatAfterHand(record);

    if (heroPlayer) {
      const net = record.heroNet;
      if (net > record.bb * 15) this.effect('victory');
      else if (net < -record.bb * 25) this.effect('defeat');
    }

    const summary = this.summarize(record);
    this.setView({ ...this.view, phase: 'hand_over', lastHandSummary: summary, isHeroInHand: false, preAction: null });
    this.hooks.onHandComplete?.(record, this);

    const scale = Math.max(0.25, this.config.timing.animationScale);
    const pause = this.config.timing.handPauseMs * (record.wentToShowdown ? 1.2 : 0.75) * scale;
    this.later(() => this.afterHandPause(), pause);
  }

  private async afterHandPause(): Promise<void> {
    this.hand = null;
    if (this.destroyed) return;
    if (this.leaveRequested) {
      this.stop();
      return;
    }
    for (const seat of this.table.occupiedSeats) {
      if (this.table.seats[seat]!.stack === 0) this.hooks.onSeatBusted?.(seat, this);
    }
    if (this.hooks.beforeNextHand) {
      this.setView({ ...this.view, phase: 'waiting' });
      const carryOn = await this.hooks.beforeNextHand(this);
      if (this.destroyed) return;
      if (carryOn === false) {
        this.stop();
        return;
      }
    }
    const heroSeat = this.view.heroSeat;
    if (heroSeat !== null && this.table.seats[heroSeat]?.stack === 0) {
      // Wait for the player to rebuy or leave. `resumeAfterRebuy` restarts the loop.
      this.setView({ ...this.view, phase: 'waiting', needsRebuy: true });
      return;
    }
    this.nextHand();
  }

  /** Restarts the hand loop after a rebuy. */
  resumeAfterRebuy(): void {
    if (this.destroyed) return;
    this.setView({ ...this.view, needsRebuy: false });
    this.later(() => this.nextHand(), 200);
  }

  /** Restarts a table that was waiting for more players. */
  poke(): void {
    if (this.running && !this.hand && !this.destroyed) this.later(() => this.nextHand(), 200);
  }

  private chatAfterHand(record: HandRecord): void {
    const bb = record.bb;
    for (const seat of record.badBeatSeats) this.botChat(seat, 'bad_beat');
    const biggestWinner = [...record.players].sort((a, b) => b.net - a.net)[0];
    if (record.badBeatSeats.length > 0 && biggestWinner) this.botChat(biggestWinner.seat, 'gave_bad_beat');
    else if (biggestWinner && biggestWinner.net > bb * 25) this.botChat(biggestWinner.seat, 'big_win');
    const biggestLoser = [...record.players].sort((a, b) => a.net - b.net)[0];
    if (biggestLoser && biggestLoser.net < -bb * 30) this.botChat(biggestLoser.seat, 'big_loss');
  }

  private summarize(record: HandRecord): string {
    const parts: string[] = [];
    for (const pot of record.pots) {
      for (const w of pot.winners) {
        const p = record.players.find((x) => x.seat === w.seat);
        if (p) parts.push(`${p.isHuman ? 'You win' : `${p.name} wins`} ${w.amount.toLocaleString()}`);
      }
    }
    const board = record.board.length ? ` · ${cardsToString(record.board as Card[])}` : '';
    return parts.join(', ') + board;
  }
}

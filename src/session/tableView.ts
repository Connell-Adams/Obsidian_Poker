import type { Card } from '../engine/cards';
import type { ActionKind, HandEvent, LegalActions, Street } from '../engine/hand';
import type { PreAction } from './preActions';

export interface SeatView {
  seat: number;
  id: string;
  name: string;
  isHuman: boolean;
  avatar: number;
  stack: number;
  /** Chips in front of the player this round. */
  bet: number;
  folded: boolean;
  allIn: boolean;
  inHand: boolean;
  /** Cards this viewer may see: own cards and revealed hands. Null while face down. */
  cards: [Card | null, Card | null];
  /** How many hole cards have reached this seat so far. */
  dealt: number;
  showing: boolean;
  mucked: boolean;
  position: string | null;
  lastAction: { kind: ActionKind | 'post' | 'win'; amount: number; allIn: boolean; key: number } | null;
  handDescription: string | null;
  bestFive: Card[] | null;
  /** Chips just won, shown in the award animation. */
  won: number;
  sittingOut: boolean;
}

export interface ChatLine {
  key: number;
  seat: number | null;
  name: string;
  text: string;
  kind: 'chat' | 'system' | 'dealer';
}

export type TablePhase = 'waiting' | 'dealing' | 'bot_thinking' | 'hero_turn' | 'presenting' | 'hand_over' | 'finished' | 'paused';

export interface TableView {
  tableId: string;
  tableName: string;
  maxSeats: number;
  heroSeat: number | null;
  handNumber: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  street: Street;
  board: Card[];
  /** Chips already collected into the middle. */
  pot: number;
  /** Pot plus all bets on the table: what a pot-sized bet is based on. */
  potTotal: number;
  buttonSeat: number | null;
  sbSeat: number | null;
  bbSeat: number | null;
  seats: Array<SeatView | null>;
  actorSeat: number | null;
  phase: TablePhase;
  /** Absolute time the current actor's clock runs out. */
  deadline: number | null;
  /** Full length of the current clock, for the countdown ring. */
  clockTotal: number;
  legal: LegalActions | null;
  preAction: PreAction | null;
  /** Message from the last cancelled pre-action, shown near the controls. */
  preActionNote: string | null;
  timeBank: number;
  timeBankActive: boolean;
  burnCount: number;
  muckCount: number;
  /** Animation keys: a change re-triggers the matching CSS animation. */
  dealKey: number;
  collectKey: number;
  awardKey: number;
  chat: ChatLine[];
  banner: string | null;
  lastHandSummary: string | null;
  winners: Array<{ seat: number; amount: number; potIndex: number }>;
  /** Hero's stack changes after a hand. */
  isHeroInHand: boolean;
  leaveRequested: boolean;
  needsRebuy: boolean;
}

export interface InitialSeat {
  seat: number;
  id: string;
  name: string;
  isHuman: boolean;
  avatar: number;
  stack: number;
  sittingOut?: boolean;
}

export function emptySeatView(s: InitialSeat): SeatView {
  return {
    seat: s.seat,
    id: s.id,
    name: s.name,
    isHuman: s.isHuman,
    avatar: s.avatar,
    stack: s.stack,
    bet: 0,
    folded: false,
    allIn: false,
    inHand: false,
    cards: [null, null],
    dealt: 0,
    showing: false,
    mucked: false,
    position: null,
    lastAction: null,
    handDescription: null,
    bestFive: null,
    won: 0,
    sittingOut: s.sittingOut ?? false,
  };
}

/** Prepares a view for a new hand: seats keep their identity and stacks, everything else clears. */
export function resetForHand(view: TableView, handNumber: number): TableView {
  return {
    ...view,
    handNumber,
    street: 'preflop',
    board: [],
    pot: 0,
    potTotal: 0,
    actorSeat: null,
    deadline: null,
    legal: null,
    burnCount: 0,
    muckCount: 0,
    winners: [],
    lastHandSummary: null,
    seats: view.seats.map((s) =>
      s
        ? {
            ...s,
            bet: 0,
            folded: false,
            allIn: false,
            inHand: false,
            cards: [null, null],
            dealt: 0,
            showing: false,
            mucked: false,
            position: null,
            lastAction: null,
            handDescription: null,
            bestFive: null,
            won: 0,
          }
        : null,
    ),
  };
}

export interface ViewContext {
  /** Lets the reducer reveal only the viewer's own hole cards. */
  ownCards: (seat: number, index: 0 | 1) => Card | null;
  positionOf: (seat: number) => string | null;
  actionKey: number;
}

function mapSeat(view: TableView, seat: number, fn: (s: SeatView) => SeatView): TableView {
  return { ...view, seats: view.seats.map((s) => (s && s.seat === seat ? fn(s) : s)) };
}

const totalBets = (view: TableView): number => view.seats.reduce((sum, s) => sum + (s?.bet ?? 0), 0);

/**
 * Pure reducer from one engine event to the next visible table state. Live play
 * and hand replay both run through this, so what is animated always reflects
 * what the engine actually did. Burn cards only ever increment a counter.
 */
export function applyEvent(view: TableView, e: HandEvent, ctx: ViewContext): TableView {
  switch (e.t) {
    case 'hand_start':
      return {
        ...view,
        buttonSeat: e.buttonSeat,
        sbSeat: e.sbSeat,
        bbSeat: e.bbSeat,
        smallBlind: e.smallBlind,
        bigBlind: e.bigBlind,
        ante: e.ante,
        handNumber: e.handNumber,
      };
    case 'post': {
      if (e.kind === 'ante') {
        const next = mapSeat(view, e.seat, (s) => ({ ...s, stack: s.stack - e.amount, allIn: e.allIn, inHand: true, position: ctx.positionOf(s.seat) }));
        return { ...next, pot: next.pot + e.amount, potTotal: next.potTotal + e.amount };
      }
      const next = mapSeat(view, e.seat, (s) => ({
        ...s,
        stack: s.stack - e.amount,
        bet: s.bet + e.amount,
        allIn: e.allIn,
        inHand: true,
        position: ctx.positionOf(s.seat),
        lastAction: { kind: 'post', amount: e.amount, allIn: e.allIn, key: ctx.actionKey },
      }));
      return { ...next, potTotal: next.potTotal + e.amount };
    }
    case 'deal_hole':
      return mapSeat({ ...view, dealKey: view.dealKey + 1 }, e.seat, (s) => {
        const cards: [Card | null, Card | null] = [s.cards[0], s.cards[1]];
        cards[e.cardIndex] = ctx.ownCards(e.seat, e.cardIndex);
        return { ...s, dealt: e.cardIndex + 1, cards, inHand: true, position: ctx.positionOf(s.seat) };
      });
    case 'action': {
      const next = mapSeat(view, e.seat, (s) => ({
        ...s,
        stack: s.stack - e.added,
        bet: s.bet + e.added,
        folded: e.action === 'fold' ? true : s.folded,
        allIn: e.allIn,
        lastAction: { kind: e.action, amount: e.action === 'call' ? e.added : e.to, allIn: e.allIn, key: ctx.actionKey },
      }));
      return {
        ...next,
        potTotal: next.potTotal + e.added,
        muckCount: e.action === 'fold' ? next.muckCount + 1 : next.muckCount,
        actorSeat: null,
        deadline: null,
        legal: null,
      };
    }
    case 'uncalled': {
      const next = mapSeat(view, e.seat, (s) => ({ ...s, stack: s.stack + e.amount, bet: s.bet - e.amount, allIn: false }));
      return { ...next, potTotal: next.potTotal - e.amount };
    }
    case 'collect': {
      const seats = view.seats.map((s) => (s ? { ...s, bet: 0, lastAction: s.lastAction?.kind === 'fold' ? s.lastAction : null } : null));
      return { ...view, seats, pot: e.pot, potTotal: e.pot, collectKey: view.collectKey + 1 };
    }
    case 'burn':
      return { ...view, burnCount: view.burnCount + 1, street: e.street };
    case 'board':
      return { ...view, board: e.board, street: e.street };
    case 'allin_reveal': {
      let next = view;
      for (const h of e.hands) {
        next = mapSeat(next, h.seat, (s) => ({ ...s, cards: [h.cards[0], h.cards[1]], showing: true }));
      }
      return next;
    }
    case 'show':
      return mapSeat({ ...view, street: 'showdown' }, e.seat, (s) => ({
        ...s,
        cards: [e.cards[0], e.cards[1]],
        showing: true,
        handDescription: e.description,
        bestFive: e.bestFive,
      }));
    case 'muck':
      return mapSeat({ ...view, street: 'showdown', muckCount: view.muckCount + 1 }, e.seat, (s) => ({ ...s, mucked: true }));
    case 'award': {
      const next = mapSeat(view, e.seat, (s) => ({
        ...s,
        stack: s.stack + e.amount,
        won: s.won + e.amount,
        lastAction: { kind: 'win', amount: s.won + e.amount, allIn: false, key: ctx.actionKey },
        handDescription: e.description ?? s.handDescription,
        bestFive: e.bestFive ?? s.bestFive,
      }));
      return {
        ...next,
        pot: Math.max(0, next.pot - e.amount),
        potTotal: Math.max(0, next.potTotal - e.amount),
        awardKey: next.awardKey + 1,
        winners: [...next.winners, { seat: e.seat, amount: e.amount, potIndex: e.potIndex }],
      };
    }
    case 'hand_end':
      return { ...view, actorSeat: null, deadline: null, legal: null, phase: 'hand_over', pot: 0, potTotal: 0 };
  }
}

/** Sanity check used by tests: the bets shown always add up to pot minus collected chips. */
export const viewPotConsistent = (view: TableView): boolean => view.potTotal === view.pot + totalBets(view);

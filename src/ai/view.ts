import type { Card } from '../engine/cards';
import type { ActionKind, BettingStreet, Hand, LegalActions } from '../engine/hand';

/** Only what a real player at the table could see. Bots never receive the `Hand` itself. */
export interface PublicPlayer {
  seat: number;
  id: string;
  position: string;
  stack: number;
  startStack: number;
  streetBet: number;
  contributed: number;
  folded: boolean;
  allIn: boolean;
}

export interface PublicAction {
  seat: number;
  street: BettingStreet;
  action: ActionKind;
  added: number;
  to: number;
  allIn: boolean;
  /** Chips the player had to call at the time. */
  facing: number;
  potBefore: number;
}

export interface TournamentPressure {
  playersLeft: number;
  paidPlaces: number;
  averageStack: number;
  isBubble: boolean;
  inTheMoney: boolean;
  finalTable: boolean;
  /** 0..0.35: how much extra a chip lost hurts compared to a chip won. */
  riskPremium: number;
  blindLevel: number;
}

export interface PublicHandView {
  handNumber: number;
  street: BettingStreet;
  board: readonly Card[];
  /** Board cards by street, used to replay how ranges narrowed. */
  boardByStreet: Readonly<Partial<Record<BettingStreet, readonly Card[]>>>;
  pot: number;
  currentBet: number;
  bigBlind: number;
  smallBlind: number;
  buttonSeat: number;
  /** Deal order: index 0 is directly left of the button. */
  players: readonly PublicPlayer[];
  actions: readonly PublicAction[];
  legal: LegalActions;
  seat: number;
  hole: readonly [Card, Card];
  tournament?: TournamentPressure;
}

export function boardByStreetOf(board: readonly Card[]): Partial<Record<BettingStreet, readonly Card[]>> {
  const out: Partial<Record<BettingStreet, readonly Card[]>> = { preflop: [] };
  if (board.length >= 3) out.flop = board.slice(0, 3);
  if (board.length >= 4) out.turn = board.slice(0, 4);
  if (board.length >= 5) out.river = board.slice(0, 5);
  return out;
}

/** Builds the player's public view of the running hand plus their own hole cards. */
export function buildPublicView(hand: Hand, seat: number, tournament?: TournamentPressure): PublicHandView {
  const legal = hand.legalActions(seat);
  if (!legal) throw new Error(`Seat ${seat} is not to act`);
  const self = hand.playerAt(seat)!;
  const actions: PublicAction[] = [];
  for (const e of hand.events) {
    if (e.t === 'action') {
      actions.push({ seat: e.seat, street: e.street, action: e.action, added: e.added, to: e.to, allIn: e.allIn, facing: e.facing, potBefore: e.potBefore });
    }
  }
  return {
    handNumber: hand.handNumber,
    street: hand.street as BettingStreet,
    board: [...hand.board],
    boardByStreet: boardByStreetOf(hand.board),
    pot: hand.totalPot,
    currentBet: hand.currentBet,
    bigBlind: hand.bigBlind,
    smallBlind: hand.smallBlind,
    buttonSeat: hand.buttonSeat,
    players: hand.players.map((p) => ({
      seat: p.seat,
      id: p.id,
      position: p.position,
      stack: p.stack,
      startStack: p.startStack,
      streetBet: p.streetBet,
      contributed: p.contributed,
      folded: p.folded,
      allIn: p.allIn,
    })),
    actions,
    legal,
    seat,
    hole: [self.hole[0], self.hole[1]],
    tournament,
  };
}

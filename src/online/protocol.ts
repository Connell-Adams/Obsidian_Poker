import type { HandEvent, LegalActions, PlayerAction } from '../engine/hand';

/** What every room member may see. Holds no hidden cards and no deck. */
export interface PublicTable {
  handNo: number;
  handActive: boolean;
  buttonSeat: number | null;
  smallBlind: number;
  bigBlind: number;
  /** Who was dealt into the current or most recent hand, with starting stacks. */
  startSeats: Array<{ seat: number; userId: string; name: string; avatar: number; stack: number }>;
  /** The engine's event log for that hand. Hole cards appear only once shown. */
  events: HandEvent[];
  actorSeat: number | null;
  actorUserId: string | null;
  /** Epoch milliseconds when the actor's clock runs out. */
  deadline: number | null;
  actionSeconds: number;
  /** The actor's options. Derived from public information only. */
  legal: LegalActions | null;
  nextHandAt: number | null;
  summary: string | null;
}

export type ClientRequest =
  | {
      action: 'create_room';
      name: string;
      smallBlind: number;
      bigBlind: number;
      minBuyIn: number;
      maxBuyIn: number;
      maxSeats: number;
      actionSeconds: number;
      buyIn: number;
      ref: string;
    }
  | { action: 'join_room'; code: string; buyIn: number; ref: string }
  | { action: 'leave_room'; roomId: string; ref: string }
  | { action: 'top_up'; roomId: string; amount: number; ref: string }
  | { action: 'sit_out' | 'sit_in'; roomId: string }
  | { action: 'start_hand'; roomId: string }
  | { action: 'act'; roomId: string; handNo: number; move: PlayerAction }
  | { action: 'timeout'; roomId: string; handNo: number };

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Readable messages for the error codes the server can return. */
export const SERVER_MESSAGES: Record<string, string> = {
  insufficient_chips: 'You do not have enough online chips for that.',
  duplicate_request: 'That request was already processed.',
  room_not_found: 'No open room has that code.',
  already_seated: 'You are already seated in that room.',
  room_full: 'That room is full.',
  buyin_out_of_range: 'That amount is outside the room’s buy-in limits.',
  buyin_too_small: 'The minimum buy-in must be at least 400 chips.',
  not_seated: 'You are not seated in that room.',
  in_hand: 'You can only do that between hands.',
  version_conflict: 'The table changed at the same moment. Please try again.',
  not_your_turn: 'It is not your turn.',
  illegal_action: 'That action is not allowed right now.',
  hand_not_active: 'There is no hand in progress.',
  hand_already_active: 'A hand is already in progress.',
  not_enough_players: 'At least two players with chips are needed to deal.',
  too_early: 'Not yet.',
  stale_hand: 'That hand has already finished.',
  bad_request: 'The request was not valid.',
  not_bankrupt: 'A reset is only available when you cannot afford the minimum buy-in and have no chips at a table.',
  not_signed_in: 'Please sign in first.',
};

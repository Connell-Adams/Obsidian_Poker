import { describe, expect, it } from 'vitest';
import type { PublicTable } from '../../src/online/protocol';
import { buildOnlineView, type RoomInfo, type SeatInfo } from '../../src/online/roomConnection';

const room: RoomInfo = { id: 'r1', code: 'ABCDEF', name: 'Test', host_id: 'a', small_blind: 10, big_blind: 20, min_buyin: 800, max_buyin: 4000, max_seats: 6, action_seconds: 30 };

function lastHand(handActive: boolean): PublicTable {
  return {
    handNo: 2,
    handActive,
    buttonSeat: 0,
    smallBlind: 10,
    bigBlind: 20,
    startSeats: [
      { seat: 0, userId: 'a', name: 'Alice', avatar: 0, stack: 2000 },
      { seat: 1, userId: 'b', name: 'Bob', avatar: 0, stack: 2000 },
    ],
    events: [],
    actorSeat: handActive ? 0 : null,
    actorUserId: handActive ? 'a' : null,
    deadline: null,
    actionSeconds: 30,
    legal: null,
    nextHandAt: null,
    summary: null,
  };
}

const onlyAlice: SeatInfo[] = [{ seat: 0, user_id: 'a', stack: 4000, status: 'active', name: 'Alice', avatar: 0 }];

describe('buildOnlineView', () => {
  it('clears a player who left once the hand is over', () => {
    const view = buildOnlineView(room, lastHand(false), onlyAlice, 'a', null, 0);
    expect(view.seats[0]?.name).toBe('Alice');
    expect(view.seats[1]).toBeNull();
  });

  it('keeps a player who is leaving until their hand ends', () => {
    const view = buildOnlineView(room, lastHand(true), onlyAlice, 'a', null, 0);
    expect(view.seats[1]?.name).toBe('Bob');
  });
});

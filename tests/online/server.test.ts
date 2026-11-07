import { beforeEach, describe, expect, it } from 'vitest';
import type { PlayerAction } from '../../src/engine/hand';
import { SeededRng } from '../../src/engine/rng';
import type { PublicTable } from '../../src/online/protocol';
import { GameError, handleRequest, type ServerDeps } from '../../src/online/server/core';
import { createTestDatabase, type TestDb } from './pgHarness';

const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const CARL = '00000000-0000-4000-8000-00000000000c';

let db: TestDb;
let clock = 1_800_000_000_000;
let refSeq = 0;
const ref = () => `ref-${(++refSeq).toString().padStart(8, '0')}`;

/** The server exactly as the Edge Function runs it, but talking to the test database. */
function deps(seed = 'deal'): ServerDeps {
  return {
    rpc: async (name, args) => {
      await db.asService();
      return db.rpc(name, args);
    },
    now: () => clock,
    rng: new SeededRng(seed),
  };
}

async function send(user: string, body: Record<string, unknown>, d = deps()): Promise<any> {
  return handleRequest(user, body, d);
}

async function codeOf(user: string, body: Record<string, unknown>): Promise<string> {
  try {
    await send(user, body);
    return 'ok';
  } catch (error) {
    return error instanceof GameError ? error.code : String(error);
  }
}

async function table(roomId: string): Promise<{ version: number; handActive: boolean; pub: PublicTable }> {
  await db.asService();
  const [row] = await db.rows<{ version: number; hand_active: boolean; public: PublicTable }>('select version, hand_active, public from room_state where room_id = $1', [roomId]);
  return { version: Number(row.version), handActive: row.hand_active, pub: row.public };
}

/** Total online chips that exist: every wallet plus every stack at every table. */
async function totalChips(): Promise<number> {
  await db.asService();
  const [w] = await db.rows<{ s: number }>('select coalesce(sum(balance), 0)::bigint s from online_wallets');
  const [t] = await db.rows<{ s: number }>('select coalesce(sum(stack), 0)::bigint s from room_seats');
  return Number(w.s) + Number(t.s);
}

async function openRoom(): Promise<string> {
  const created = await send(ALICE, { action: 'create_room', name: 'Friday game', smallBlind: 10, bigBlind: 20, minBuyIn: 400, maxBuyIn: 4000, maxSeats: 6, actionSeconds: 30, buyIn: 2000, ref: ref() });
  await send(BOB, { action: 'join_room', code: created.code, buyIn: 2000, ref: ref() });
  return created.roomId;
}

const actorOf = (pub: PublicTable) => pub.actorUserId!;

/** A simple player: checks or calls, sometimes raises, sometimes folds. */
function choose(pub: PublicTable, r: SeededRng): PlayerAction {
  const legal = pub.legal!;
  const x = r.next();
  if ((legal.canBet || legal.canRaise) && x < 0.2) return { type: legal.canBet ? 'bet' : 'raise', to: legal.minTo };
  if (legal.canCall && x > 0.9) return { type: 'fold' };
  return legal.canCheck ? { type: 'check' } : { type: 'call' };
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.createUser(ALICE, { username: 'alice' });
  await db.createUser(BOB, { username: 'bob' });
  await db.createUser(CARL, { username: 'carl' });
}, 60000);

describe('rooms', () => {
  it('creates a private room with a code and seats the host with their buy-in', async () => {
    const created = await send(ALICE, { action: 'create_room', name: 'Test', smallBlind: 5, bigBlind: 10, minBuyIn: 400, maxBuyIn: 2000, maxSeats: 6, actionSeconds: 30, buyIn: 1000, ref: ref() });
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(created.seat).toBe(0);
    await db.asService();
    const [w] = await db.rows<{ balance: number }>('select balance from online_wallets where user_id = $1', [ALICE]);
    expect(Number(w.balance)).toBe(24000);
  });

  it('rejects malformed or out-of-range requests before touching the database', async () => {
    expect(await codeOf(ALICE, { action: 'create_room', name: 'x', smallBlind: 5, bigBlind: 10, minBuyIn: 100, maxBuyIn: 2000, maxSeats: 6, actionSeconds: 30, buyIn: 1000, ref: ref() })).toBe('bad_request');
    expect(await codeOf(ALICE, { action: 'join_room', code: 'NOPE!!', buyIn: 1000, ref: ref() })).toBe('bad_request');
    expect(await codeOf(ALICE, { action: 'join_room', code: 'ZZZZZZ', buyIn: 1000, ref: ref() })).toBe('room_not_found');
    expect(await codeOf(ALICE, { action: 'award_me_chips', amount: 1e9 })).toBe('bad_request');
    expect(await codeOf('not-a-user', { action: 'start_hand', roomId: ALICE })).toBe('not_signed_in');
  });

  it('refuses a buy-in larger than the wallet', async () => {
    const roomId = await openRoom();
    const code = (await table(roomId)) && (await db.rows<{ code: string }>('select code from rooms where id = $1', [roomId]))[0].code;
    await db.asService();
    await db.rpc('wallet_move', { p_user: CARL, p_kind: 'buyin', p_amount: -24800, p_ref: 'drain', p_room: null, p_note: 'x' });
    expect(await codeOf(CARL, { action: 'join_room', code, buyIn: 400, ref: ref() })).toBe('insufficient_chips');
  });
});

describe('playing hands', () => {
  it('deals private cards that only their owner can read', async () => {
    const roomId = await openRoom();
    await send(ALICE, { action: 'start_hand', roomId });
    await db.asUser(ALICE);
    const mine = await db.rows<{ user_id: string; cards: number[] }>('select user_id, cards from hand_private');
    expect(mine).toHaveLength(1);
    expect(mine[0].user_id).toBe(ALICE);
    const { pub } = await table(roomId);
    const serialized = JSON.stringify(pub);
    // Neither player's hole cards appear anywhere in the public table.
    await db.asService();
    const all = await db.rows<{ cards: number[] }>('select cards from hand_private');
    for (const row of all) expect(serialized).not.toContain(`"cards":[${row.cards[0]},${row.cards[1]}]`);
    expect(pub.events.some((e) => e.t === 'deal_hole')).toBe(true);
    expect(pub.events.filter((e) => e.t === 'show' || e.t === 'allin_reveal')).toHaveLength(0);
  });

  it('only lets the player whose turn it is act', async () => {
    const roomId = await openRoom();
    await send(ALICE, { action: 'start_hand', roomId });
    const { pub } = await table(roomId);
    const waiting = actorOf(pub) === ALICE ? BOB : ALICE;
    expect(await codeOf(waiting, { action: 'act', roomId, handNo: pub.handNo, move: { type: 'fold' } })).toBe('not_your_turn');
    expect(await codeOf(CARL, { action: 'act', roomId, handNo: pub.handNo, move: { type: 'fold' } })).toBe('not_your_turn');
    expect(await codeOf(actorOf(pub), { action: 'act', roomId, handNo: pub.handNo, move: { type: 'raise', to: 999999 } })).toBe('illegal_action');
    expect(await codeOf(actorOf(pub), { action: 'act', roomId, handNo: pub.handNo, move: { type: 'raise', to: 60, extra: 1 } })).toBe('bad_request');
    expect(await codeOf(actorOf(pub), { action: 'act', roomId, handNo: pub.handNo, move: { type: 'call' } })).toBe('ok');
  });

  it('lets exactly one of two simultaneous actions through', async () => {
    const roomId = await openRoom();
    await send(ALICE, { action: 'start_hand', roomId });
    const { pub, version } = await table(roomId);
    const actor = actorOf(pub);
    const results = await Promise.allSettled([
      send(actor, { action: 'act', roomId, handNo: pub.handNo, move: { type: 'call' } }),
      send(actor, { action: 'act', roomId, handNo: pub.handNo, move: { type: 'call' } }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    const after = await table(roomId);
    expect(after.version).toBe(version + 1);
  });

  it('plays many hands between two accounts with chips conserved and settled correctly', async () => {
    const roomId = await openRoom();
    const start = await totalChips();
    const r = new SeededRng('players');
    let hands = 0;
    for (let guard = 0; hands < 25 && guard < 2000; guard++) {
      const { pub, handActive } = await table(roomId);
      if (!handActive) {
        await db.asService();
        const busted = await db.rows<{ user_id: string }>('select user_id from room_seats where room_id = $1 and stack = 0', [roomId]);
        for (const b of busted) await send(b.user_id, { action: 'top_up', roomId, amount: 2000, ref: ref() });
        clock += 5000;
        await send(ALICE, { action: 'start_hand', roomId });
        hands++;
        continue;
      }
      await send(actorOf(pub), { action: 'act', roomId, handNo: pub.handNo, move: choose(pub, r) });
      clock += 1000;
      expect(await totalChips()).toBe(start);
    }
    expect(hands).toBe(25);
    await db.asService();
    const records = await db.rows<{ record: { players: Array<{ hole: number[]; shown: boolean }> } }>('select record from online_hands where room_id = $1', [roomId]);
    expect(records.length).toBeGreaterThanOrEqual(24);
    for (const { record } of records) for (const p of record.players) if (!p.shown) expect(p.hole).toEqual([-1, -1]);
    const stats = await db.rows<{ counters: Record<string, number> }>('select counters from online_stats where user_id = $1', [ALICE]);
    expect(stats[0].counters.hands).toBeGreaterThanOrEqual(24);
  }, 120000);

  it('settles a hand and pays the winner into their stack, then cashes out exactly', async () => {
    const roomId = await openRoom();
    await send(ALICE, { action: 'start_hand', roomId });
    const { pub } = await table(roomId);
    const folder = actorOf(pub);
    await send(folder, { action: 'act', roomId, handNo: pub.handNo, move: { type: 'fold' } });
    const done = await table(roomId);
    expect(done.handActive).toBe(false);
    expect(done.pub.summary).toMatch(/wins 20/);
    await db.asService();
    const seats = await db.rows<{ user_id: string; stack: number }>('select user_id, stack from room_seats where room_id = $1', [roomId]);
    const winner = seats.find((s) => s.user_id !== folder)!;
    expect(Number(winner.stack)).toBe(2010);
    await send(winner.user_id, { action: 'leave_room', roomId, ref: ref() });
    const [w] = await db.rows<{ balance: number; lifetime_pl: number }>('select balance, lifetime_pl from online_wallets where user_id = $1', [winner.user_id]);
    expect(Number(w.balance)).toBe(25010);
    expect(Number(w.lifetime_pl)).toBe(10);
  });

  it('folds out a player who leaves mid-hand and pays them after the hand', async () => {
    const roomId = await openRoom();
    await send(ALICE, { action: 'start_hand', roomId });
    const { pub } = await table(roomId);
    const leaver = actorOf(pub);
    const result = await send(leaver, { action: 'leave_room', roomId, ref: ref() });
    expect(result.status).toBe('leaving');
    const after = await table(roomId);
    expect(after.handActive).toBe(false);
    await db.asService();
    expect(await db.rows('select * from room_seats where user_id = $1', [leaver])).toEqual([]);
    const [w] = await db.rows<{ balance: number }>('select balance from online_wallets where user_id = $1', [leaver]);
    expect(Number(w.balance)).toBeGreaterThan(24000 - 2000);
    expect(await totalChips()).toBe(75000);
  });
});

describe('the clock', () => {
  it('refuses an early timeout claim, then folds or checks the actor and sits out repeat offenders', async () => {
    const roomId = await openRoom();
    await send(ALICE, { action: 'start_hand', roomId });
    const { pub } = await table(roomId);
    const slow = actorOf(pub);
    const other = slow === ALICE ? BOB : ALICE;
    expect(await codeOf(other, { action: 'timeout', roomId, handNo: pub.handNo })).toBe('too_early');
    clock = pub.deadline! + 1000;
    expect(await codeOf(other, { action: 'timeout', roomId, handNo: pub.handNo })).toBe('ok');
    expect(await codeOf(CARL, { action: 'timeout', roomId, handNo: pub.handNo })).toBe('not_seated');
    await db.asService();
    const [seat] = await db.rows<{ missed_turns: number }>('select missed_turns from room_seats where user_id = $1', [slow]);
    expect(seat.missed_turns).toBe(1);
  });

  it('will not deal before the pause between hands has passed', async () => {
    const roomId = await openRoom();
    await send(ALICE, { action: 'start_hand', roomId });
    expect(await codeOf(BOB, { action: 'start_hand', roomId })).toBe('hand_already_active');
    const { pub } = await table(roomId);
    await send(actorOf(pub), { action: 'act', roomId, handNo: pub.handNo, move: { type: 'fold' } });
    expect(await codeOf(BOB, { action: 'start_hand', roomId })).toBe('too_early');
    clock += 10_000;
    expect(await codeOf(BOB, { action: 'start_hand', roomId })).toBe('ok');
  });
});

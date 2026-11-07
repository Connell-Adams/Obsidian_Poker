import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDb } from './pgHarness';

const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const EVE = '00000000-0000-4000-8000-00000000000e';

let db: TestDb;

async function balanceOf(user: string): Promise<number> {
  await db.asService();
  const [row] = await db.rows<{ balance: string }>('select balance from online_wallets where user_id = $1', [user]);
  return Number(row.balance);
}

async function makeRoom(host = ALICE, min = 400, max = 4000): Promise<string> {
  await db.asService();
  return (await db.rpc('room_create', { p_host: host, p_code: 'ABCDEF', p_name: 'Test', p_sb: 5, p_bb: 10, p_min: min, p_max: max, p_seats: 6, p_action_seconds: 30 })) as string;
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.createUser(ALICE, { username: 'alice', display_name: 'Alice', avatar: 3 });
  await db.createUser(BOB, { username: 'bob' });
  await db.createUser(EVE, { username: 'eve' });
}, 60000);

describe('accounts', () => {
  it('gives every new account a profile and exactly 25,000 online chips, recorded in the ledger', async () => {
    expect(await balanceOf(ALICE)).toBe(25000);
    const ledger = await db.rows<{ kind: string; amount: string }>('select kind, amount from online_ledger where user_id = $1', [ALICE]);
    expect(ledger).toEqual([{ kind: 'signup', amount: 25000 }]);
    const [p] = await db.rows<{ username: string; display_name: string; avatar: number }>('select username, display_name, avatar from profiles where id = $1', [ALICE]);
    expect(p).toEqual({ username: 'alice', display_name: 'Alice', avatar: 3 });
  });

  it('keeps usernames unique regardless of case, falling back safely', async () => {
    const SAM = '00000000-0000-4000-8000-0000000000aa';
    await db.createUser(SAM, { username: 'ALICE' });
    const [p] = await db.rows<{ username: string }>('select username from profiles where id = $1', [SAM]);
    expect(p.username).toMatch(/^player_/);
    await db.asAnon();
    expect(await db.rpc('username_available', { p_username: 'Alice' })).toBe(false);
    expect(await db.rpc('username_available', { p_username: 'carol' })).toBe(true);
    expect(await db.rpc('username_available', { p_username: 'no spaces!' })).toBe(false);
  });

  it('lets players edit only their own profile, and never into an invalid one', async () => {
    await db.asUser(ALICE);
    await db.rows(`update profiles set display_name = 'Queen A' where id = $1`, [ALICE]);
    await db.rows(`update profiles set display_name = 'hacked' where id = $1`, [BOB]);
    await db.asService();
    const rows = await db.rows<{ id: string; display_name: string }>('select id, display_name from profiles order by id');
    expect(rows.find((r) => r.id === ALICE)!.display_name).toBe('Queen A');
    expect(rows.find((r) => r.id === BOB)!.display_name).toBe('bob');
    await db.asUser(ALICE);
    expect(await db.errorOf(() => db.rows(`update profiles set username = 'bob' where id = $1`, [ALICE]))).toMatch(/duplicate|unique/);
    expect(await db.errorOf(() => db.rows(`update profiles set avatar = 99 where id = $1`, [ALICE]))).toMatch(/avatar_range/);
  });
});

describe('players cannot touch online chips', () => {
  it('blocks every direct write to wallets and the ledger', async () => {
    await db.asUser(ALICE);
    expect(await db.errorOf(() => db.rows(`update online_wallets set balance = 999999999 where user_id = $1`, [ALICE]))).toMatch(/permission denied/);
    expect(await db.errorOf(() => db.rows(`insert into online_ledger (user_id, kind, amount, balance_after, ref) values ($1, 'cashout', 1000000, 1000000, 'x')`, [ALICE]))).toMatch(/permission denied/);
    expect(await db.errorOf(() => db.rows(`delete from online_ledger where user_id = $1`, [ALICE]))).toMatch(/permission denied/);
    expect(await balanceOf(ALICE)).toBe(25000);
  });

  it('refuses the server-only chip functions to players and visitors', async () => {
    for (const as of ['user', 'anon'] as const) {
      if (as === 'user') await db.asUser(ALICE);
      else await db.asAnon();
      expect(await db.errorOf(() => db.rpc('wallet_move', { p_user: ALICE, p_kind: 'cashout', p_amount: 1000000, p_ref: 'steal', p_room: null, p_note: 'x' }))).toMatch(/permission denied/);
      expect(await db.errorOf(() => db.rpc('room_commit', { p_room: ALICE, p_version: 0, p_public: {}, p_hand_active: false, p_hand_no: 0, p_button: null, p_next_hand_at: null, p_secret: null, p_private: null, p_seat_updates: null, p_settle: null }))).toMatch(/permission denied/);
      expect(await db.errorOf(() => db.rpc('cash_out_seat', { p_room: ALICE, p_user: ALICE, p_ref: 'x' }))).toMatch(/permission denied/);
    }
    expect(await balanceOf(ALICE)).toBe(25000);
  });

  it('shows each player only their own wallet and ledger', async () => {
    await db.asUser(ALICE);
    const wallets = await db.rows<{ user_id: string }>('select user_id from online_wallets');
    expect(wallets.map((w) => w.user_id)).toEqual([ALICE]);
    const ledger = await db.rows<{ user_id: string }>('select user_id from online_ledger');
    expect(new Set(ledger.map((l) => l.user_id))).toEqual(new Set([ALICE]));
    await db.asAnon();
    expect(await db.errorOf(() => db.rows('select * from online_wallets'))).toMatch(/permission denied/);
  });
});

describe('wallet primitive', () => {
  it('moves chips atomically, refuses overdrafts and refuses a reused reference', async () => {
    await db.asService();
    expect(Number(await db.rpc('wallet_move', { p_user: ALICE, p_kind: 'buyin', p_amount: -1000, p_ref: 'r1', p_room: null, p_note: 'x' }))).toBe(24000);
    expect(await db.errorOf(() => db.rpc('wallet_move', { p_user: ALICE, p_kind: 'buyin', p_amount: -1000, p_ref: 'r1', p_room: null, p_note: 'x' }))).toMatch(/duplicate_request/);
    expect(await db.errorOf(() => db.rpc('wallet_move', { p_user: ALICE, p_kind: 'buyin', p_amount: -30000, p_ref: 'r2', p_room: null, p_note: 'x' }))).toMatch(/insufficient_chips/);
    expect(await balanceOf(ALICE)).toBe(24000);
    const [sum] = await db.rows<{ s: string }>('select sum(amount) s from online_ledger where user_id = $1', [ALICE]);
    expect(Number(sum.s)).toBe(24000);
  });
});

describe('bankruptcy reset', () => {
  async function drain(user: string, to: number) {
    await db.asService();
    const balance = await balanceOf(user);
    await db.rpc('wallet_move', { p_user: user, p_kind: 'buyin', p_amount: to - balance, p_ref: `drain-${to}`, p_room: null, p_note: 'test' });
  }

  it('is refused while the player can still afford the minimum buy-in', async () => {
    await db.asUser(ALICE);
    expect(await db.errorOf(() => db.rpc('online_bankrupt_reset'))).toMatch(/not_bankrupt/);
    await drain(ALICE, 400);
    await db.asUser(ALICE);
    expect(await db.errorOf(() => db.rpc('online_bankrupt_reset'))).toMatch(/not_bankrupt/);
    expect(await balanceOf(ALICE)).toBe(400);
  });

  it('restores exactly 25,000, logs it as a reset and leaves lifetime P/L alone', async () => {
    await drain(ALICE, 0);
    await db.asService();
    await db.rows('update online_wallets set lifetime_pl = -25000 where user_id = $1', [ALICE]);
    await db.asUser(ALICE);
    expect(await db.rpc('online_bankrupt_reset')).toEqual({ balance: 25000 });
    expect(await balanceOf(ALICE)).toBe(25000);
    await db.asService();
    const [w] = await db.rows<{ lifetime_pl: string; resets: number }>('select lifetime_pl, resets from online_wallets where user_id = $1', [ALICE]);
    expect(Number(w.lifetime_pl)).toBe(-25000);
    expect(w.resets).toBe(1);
    const [last] = await db.rows<{ kind: string; amount: string }>(`select kind, amount from online_ledger where user_id = $1 order by id desc limit 1`, [ALICE]);
    expect(last).toEqual({ kind: 'bankruptcy_reset', amount: 25000 });
  });

  it('cannot be repeated to duplicate chips', async () => {
    await drain(ALICE, 100);
    await db.asUser(ALICE);
    await db.rpc('online_bankrupt_reset');
    expect(await db.errorOf(() => db.rpc('online_bankrupt_reset'))).toMatch(/not_bankrupt/);
    expect(await balanceOf(ALICE)).toBe(25000);
  });

  it('is refused while chips are still sitting at a table', async () => {
    const room = await makeRoom();
    await db.rpc('room_join', { p_room: room, p_user: ALICE, p_amount: 400, p_ref: 'j1' });
    await drain(ALICE, 0);
    await db.asUser(ALICE);
    expect(await db.errorOf(() => db.rpc('online_bankrupt_reset'))).toMatch(/not_bankrupt/);
  });
});

describe('rooms and seats', () => {
  it('takes the buy-in from the wallet and seats players in distinct seats', async () => {
    const room = await makeRoom();
    expect(await db.rpc('room_join', { p_room: room, p_user: ALICE, p_amount: 1000, p_ref: 'a' })).toBe(0);
    expect(await db.rpc('room_join', { p_room: room, p_user: BOB, p_amount: 2000, p_ref: 'b' })).toBe(1);
    expect(await balanceOf(ALICE)).toBe(24000);
    expect(await balanceOf(BOB)).toBe(23000);
    expect(await db.errorOf(() => db.rpc('room_join', { p_room: room, p_user: ALICE, p_amount: 1000, p_ref: 'a2' }))).toMatch(/already_seated/);
    expect(await db.errorOf(() => db.rpc('room_join', { p_room: room, p_user: EVE, p_amount: 100, p_ref: 'e' }))).toMatch(/buyin_out_of_range/);
    expect(await db.errorOf(() => db.rpc('room_join', { p_room: room, p_user: EVE, p_amount: 30000, p_ref: 'e2' }))).toMatch(/buyin_out_of_range/);
  });

  it('cashes out with the session P/L recorded once', async () => {
    const room = await makeRoom();
    await db.rpc('room_join', { p_room: room, p_user: ALICE, p_amount: 1000, p_ref: 'a' });
    await db.rows(`update room_seats set stack = 1600 where user_id = $1`, [ALICE]);
    expect(await db.rpc('room_leave', { p_room: room, p_user: ALICE, p_ref: 'out' })).toBe('left');
    expect(await balanceOf(ALICE)).toBe(25600);
    const [w] = await db.rows<{ lifetime_pl: string; sessions_played: number; sessions_won: number }>('select lifetime_pl, sessions_played, sessions_won from online_wallets where user_id = $1', [ALICE]);
    expect(w).toEqual({ lifetime_pl: 600, sessions_played: 1, sessions_won: 1 });
    expect(await db.errorOf(() => db.rpc('room_leave', { p_room: room, p_user: ALICE, p_ref: 'out' }))).toMatch(/not_seated/);
  });

  it('only lets members see a room, and never anyone see a deck or another player\'s cards', async () => {
    const room = await makeRoom();
    await db.rpc('room_join', { p_room: room, p_user: ALICE, p_amount: 1000, p_ref: 'a' });
    await db.rpc('room_join', { p_room: room, p_user: BOB, p_amount: 1000, p_ref: 'b' });
    await db.rows(`update room_secrets set deck = '{1,2,3}' where room_id = $1`, [room]);
    await db.rows(`insert into hand_private (room_id, hand_no, user_id, cards) values ($1, 1, $2, '{10,11}'), ($1, 1, $3, '{20,21}')`, [room, ALICE, BOB]);

    await db.asUser(EVE);
    expect(await db.rows('select * from rooms')).toEqual([]);
    expect(await db.rows('select * from room_state')).toEqual([]);

    await db.asUser(ALICE);
    expect((await db.rows('select * from room_seats')).length).toBe(2);
    expect(await db.errorOf(() => db.rows('select * from room_secrets'))).toMatch(/permission denied/);
    const cards = await db.rows<{ user_id: string }>('select user_id from hand_private');
    expect(cards.map((c) => c.user_id)).toEqual([ALICE]);
  });
});

describe('room_commit', () => {
  it('rejects a write based on a stale version: two simultaneous actions cannot both land', async () => {
    const room = await makeRoom();
    const base = { p_room: room, p_public: {}, p_hand_active: false, p_hand_no: 0, p_button: null, p_next_hand_at: null, p_secret: null, p_private: null, p_seat_updates: null, p_settle: null };
    expect(Number(await db.rpc('room_commit', { ...base, p_version: 0 }))).toBe(1);
    expect(await db.errorOf(() => db.rpc('room_commit', { ...base, p_version: 0 }))).toMatch(/version_conflict/);
  });

  it('refuses to settle a hand that would create or destroy chips', async () => {
    const room = await makeRoom();
    await db.rpc('room_join', { p_room: room, p_user: ALICE, p_amount: 1000, p_ref: 'a' });
    await db.rpc('room_join', { p_room: room, p_user: BOB, p_amount: 1000, p_ref: 'b' });
    const [state] = await db.rows<{ version: string }>('select version from room_state where room_id = $1', [room]);
    const settle = (a: number, b: number) => ({ stacks: [{ seat: 0, user_id: ALICE, stack: a }, { seat: 1, user_id: BOB, stack: b }], record: {}, stats: [] });
    const base = { p_room: room, p_version: Number(state.version), p_public: {}, p_hand_active: false, p_hand_no: 1, p_button: 0, p_next_hand_at: null, p_secret: null, p_private: null, p_seat_updates: null };
    expect(await db.errorOf(() => db.rpc('room_commit', { ...base, p_settle: settle(1500, 1000) }))).toMatch(/chip_conservation_failed/);
    // Nothing was written by the failed attempt, so the same version still applies.
    expect(await db.errorOf(() => db.rpc('room_commit', { ...base, p_settle: settle(1500, 500) }))).toBeNull();
    const seats = await db.rows<{ stack: string }>('select stack from room_seats where room_id = $1 order by seat', [room]);
    expect(seats.map((s) => Number(s.stack))).toEqual([1500, 500]);
  });

  it('cashes out players who asked to leave during the hand once it is settled', async () => {
    const room = await makeRoom();
    await db.rpc('room_join', { p_room: room, p_user: ALICE, p_amount: 1000, p_ref: 'a' });
    await db.rpc('room_join', { p_room: room, p_user: BOB, p_amount: 1000, p_ref: 'b' });
    await db.rows(`update room_state set hand_active = true where room_id = $1`, [room]);
    await db.rows(`update room_secrets set start_seats = $2 where room_id = $1`, [room, JSON.stringify([{ id: ALICE }, { id: BOB }])]);
    expect(await db.rpc('room_leave', { p_room: room, p_user: BOB, p_ref: 'bye' })).toBe('leaving');
    expect(await balanceOf(BOB)).toBe(24000); // still at the table
    const [state] = await db.rows<{ version: string }>('select version from room_state where room_id = $1', [room]);
    await db.rpc('room_commit', {
      p_room: room, p_version: Number(state.version), p_public: {}, p_hand_active: false, p_hand_no: 1, p_button: 0, p_next_hand_at: null,
      p_secret: null, p_private: null, p_seat_updates: null,
      p_settle: { stacks: [{ seat: 0, user_id: ALICE, stack: 1200 }, { seat: 1, user_id: BOB, stack: 800 }], record: {}, stats: [{ user_id: ALICE, delta: { hands: 1, biggestPotWon: 400 } }] },
    });
    expect(await balanceOf(BOB)).toBe(24800);
    expect(await db.rows('select * from room_seats where user_id = $1', [BOB])).toEqual([]);
    const [stats] = await db.rows<{ counters: Record<string, number> }>('select counters from online_stats where user_id = $1', [ALICE]);
    expect(stats.counters).toEqual({ hands: 1, biggestPotWon: 400 });
  });
});

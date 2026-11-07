/**
 * The trusted online game server. It runs inside the Supabase Edge Function and is
 * the only code that deals cards or decides who wins chips. It reuses the same
 * engine as offline play.
 *
 * It is stateless: each request loads the room, rebuilds the current hand by
 * replaying the stored deck order and action list through the engine, applies the
 * new action, and writes the result back with `room_commit`. That write only lands
 * if nobody changed the room in between, so concurrent requests can never both apply.
 */
import { Deck } from '../../engine/deck';
import { Hand, type LegalActions, type PlayerAction } from '../../engine/hand';
import { CryptoRng, type Rng, SeededRng } from '../../engine/rng';
import { buildHandRecord } from '../../history/record';
import { extractHandStats } from '../../stats/counters';
import { type ClientRequest, type PublicTable, ROOM_CODE_ALPHABET } from '../protocol';
import { flattenCounters } from '../statsCodec';

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ServerDeps {
  rpc: Rpc;
  now(): number;
  rng?: Rng;
}

export class GameError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

interface RoomRow {
  id: string;
  code: string;
  host_id: string;
  name: string;
  small_blind: number;
  big_blind: number;
  min_buyin: number;
  max_buyin: number;
  max_seats: number;
  action_seconds: number;
  status: string;
}

interface StateRow {
  version: number;
  hand_no: number;
  button_seat: number | null;
  hand_active: boolean;
  public: PublicTable | Record<string, never>;
  next_hand_at: string | null;
}

interface StartSeat {
  seat: number;
  id: string;
  name: string;
  avatar: number;
  stack: number;
}

interface LoggedAction {
  seat: number;
  move: PlayerAction;
  auto?: 'timeout' | 'leaving';
}

interface SecretRow {
  hand_no: number;
  deck: number[] | null;
  start_seats: StartSeat[] | null;
  actions: LoggedAction[];
}

interface SeatRow {
  seat: number;
  user_id: string;
  stack: number;
  invested: number;
  status: 'active' | 'sitting_out' | 'leaving';
  missed_turns: number;
  username: string;
  display_name: string;
  avatar: number;
}

interface Loaded {
  room: RoomRow;
  state: StateRow;
  secret: SecretRow;
  seats: SeatRow[];
}

const SHOWDOWN_PAUSE_MS = 4500;
const HAND_PAUSE_MS = 2500;
/** A seat that times out this many times in a row is sat out until it returns. */
const MISSES_BEFORE_SIT_OUT = 2;
const TIMEOUT_GRACE_MS = 800;

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isRef = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Translates a database exception into a client-facing error code. */
function asGameError(error: unknown): GameError {
  if (error instanceof GameError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const known = message.match(/\b(insufficient_chips|duplicate_request|room_not_found|already_seated|room_full|buyin_out_of_range|buyin_too_small|not_seated|in_hand|version_conflict|not_bankrupt|chip_conservation_failed|seat_changed_during_hand)\b/);
  if (known) return new GameError(known[1], known[1] === 'version_conflict' ? 409 : 400);
  return new GameError('server_error', 500);
}

async function call(deps: ServerDeps, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await deps.rpc(name, args);
  } catch (error) {
    throw asGameError(error);
  }
}

async function load(deps: ServerDeps, roomId: string): Promise<Loaded> {
  const data = (await call(deps, 'room_load', { p_room: roomId })) as Loaded | null;
  if (!data?.room) throw new GameError('room_not_found', 404);
  data.secret.actions ??= [];
  data.room.small_blind = Number(data.room.small_blind);
  data.room.big_blind = Number(data.room.big_blind);
  data.state.version = Number(data.state.version);
  for (const s of data.seats) {
    s.stack = Number(s.stack);
    s.invested = Number(s.invested);
  }
  return data;
}

/** Rebuilds the hand exactly as it stands by replaying its stored deck and actions. */
function rebuild(data: Loaded): Hand {
  const { secret, state, room } = data;
  if (!secret.deck || !secret.start_seats || state.button_seat === null) throw new GameError('hand_not_active');
  const hand = new Hand({
    handNumber: secret.hand_no,
    players: secret.start_seats.map((s) => ({ seat: s.seat, id: s.id, name: s.name, stack: s.stack })),
    buttonSeat: state.button_seat,
    smallBlind: room.small_blind,
    bigBlind: room.big_blind,
    deck: Deck.stacked(secret.deck.map(Number), new SeededRng(0)),
  });
  for (const a of secret.actions) {
    const result = hand.act(a.seat, a.move);
    if (!result.ok) throw new GameError('server_error', 500);
  }
  return hand;
}

function publicTable(data: Loaded, hand: Hand | null, startSeats: StartSeat[], now: number, nextHandAt: number | null): PublicTable {
  const actorSeat = hand && !hand.isComplete ? hand.actorSeat : null;
  const actor = actorSeat === null ? undefined : hand!.playerAt(actorSeat);
  let summary: string | null = null;
  if (hand?.result) {
    const names = new Map(startSeats.map((s) => [s.seat, s.name]));
    summary = hand.result.pots.flatMap((p) => p.winners.map((w) => `${names.get(w.seat)} wins ${w.amount.toLocaleString('en-US')}`)).join(', ');
  }
  return {
    handNo: data.secret.hand_no,
    handActive: Boolean(hand && !hand.isComplete),
    buttonSeat: hand ? hand.buttonSeat : data.state.button_seat,
    smallBlind: data.room.small_blind,
    bigBlind: data.room.big_blind,
    startSeats: startSeats.map((s) => ({ seat: s.seat, userId: s.id, name: s.name, avatar: s.avatar, stack: s.stack })),
    events: hand ? hand.events.map((e) => e) : [],
    actorSeat,
    actorUserId: actor ? actor.id : null,
    deadline: actorSeat === null ? null : now + data.room.action_seconds * 1000,
    actionSeconds: data.room.action_seconds,
    legal: actorSeat === null ? null : (hand!.legalActions(actorSeat) as LegalActions),
    nextHandAt,
    summary,
  };
}

/** Removes every hole card that was not shown before a hand is stored for its players. */
function redactedRecord(hand: Hand, data: Loaded, now: number) {
  const record = buildHandRecord(hand, {
    id: `${data.room.id}:${hand.handNumber}`,
    sessionId: data.room.id,
    tableId: data.room.id,
    tableName: data.room.name,
    mode: 'cash',
    maxSeats: data.room.max_seats,
    heroId: null,
    now,
  });
  for (const p of record.players) if (!p.shown) p.hole = [-1, -1];
  return record;
}

/**
 * After a real action, seats that asked to leave fold or check automatically
 * whenever it is their turn, so the hand never waits on someone who has gone.
 */
function playOutLeavers(hand: Hand, data: Loaded, log: LoggedAction[]): void {
  const leaving = new Set(data.seats.filter((s) => s.status === 'leaving').map((s) => s.seat));
  for (let guard = 0; guard < 50 && !hand.isComplete; guard++) {
    const seat = hand.actorSeat;
    if (seat === null || !leaving.has(seat)) return;
    const legal = hand.legalActions(seat)!;
    const move: PlayerAction = legal.canCheck ? { type: 'check' } : { type: 'fold' };
    hand.act(seat, move);
    log.push({ seat, move, auto: 'leaving' });
  }
}

/** Writes the hand's new position, settling chips if it has ended. */
async function commitHand(deps: ServerDeps, data: Loaded, hand: Hand, actions: LoggedAction[], seatUpdates: Array<Record<string, unknown>> | null): Promise<{ version: number }> {
  const now = deps.now();
  const startSeats = data.secret.start_seats!;
  let settle: Record<string, unknown> | null = null;
  let nextHandAt: number | null = null;
  if (hand.isComplete) {
    const result = hand.result!;
    nextHandAt = now + (result.wentToShowdown ? SHOWDOWN_PAUSE_MS : HAND_PAUSE_MS);
    const record = redactedRecord(hand, data, now);
    const stats = [...extractHandStats(record)].map(([userId, delta]) => ({ user_id: userId, delta: flattenCounters(delta) }));
    settle = {
      stacks: startSeats.map((s) => ({ seat: s.seat, user_id: s.id, stack: result.finalStacks[s.seat] })),
      record,
      stats,
    };
  }
  const version = (await call(deps, 'room_commit', {
    p_room: data.room.id,
    p_version: data.state.version,
    p_public: publicTable(data, hand, startSeats, now, nextHandAt),
    p_hand_active: !hand.isComplete,
    p_hand_no: data.secret.hand_no,
    p_button: hand.buttonSeat,
    p_next_hand_at: nextHandAt === null ? null : new Date(nextHandAt).toISOString(),
    p_secret: { actions },
    p_private: null,
    p_seat_updates: seatUpdates,
    p_settle: settle,
  })) as number;
  return { version: Number(version) };
}

function nextButton(previous: number | null, eligible: number[], maxSeats: number): number {
  if (previous === null) return eligible[0];
  for (let i = 1; i <= maxSeats; i++) {
    const seat = (previous + i) % maxSeats;
    if (eligible.includes(seat)) return seat;
  }
  return eligible[0];
}

async function startHand(deps: ServerDeps, userId: string, roomId: string): Promise<unknown> {
  const data = await load(deps, roomId);
  if (!data.seats.some((s) => s.user_id === userId)) throw new GameError('not_seated', 403);
  if (data.state.hand_active) throw new GameError('hand_already_active', 409);
  const now = deps.now();
  if (data.state.next_hand_at && now < Date.parse(data.state.next_hand_at)) throw new GameError('too_early', 409);
  const eligible = data.seats.filter((s) => s.status === 'active' && s.stack > 0);
  if (eligible.length < 2) throw new GameError('not_enough_players', 409);

  const rng = deps.rng ?? new CryptoRng();
  const order = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const button = nextButton(data.state.button_seat, eligible.map((s) => s.seat).sort((a, b) => a - b), data.room.max_seats);
  const handNo = data.state.hand_no + 1;
  const startSeats: StartSeat[] = eligible.map((s) => ({ seat: s.seat, id: s.user_id, name: s.display_name || s.username, avatar: s.avatar, stack: s.stack }));
  data.secret = { hand_no: handNo, deck: order, start_seats: startSeats, actions: [] };
  data.state.button_seat = button;
  const hand = rebuild(data);
  const log: LoggedAction[] = [];
  playOutLeavers(hand, data, log);

  const settleNow = hand.isComplete;
  const nextHandAt = settleNow ? now + SHOWDOWN_PAUSE_MS : null;
  let settle: Record<string, unknown> | null = null;
  if (settleNow) {
    const result = hand.result!;
    const record = redactedRecord(hand, data, now);
    settle = {
      stacks: startSeats.map((s) => ({ seat: s.seat, user_id: s.id, stack: result.finalStacks[s.seat] })),
      record,
      stats: [...extractHandStats(record)].map(([id, delta]) => ({ user_id: id, delta: flattenCounters(delta) })),
    };
  }
  const version = await call(deps, 'room_commit', {
    p_room: roomId,
    p_version: data.state.version,
    p_public: publicTable(data, hand, startSeats, now, nextHandAt),
    p_hand_active: !settleNow,
    p_hand_no: handNo,
    p_button: button,
    p_next_hand_at: nextHandAt === null ? null : new Date(nextHandAt).toISOString(),
    p_secret: { hand_no: handNo, deck: order, start_seats: startSeats, actions: log },
    p_private: hand.players.map((p) => ({ user_id: p.id, cards: [p.hole[0], p.hole[1]] })),
    p_seat_updates: null,
    p_settle: settle,
  });
  return { handNo, version: Number(version) };
}

async function act(deps: ServerDeps, userId: string, roomId: string, handNo: number, move: PlayerAction): Promise<unknown> {
  const data = await load(deps, roomId);
  if (!data.state.hand_active) throw new GameError('hand_not_active', 409);
  if (data.secret.hand_no !== handNo) throw new GameError('stale_hand', 409);
  const hand = rebuild(data);
  const seat = hand.actorSeat;
  if (seat === null || hand.playerAt(seat)!.id !== userId) throw new GameError('not_your_turn', 409);
  const result = hand.act(seat, move);
  if (!result.ok) throw new GameError('illegal_action');
  const log = [...data.secret.actions, { seat, move }];
  playOutLeavers(hand, data, log);
  const me = data.seats.find((s) => s.seat === seat)!;
  const seatUpdates = me.missed_turns > 0 ? [{ seat, missed_turns: 0 }] : null;
  return commitHand(deps, data, hand, log, seatUpdates);
}

async function timeout(deps: ServerDeps, userId: string, roomId: string, handNo: number): Promise<unknown> {
  const data = await load(deps, roomId);
  if (!data.seats.some((s) => s.user_id === userId)) throw new GameError('not_seated', 403);
  if (!data.state.hand_active) throw new GameError('hand_not_active', 409);
  if (data.secret.hand_no !== handNo) throw new GameError('stale_hand', 409);
  const deadline = (data.state.public as PublicTable).deadline;
  if (deadline === null || deps.now() < deadline + TIMEOUT_GRACE_MS) throw new GameError('too_early', 409);
  const hand = rebuild(data);
  const seat = hand.actorSeat!;
  const legal = hand.legalActions(seat)!;
  const move: PlayerAction = legal.canCheck ? { type: 'check' } : { type: 'fold' };
  hand.act(seat, move);
  const log: LoggedAction[] = [...data.secret.actions, { seat, move, auto: 'timeout' }];
  playOutLeavers(hand, data, log);
  const seatRow = data.seats.find((s) => s.seat === seat)!;
  const misses = seatRow.missed_turns + 1;
  const update: Record<string, unknown> = { seat, missed_turns: misses };
  if (misses >= MISSES_BEFORE_SIT_OUT) update.status = 'sitting_out';
  return commitHand(deps, data, hand, log, [update]);
}

/** After someone leaves mid-hand, fold them out at once if it is their turn. */
async function settleLeaverTurn(deps: ServerDeps, roomId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await load(deps, roomId);
    if (!data.state.hand_active) return;
    const hand = rebuild(data);
    const log = [...data.secret.actions];
    const before = log.length;
    playOutLeavers(hand, data, log);
    if (log.length === before) return;
    try {
      await commitHand(deps, data, hand, log, null);
      return;
    } catch (error) {
      if (!(error instanceof GameError && error.code === 'version_conflict')) throw error;
    }
  }
}

function newCode(rng: Rng): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += ROOM_CODE_ALPHABET[rng.int(ROOM_CODE_ALPHABET.length)];
  return code;
}

/** Entry point for every request from a signed-in player. */
export async function handleRequest(userId: string, body: unknown, deps: ServerDeps): Promise<unknown> {
  if (!isUuid(userId)) throw new GameError('not_signed_in', 401);
  if (typeof body !== 'object' || body === null) throw new GameError('bad_request');
  const req = body as ClientRequest;
  switch (req.action) {
    case 'create_room': {
      const { smallBlind: sb, bigBlind: bb, minBuyIn: min, maxBuyIn: max, maxSeats, actionSeconds, buyIn, ref } = req;
      const name = typeof req.name === 'string' ? req.name.trim().slice(0, 40) : '';
      if (!name || !isInt(sb, 1, 1_000_000) || !isInt(bb, sb, 2_000_000) || !isInt(min, Math.max(400, bb * 10), 1e12) || !isInt(max, min, bb * 1000)) throw new GameError('bad_request');
      if (!isInt(maxSeats, 2, 9) || !isInt(actionSeconds, 10, 120) || !isInt(buyIn, min, max) || !isRef(ref)) throw new GameError('bad_request');
      const rng = deps.rng ?? new CryptoRng();
      let roomId: string | null = null;
      let code = '';
      for (let attempt = 0; attempt < 6 && !roomId; attempt++) {
        code = newCode(rng);
        try {
          roomId = (await deps.rpc('room_create', { p_host: userId, p_code: code, p_name: name, p_sb: sb, p_bb: bb, p_min: min, p_max: max, p_seats: maxSeats, p_action_seconds: actionSeconds })) as string;
        } catch (error) {
          if (!/unique|duplicate/i.test(String(error instanceof Error ? error.message : error))) throw asGameError(error);
        }
      }
      if (!roomId) throw new GameError('server_error', 500);
      const seat = await call(deps, 'room_join', { p_room: roomId, p_user: userId, p_amount: buyIn, p_ref: `buyin-${ref}` });
      return { roomId, code, seat };
    }
    case 'join_room': {
      if (typeof req.code !== 'string' || !/^[A-Za-z2-9]{6}$/.test(req.code) || !isInt(req.buyIn, 1, 1e12) || !isRef(req.ref)) throw new GameError('bad_request');
      const roomId = (await call(deps, 'room_find', { p_code: req.code.toUpperCase() })) as string | null;
      if (!roomId) throw new GameError('room_not_found', 404);
      const seat = await call(deps, 'room_join', { p_room: roomId, p_user: userId, p_amount: req.buyIn, p_ref: `buyin-${req.ref}` });
      return { roomId, seat };
    }
    case 'leave_room': {
      if (!isUuid(req.roomId) || !isRef(req.ref)) throw new GameError('bad_request');
      const status = await call(deps, 'room_leave', { p_room: req.roomId, p_user: userId, p_ref: `cashout-${req.ref}` });
      if (status === 'leaving') await settleLeaverTurn(deps, req.roomId);
      return { status };
    }
    case 'top_up': {
      if (!isUuid(req.roomId) || !isInt(req.amount, 1, 1e12) || !isRef(req.ref)) throw new GameError('bad_request');
      const stack = await call(deps, 'room_topup', { p_room: req.roomId, p_user: userId, p_amount: req.amount, p_ref: `topup-${req.ref}` });
      return { stack: Number(stack) };
    }
    case 'sit_out':
    case 'sit_in': {
      if (!isUuid(req.roomId)) throw new GameError('bad_request');
      await call(deps, 'room_set_status', { p_room: req.roomId, p_user: userId, p_status: req.action === 'sit_out' ? 'sitting_out' : 'active' });
      return { ok: true };
    }
    case 'start_hand':
      if (!isUuid(req.roomId)) throw new GameError('bad_request');
      return startHand(deps, userId, req.roomId);
    case 'act': {
      if (!isUuid(req.roomId) || !isInt(req.handNo, 1, 1e9) || !isMove(req.move)) throw new GameError('bad_request');
      return act(deps, userId, req.roomId, req.handNo, req.move);
    }
    case 'timeout':
      if (!isUuid(req.roomId) || !isInt(req.handNo, 1, 1e9)) throw new GameError('bad_request');
      return timeout(deps, userId, req.roomId, req.handNo);
    default:
      throw new GameError('bad_request');
  }
}

function isMove(m: unknown): m is PlayerAction {
  if (typeof m !== 'object' || m === null) return false;
  const move = m as Record<string, unknown>;
  switch (move.type) {
    case 'fold':
    case 'check':
    case 'call':
    case 'allin':
      return Object.keys(move).length === 1;
    case 'bet':
    case 'raise':
      return isInt(move.to, 1, 1e12) && Object.keys(move).length === 2;
    default:
      return false;
  }
}

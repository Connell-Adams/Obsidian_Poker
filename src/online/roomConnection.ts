import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Card } from '../engine/cards';
import type { PlayerAction } from '../engine/hand';
import { applyEvent, emptySeatView, type SeatView, type TableView, type ViewContext } from '../session/tableView';
import { OnlineError, type OnlineService, requestRef } from './onlineService';
import type { PublicTable } from './protocol';

export interface RoomInfo {
  id: string;
  code: string;
  name: string;
  host_id: string;
  small_blind: number;
  big_blind: number;
  min_buyin: number;
  max_buyin: number;
  max_seats: number;
  action_seconds: number;
}

export interface SeatInfo {
  seat: number;
  user_id: string;
  stack: number;
  status: 'active' | 'sitting_out' | 'leaving';
  name: string;
  avatar: number;
}

/** Builds the same TableView offline play uses, from the public table plus the viewer's own cards. */
export function buildOnlineView(room: RoomInfo, pub: PublicTable | null, seats: SeatInfo[], myId: string, myCards: [Card, Card] | null, now: number): TableView {
  const mySeat = seats.find((s) => s.user_id === myId)?.seat ?? null;
  const seatViews: Array<SeatView | null> = new Array(room.max_seats).fill(null);
  const inHand = new Set(pub?.startSeats.map((s) => s.seat) ?? []);
  for (const s of pub?.startSeats ?? []) {
    seatViews[s.seat] = emptySeatView({ seat: s.seat, id: s.userId, name: s.name, isHuman: s.userId === myId, avatar: s.avatar, stack: s.stack });
  }
  let view: TableView = {
    tableId: room.id,
    tableName: room.name,
    maxSeats: room.max_seats,
    heroSeat: mySeat,
    handNumber: pub?.handNo ?? 0,
    smallBlind: room.small_blind,
    bigBlind: room.big_blind,
    ante: 0,
    street: 'preflop',
    board: [],
    pot: 0,
    potTotal: 0,
    buttonSeat: pub?.buttonSeat ?? null,
    sbSeat: null,
    bbSeat: null,
    seats: seatViews,
    actorSeat: null,
    phase: 'waiting',
    deadline: null,
    clockTotal: room.action_seconds * 1000,
    legal: null,
    preAction: null,
    preActionNote: null,
    timeBank: 0,
    timeBankActive: false,
    burnCount: 0,
    muckCount: 0,
    dealKey: 0,
    collectKey: 0,
    awardKey: 0,
    chat: [],
    banner: null,
    lastHandSummary: pub?.summary ?? null,
    winners: [],
    isHeroInHand: mySeat !== null && inHand.has(mySeat),
    leaveRequested: false,
    needsRebuy: false,
  };
  let key = 1;
  const positions = new Map<number, string>();
  const ctx = (): ViewContext => ({
    ownCards: (seat, index) => (seat === mySeat && myCards ? myCards[index] : null),
    positionOf: (seat) => positions.get(seat) ?? null,
    actionKey: key++,
  });
  for (const e of pub?.events ?? []) view = applyEvent(view, e, ctx());

  // Players seated outside the hand: just joined, sitting out, or between hands.
  // Between hands, anyone who has left since the last hand is cleared from the table.
  const seatedIds = new Set(seats.map((s) => s.user_id));
  const seatsOut = view.seats.map((v) => (v && !pub?.handActive && !seatedIds.has(v.id) ? null : v));
  for (const s of seats) {
    if (seatsOut[s.seat] && inHand.has(s.seat) && pub?.handActive) continue;
    const base = seatsOut[s.seat] ?? emptySeatView({ seat: s.seat, id: s.user_id, name: s.name, isHuman: s.user_id === myId, avatar: s.avatar, stack: s.stack });
    seatsOut[s.seat] = { ...base, stack: s.stack, name: s.name, sittingOut: s.status !== 'active', id: s.user_id, isHuman: s.user_id === myId };
  }
  view = { ...view, seats: seatsOut };

  if (pub?.handActive && pub.actorSeat !== null) {
    const mine = pub.actorUserId === myId;
    view = { ...view, actorSeat: pub.actorSeat, deadline: pub.deadline, clockTotal: pub.actionSeconds * 1000, phase: mine ? 'hero_turn' : 'bot_thinking', legal: mine ? pub.legal : null };
  } else if (pub && !pub.handActive && pub.events.length > 0) {
    view = { ...view, phase: 'hand_over' };
  }
  void now;
  return view;
}

/**
 * One open room: keeps a live copy of the table through Realtime, with polling as a
 * fallback, sends the player's moves to the server, and nudges the server when a
 * clock runs out or the next hand is due. It never decides an outcome itself.
 */
export class RoomConnection {
  room: RoomInfo | null = null;
  pub: PublicTable | null = null;
  seats: SeatInfo[] = [];
  myCards: [Card, Card] | null = null;
  connected: string[] = [];
  error: string | null = null;
  closed = false;
  /** Called once when the player no longer has a seat here, so the screen can return to the lobby. */
  onGone: (() => void) | null = null;
  private view: TableView | null = null;
  private listeners = new Set<() => void>();
  private channel: RealtimeChannel | null = null;
  private presence: RealtimeChannel | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private cardsForHand = -1;
  private nudgeAt = 0;

  constructor(
    readonly online: OnlineService,
    readonly roomId: string,
  ) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getView = (): TableView | null => this.view;

  private emit(): void {
    const myId = this.online.session?.user.id ?? '';
    this.view = this.room ? buildOnlineView(this.room, this.pub, this.seats, myId, this.myCards, Date.now()) : null;
    for (const l of this.listeners) l();
  }

  async open(): Promise<void> {
    const c = this.online.client;
    if (!c) throw new OnlineError('not_configured');
    await this.refresh();
    this.channel = c
      .channel(`room-${this.roomId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_state', filter: `room_id=eq.${this.roomId}` }, () => void this.refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_seats', filter: `room_id=eq.${this.roomId}` }, () => void this.refresh())
      .subscribe((status) => {
        // After a dropped connection comes back, catch up on anything missed.
        if (status === 'SUBSCRIBED') void this.refresh();
      });
    const me = this.online.profile;
    this.presence = c.channel(`presence-${this.roomId}`, { config: { presence: { key: this.online.session?.user.id ?? 'anon' } } });
    this.presence
      .on('presence', { event: 'sync' }, () => {
        this.connected = Object.keys(this.presence?.presenceState() ?? {});
        this.emit();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void this.presence?.track({ name: me?.display_name ?? 'Player' });
      });
    this.ticker = setInterval(() => this.tick(), 1000);
    // Realtime is the main path. Polling covers any missed message after a network blip.
    this.poller = setInterval(() => void this.refresh(), 6000);
    window.addEventListener('online', this.onOnline);
  }

  private onOnline = (): void => void this.refresh();

  close(): void {
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.poller) clearInterval(this.poller);
    window.removeEventListener('online', this.onOnline);
    void this.channel?.unsubscribe();
    void this.presence?.unsubscribe();
    this.listeners.clear();
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.load().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async load(): Promise<void> {
    const c = this.online.client;
    const uid = this.online.session?.user.id;
    if (!c || !uid || this.closed) return;
    const [room, state, seats] = await Promise.all([
      c.from('rooms').select('id, code, name, host_id, small_blind, big_blind, min_buyin, max_buyin, max_seats, action_seconds').eq('id', this.roomId).maybeSingle(),
      c.from('room_state').select('public, version').eq('room_id', this.roomId).maybeSingle(),
      c.from('room_seats').select('seat, user_id, stack, status, profiles(display_name, username, avatar)').eq('room_id', this.roomId).order('seat'),
    ]);
    if (room.error || state.error || seats.error) {
      this.error = 'Could not load the table. Retrying…';
      this.emit();
      return;
    }
    // Not seated any more: the room is gone, or we left it. A host can still read a
    // room they created after leaving it, so having a seat is what counts.
    const seated = ((seats.data ?? []) as Array<Record<string, unknown>>).some((s) => String(s.user_id) === uid);
    if (!room.data || !seated) {
      this.error = null;
      this.room = null;
      this.closed = true;
      this.emit();
      this.onGone?.();
      return;
    }
    const r = room.data as Record<string, unknown>;
    this.room = { ...(r as unknown as RoomInfo), small_blind: Number(r.small_blind), big_blind: Number(r.big_blind), min_buyin: Number(r.min_buyin), max_buyin: Number(r.max_buyin) };
    const pub = state.data?.public as PublicTable | undefined;
    this.pub = pub && typeof pub.handNo === 'number' ? pub : null;
    this.seats = ((seats.data ?? []) as Array<Record<string, unknown>>).map((s) => {
      const p = (Array.isArray(s.profiles) ? s.profiles[0] : s.profiles) as { display_name?: string; username?: string; avatar?: number } | null;
      return { seat: Number(s.seat), user_id: String(s.user_id), stack: Number(s.stack), status: s.status as SeatInfo['status'], name: p?.display_name || p?.username || 'Player', avatar: Number(p?.avatar ?? 0) };
    });
    if (this.pub && this.pub.handNo !== this.cardsForHand) {
      const { data } = await c.from('hand_private').select('cards').eq('room_id', this.roomId).eq('hand_no', this.pub.handNo).eq('user_id', uid).maybeSingle();
      this.myCards = data?.cards ? [Number(data.cards[0]), Number(data.cards[1])] : null;
      this.cardsForHand = this.pub.handNo;
    }
    this.error = null;
    this.emit();
  }

  /** Clients only ever ask the server to check the clock or deal. The server decides. */
  private tick(): void {
    const pub = this.pub;
    const uid = this.online.session?.user.id;
    if (!pub && this.seats.filter((s) => s.status === 'active' && s.stack > 0).length >= 2) {
      this.nudge({ action: 'start_hand', roomId: this.roomId });
      return;
    }
    if (!pub || !uid || !this.seats.some((s) => s.user_id === uid)) return;
    const now = Date.now();
    if (pub.handActive && pub.deadline !== null && now > pub.deadline + 1500) {
      this.nudge({ action: 'timeout', roomId: this.roomId, handNo: pub.handNo });
    } else if (!pub.handActive && (pub.nextHandAt === null || now > pub.nextHandAt + 300 + Math.random() * 700)) {
      if (this.seats.filter((s) => s.status === 'active' && s.stack > 0).length >= 2) this.nudge({ action: 'start_hand', roomId: this.roomId });
    }
  }

  private nudge(body: Parameters<OnlineService['request']>[0]): void {
    const now = Date.now();
    if (now < this.nudgeAt) return;
    this.nudgeAt = now + 2500;
    // Another player may well get there first. Those refusals are expected and ignored.
    this.online.request(body).then(() => this.refresh(), () => this.refresh());
  }

  // ------------------------------------------------------------ player actions

  /** Matches the interface the betting controls use for offline tables. */
  heroAct = (move: PlayerAction): boolean => {
    const pub = this.pub;
    if (!pub || !pub.handActive || pub.actorUserId !== this.online.session?.user.id) return false;
    // Hide the controls at once; the server's answer arrives through Realtime.
    this.pub = { ...pub, legal: null, actorUserId: null };
    this.emit();
    this.online
      .request({ action: 'act', roomId: this.roomId, handNo: pub.handNo, move })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => void this.refresh());
    return true;
  };

  /** Online tables have no time bank: everyone gets the same clock. */
  useTimeBank = (): boolean => false;

  async leave(): Promise<string> {
    const result = await this.online.request<{ status: string }>({ action: 'leave_room', roomId: this.roomId, ref: requestRef() });
    await this.refresh();
    await this.online.refresh();
    return result.status;
  }

  async topUp(amount: number): Promise<void> {
    await this.online.request({ action: 'top_up', roomId: this.roomId, amount, ref: requestRef() });
    await this.refresh();
    await this.online.refresh();
  }

  async setSittingOut(out: boolean): Promise<void> {
    await this.online.request({ action: out ? 'sit_out' : 'sit_in', roomId: this.roomId });
    await this.refresh();
  }
}

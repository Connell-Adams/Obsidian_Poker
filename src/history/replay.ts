import type { Card } from '../engine/cards';
import type { HandEvent } from '../engine/hand';
import { applyEvent, emptySeatView, type SeatView, type TableView, type ViewContext } from '../session/tableView';
import type { HandRecord } from './record';

export interface ReplayFrame {
  view: TableView;
  /** What happened to reach this frame, in words. */
  caption: string;
  street: string;
  kind: 'start' | 'action' | 'board' | 'showdown' | 'award';
  /** Index into the event list, used to attach coach notes to the right frame. */
  eventIndex: number;
}

function initialView(record: HandRecord): TableView {
  const seats: Array<SeatView | null> = new Array(record.maxSeats).fill(null);
  for (const p of record.players) {
    seats[p.seat] = emptySeatView({ seat: p.seat, id: p.id, name: p.name, isHuman: p.isHuman, avatar: avatarIndex(p.id), stack: p.startStack });
  }
  return {
    tableId: record.tableId,
    tableName: record.tableName,
    maxSeats: record.maxSeats,
    heroSeat: record.heroSeat,
    handNumber: record.handNumber,
    smallBlind: record.sb,
    bigBlind: record.bb,
    ante: record.ante,
    street: 'preflop',
    board: [],
    pot: 0,
    potTotal: 0,
    buttonSeat: record.buttonSeat,
    sbSeat: record.sbSeat,
    bbSeat: record.bbSeat,
    seats,
    actorSeat: null,
    phase: 'presenting',
    deadline: null,
    clockTotal: 1,
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
    lastHandSummary: null,
    winners: [],
    isHeroInHand: record.heroSeat !== null,
    leaveRequested: false,
    needsRebuy: false,
  };
}

function avatarIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 16;
}

function caption(record: HandRecord, e: HandEvent): string | null {
  const name = (seat: number) => (seat === record.heroSeat ? 'You' : (record.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat}`));
  /** "You fold" but "Mira folds". */
  const verb = (seat: number, word: string) => (seat === record.heroSeat ? word : word.endsWith('sh') ? `${word}es` : `${word}s`);
  switch (e.t) {
    case 'action': {
      const allIn = e.allIn && e.action !== 'fold' ? ' (all-in)' : '';
      if (e.action === 'fold') return `${name(e.seat)} ${verb(e.seat, 'fold')}`;
      if (e.action === 'check') return `${name(e.seat)} ${verb(e.seat, 'check')}`;
      if (e.action === 'call') return `${name(e.seat)} ${verb(e.seat, 'call')} ${e.added.toLocaleString()}${allIn}`;
      if (e.action === 'bet') return `${name(e.seat)} ${verb(e.seat, 'bet')} ${e.to.toLocaleString()}${allIn}`;
      return `${name(e.seat)} ${verb(e.seat, 'raise')} to ${e.to.toLocaleString()}${allIn}`;
    }
    case 'board':
      return e.street === 'flop' ? 'Flop' : e.street === 'turn' ? 'Turn' : 'River';
    case 'uncalled':
      return `${e.amount.toLocaleString()} uncalled returned to ${e.seat === record.heroSeat ? 'you' : name(e.seat)}`;
    case 'allin_reveal':
      return 'Betting is closed: hands turned face up';
    case 'show':
      return `${name(e.seat)} ${verb(e.seat, 'show')} ${e.description}`;
    case 'muck':
      return `${name(e.seat)} ${verb(e.seat, 'muck')}`;
    case 'award': {
      const label = e.potCount > 1 ? (e.potIndex === 0 ? 'the main pot' : `side pot ${e.potIndex}`) : 'the pot';
      return `${name(e.seat)} ${verb(e.seat, 'win')} ${e.amount.toLocaleString()} from ${label}${e.description ? ` with ${e.description}` : ''}`;
    }
    default:
      return null;
  }
}

/**
 * Turns a hand record into step-by-step frames, using the same reducer as live play.
 * Opponent cards appear only where the record's public events reveal them.
 */
export function buildReplayFrames(record: HandRecord): ReplayFrame[] {
  const hero = record.players.find((p) => p.seat === record.heroSeat);
  const positions = new Map(record.players.map((p) => [p.seat, p.position]));
  let view = initialView(record);
  let actionKey = 1;
  const context = (): ViewContext => ({
    ownCards: (seat, index) => (hero && seat === hero.seat ? (hero.hole[index] as Card) : null),
    positionOf: (seat) => positions.get(seat) ?? null,
    actionKey: actionKey++,
  });

  const frames: ReplayFrame[] = [];
  record.events.forEach((e, index) => {
    view = applyEvent(view, e, context());
    if (e.t === 'deal_hole') {
      const last = record.events[index + 1];
      if (!last || last.t !== 'deal_hole') {
        frames.push({ view, caption: `Hand #${record.handNumber}: blinds ${record.sb}/${record.bb}. Cards are dealt.`, street: 'Preflop', kind: 'start', eventIndex: index });
      }
      return;
    }
    const text = caption(record, e);
    if (!text) return;
    const street = view.street === 'showdown' ? 'Showdown' : view.street[0].toUpperCase() + view.street.slice(1);
    const kind: ReplayFrame['kind'] = e.t === 'action' ? 'action' : e.t === 'board' ? 'board' : e.t === 'award' ? 'award' : e.t === 'show' || e.t === 'muck' || e.t === 'allin_reveal' ? 'showdown' : 'action';
    frames.push({ view, caption: text, street, kind, eventIndex: index });
  });
  return frames;
}

export type HistoryFilter = 'all' | 'biggest_pots' | 'biggest_losses' | 'all_in' | 'showdowns' | 'won' | 'lost';

export interface HistoryQuery {
  filter: HistoryFilter;
  opponent?: string;
  position?: string;
  tableName?: string;
}

/** Filters and sorts stored hands for the history screen. */
export function filterHands(hands: readonly HandRecord[], query: HistoryQuery): HandRecord[] {
  let out = hands.filter((h) => {
    if (query.opponent && !h.players.some((p) => !p.isHuman && p.name === query.opponent)) return false;
    if (query.tableName && h.tableName !== query.tableName) return false;
    if (query.position) {
      const hero = h.players.find((p) => p.seat === h.heroSeat);
      if (hero?.position !== query.position) return false;
    }
    switch (query.filter) {
      case 'all_in':
        return h.allInRunout || h.events.some((e) => e.t === 'action' && e.seat === h.heroSeat && e.allIn);
      case 'showdowns':
        return h.wentToShowdown;
      case 'won':
        return h.heroNet > 0;
      case 'lost':
      case 'biggest_losses':
        return h.heroNet < 0;
      default:
        return true;
    }
  });
  if (query.filter === 'biggest_pots') out = [...out].sort((a, b) => b.totalPot / b.bb - a.totalPot / a.bb);
  else if (query.filter === 'biggest_losses') out = [...out].sort((a, b) => a.heroNet / a.bb - b.heroNet / b.bb);
  else out = [...out].sort((a, b) => b.ts - a.ts);
  return out;
}

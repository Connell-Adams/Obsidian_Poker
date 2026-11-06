import type { Card } from '../engine/cards';
import { categoryOf, scoreHand } from '../engine/evaluator';
import type { Hand, HandEvent, PotResult } from '../engine/hand';

export interface RecordedPlayer {
  seat: number;
  id: string;
  name: string;
  isHuman: boolean;
  position: string;
  startStack: number;
  finalStack: number;
  /** Actual cards. The UI and coach only read them when `shown` is true or the seat is the hero. */
  hole: [Card, Card];
  shown: boolean;
  folded: boolean;
  net: number;
}

export type GameMode = 'cash' | 'tournament';

export interface AllInEquity {
  seat: number;
  /** Exact equity when the money went in, cards known because all-in hands are revealed. */
  equity: number;
  /** Pot share the player's equity was entitled to, minus what they actually received. */
  evDiff: number;
}

export interface HandRecord {
  schema: 1;
  id: string;
  sessionId: string;
  tableId: string;
  tableName: string;
  mode: GameMode;
  tournamentId?: string;
  level?: number;
  handNumber: number;
  ts: number;
  sb: number;
  bb: number;
  ante: number;
  maxSeats: number;
  buttonSeat: number;
  sbSeat: number;
  bbSeat: number;
  players: RecordedPlayer[];
  heroSeat: number | null;
  events: HandEvent[];
  board: Card[];
  pots: PotResult[];
  totalPot: number;
  wentToShowdown: boolean;
  allInRunout: boolean;
  /** Seats that lost a big pot despite being ahead with one card to come. */
  badBeatSeats: number[];
  heroNet: number;
  allInEquity?: AllInEquity[];
}

export interface RecordMeta {
  id: string;
  sessionId: string;
  tableId: string;
  tableName: string;
  mode: GameMode;
  tournamentId?: string;
  level?: number;
  maxSeats: number;
  heroId: string | null;
  humanIds?: ReadonlySet<string>;
  now: number;
}

/**
 * Objective bad-beat test: the loser put in at least a quarter of their stack,
 * was ahead of the eventual winner on the turn and the river turned it around.
 */
function findBadBeats(hand: Hand): number[] {
  const result = hand.result;
  if (!result || !result.wentToShowdown || hand.board.length !== 5) return [];
  const main = result.pots[0];
  const winnerSeat = main.winners[0]?.seat;
  const winner = hand.playerAt(winnerSeat);
  if (!winner) return [];
  const turnBoard = hand.board.slice(0, 4);
  const winnerOnTurn = scoreHand([winner.hole[0], winner.hole[1], ...turnBoard]);
  const beats: number[] = [];
  for (const p of hand.players) {
    if (p.folded || p.seat === winnerSeat || result.net[p.seat] >= 0) continue;
    if (p.contributed < p.startStack * 0.25) continue;
    const onTurn = scoreHand([p.hole[0], p.hole[1], ...turnBoard]);
    const strongEnough = categoryOf(onTurn) >= 1;
    if (strongEnough && onTurn > winnerOnTurn) beats.push(p.seat);
  }
  return beats;
}

/** Freezes a completed hand into a plain, serialisable record. */
export function buildHandRecord(hand: Hand, meta: RecordMeta): HandRecord {
  const result = hand.result;
  if (!result) throw new Error('Cannot record an unfinished hand');
  const shown = new Set(result.shownSeats);
  const heroPlayer = meta.heroId ? hand.players.find((p) => p.id === meta.heroId) : undefined;
  const players: RecordedPlayer[] = hand.players.map((p) => ({
    seat: p.seat,
    id: p.id,
    name: p.name,
    isHuman: p.id === meta.heroId,
    position: p.position,
    startStack: p.startStack,
    finalStack: result.finalStacks[p.seat],
    hole: [p.hole[0], p.hole[1]],
    shown: shown.has(p.seat),
    folded: p.folded,
    net: result.net[p.seat],
  }));
  return {
    schema: 1,
    id: meta.id,
    sessionId: meta.sessionId,
    tableId: meta.tableId,
    tableName: meta.tableName,
    mode: meta.mode,
    tournamentId: meta.tournamentId,
    level: meta.level,
    handNumber: hand.handNumber,
    ts: meta.now,
    sb: hand.smallBlind,
    bb: hand.bigBlind,
    ante: hand.ante,
    maxSeats: meta.maxSeats,
    buttonSeat: hand.buttonSeat,
    sbSeat: hand.sbSeat,
    bbSeat: hand.bbSeat,
    players,
    heroSeat: heroPlayer ? heroPlayer.seat : null,
    events: hand.events.map((e) => e),
    board: [...hand.board],
    pots: result.pots,
    totalPot: result.pots.reduce((sum, pot) => sum + pot.amount, 0),
    wentToShowdown: result.wentToShowdown,
    allInRunout: result.allInRunout,
    badBeatSeats: findBadBeats(hand),
    heroNet: heroPlayer ? result.net[heroPlayer.seat] : 0,
  };
}

/** Everything the player may legitimately see about a seat's cards in this record. */
export function visibleHole(record: HandRecord, seat: number): [Card, Card] | null {
  const p = record.players.find((x) => x.seat === seat);
  if (!p) return null;
  return p.shown || seat === record.heroSeat ? p.hole : null;
}

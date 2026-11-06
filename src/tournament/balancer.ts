import type { Rng } from '../engine/rng';

export interface BalanceTable {
  id: string;
  maxSeats: number;
  buttonSeat: number;
  /** Player id per seat, null when empty. */
  seats: Array<string | null>;
}

export interface Move {
  playerId: string;
  fromTableId: string;
  fromSeat: number;
  toTableId: string;
  toSeat: number;
}

export interface BalancePlan {
  moves: Move[];
  closedTables: string[];
}

const countPlayers = (t: BalanceTable) => t.seats.filter(Boolean).length;

/** The next big blind: third occupied seat clockwise from the button (second when heads-up). */
function nextBigBlindSeat(table: BalanceTable): number {
  const n = table.seats.length;
  const occupied: number[] = [];
  for (let i = 1; i <= n; i++) {
    const seat = (table.buttonSeat + i) % n;
    if (table.seats[seat]) occupied.push(seat);
  }
  if (occupied.length === 0) throw new Error('Table is empty');
  return occupied[Math.min(2, occupied.length - 1)];
}

function emptySeats(table: BalanceTable): number[] {
  return table.seats.flatMap((s, i) => (s === null ? [i] : []));
}

/**
 * Plans the moves needed after eliminations, using standard procedure:
 *  1. Close the shortest table whenever the field fits on fewer tables.
 *  2. Move the upcoming big blind from the largest table to the smallest until
 *     no table has more than one extra player.
 * The input is not mutated. Seats are never double-booked and nobody is dropped.
 */
export function planBalance(input: readonly BalanceTable[], rng: Rng): BalancePlan {
  const tables = input.map((t) => ({ ...t, seats: [...t.seats] }));
  const moves: Move[] = [];
  const closedTables: string[] = [];
  const total = tables.reduce((sum, t) => sum + countPlayers(t), 0);
  if (total === 0) return { moves, closedTables };
  const maxSeats = Math.max(...tables.map((t) => t.maxSeats));
  const targetTables = Math.max(1, Math.ceil(total / maxSeats));

  const moveTo = (from: BalanceTable, seat: number, to: BalanceTable) => {
    const playerId = from.seats[seat];
    if (!playerId) throw new Error('Moving an empty seat');
    const free = emptySeats(to);
    if (free.length === 0) throw new Error(`Table ${to.id} has no free seat`);
    const toSeat = free[rng.int(free.length)];
    from.seats[seat] = null;
    to.seats[toSeat] = playerId;
    moves.push({ playerId, fromTableId: from.id, fromSeat: seat, toTableId: to.id, toSeat });
  };

  const open = [...tables];
  while (open.length > targetTables) {
    const closing = [...open].sort((a, b) => countPlayers(a) - countPlayers(b))[0];
    open.splice(open.indexOf(closing), 1);
    closedTables.push(closing.id);
    for (let seat = 0; seat < closing.seats.length; seat++) {
      if (!closing.seats[seat]) continue;
      const to = [...open].sort((a, b) => countPlayers(a) - countPlayers(b))[0];
      moveTo(closing, seat, to);
    }
  }

  for (let guard = 0; guard < 500; guard++) {
    const sorted = [...open].sort((a, b) => countPlayers(a) - countPlayers(b));
    const smallest = sorted[0];
    const largest = sorted[sorted.length - 1];
    if (countPlayers(largest) - countPlayers(smallest) <= 1) break;
    moveTo(largest, nextBigBlindSeat(largest), smallest);
  }
  return { moves, closedTables };
}

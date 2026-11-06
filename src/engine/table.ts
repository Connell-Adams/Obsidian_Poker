import { Deck } from './deck';
import { Hand } from './hand';
import type { Rng } from './rng';

export interface SeatedPlayer {
  id: string;
  name: string;
  stack: number;
  sittingOut?: boolean;
}

export interface TableOptions {
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  rng: Rng;
}

/**
 * A physical table: fixed seats, button and blinds rotation, and hand sequencing.
 * Every table owns its RNG, seats and current hand. No state is shared between tables.
 */
export class PokerTable {
  readonly maxSeats: number;
  readonly seats: Array<SeatedPlayer | null>;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  buttonSeat = -1;
  handCount = 0;
  currentHand: Hand | null = null;
  private readonly rng: Rng;

  constructor(options: TableOptions) {
    if (!Number.isInteger(options.maxSeats) || options.maxSeats < 2 || options.maxSeats > 9) {
      throw new Error('A table has between 2 and 9 seats');
    }
    this.maxSeats = options.maxSeats;
    this.seats = new Array(options.maxSeats).fill(null);
    this.smallBlind = options.smallBlind;
    this.bigBlind = options.bigBlind;
    this.ante = options.ante ?? 0;
    this.rng = options.rng;
  }

  sit(seat: number, player: SeatedPlayer): void {
    if (seat < 0 || seat >= this.maxSeats) throw new Error(`No seat ${seat} at this table`);
    if (this.seats[seat]) throw new Error(`Seat ${seat} is already taken`);
    if (this.seats.some((s) => s?.id === player.id)) throw new Error(`${player.name} is already seated here`);
    this.seats[seat] = player;
  }

  /** Removes a player between hands and returns them with their remaining chips. */
  leave(seat: number): SeatedPlayer {
    if (this.currentHand && !this.currentHand.isComplete) throw new Error('Cannot leave during a hand');
    const player = this.seats[seat];
    if (!player) throw new Error(`Seat ${seat} is empty`);
    this.seats[seat] = null;
    return player;
  }

  firstEmptySeat(): number {
    return this.seats.findIndex((s) => s === null);
  }

  get occupiedSeats(): number[] {
    return this.seats.flatMap((s, i) => (s ? [i] : []));
  }

  /** Seats that will be dealt in: seated, not sitting out, with chips. */
  get activeSeats(): number[] {
    return this.seats.flatMap((s, i) => (s && !s.sittingOut && s.stack > 0 ? [i] : []));
  }

  get canStartHand(): boolean {
    return this.activeSeats.length >= 2 && (!this.currentHand || this.currentHand.isComplete);
  }

  /** The next dealt-in seat clockwise from `from`, excluding `from` itself unless it is the only one. */
  private nextActiveSeat(from: number): number {
    const active = new Set(this.activeSeats);
    for (let i = 1; i <= this.maxSeats; i++) {
      const seat = (from + i) % this.maxSeats;
      if (active.has(seat)) return seat;
    }
    throw new Error('No active seats');
  }

  /** Rotates the button one active seat clockwise and starts the next hand. */
  startHand(deck?: Deck): Hand {
    if (this.currentHand && !this.currentHand.isComplete) throw new Error('The previous hand is still running');
    const active = this.activeSeats;
    if (active.length < 2) throw new Error('Not enough players to start a hand');
    this.buttonSeat = this.buttonSeat < 0 ? active[this.rng.int(active.length)] : this.nextActiveSeat(this.buttonSeat);
    this.handCount++;
    this.currentHand = new Hand({
      handNumber: this.handCount,
      players: active.map((seat) => {
        const s = this.seats[seat]!;
        return { seat, id: s.id, name: s.name, stack: s.stack };
      }),
      buttonSeat: this.buttonSeat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      ante: this.ante,
      deck: deck ?? Deck.shuffled(this.rng),
    });
    return this.currentHand;
  }

  /** Writes the finished hand's final stacks back to the seats, exactly once per hand. */
  settleHand(): void {
    const hand = this.currentHand;
    if (!hand?.result) throw new Error('No finished hand to settle');
    for (const p of hand.players) this.seats[p.seat]!.stack = hand.result.finalStacks[p.seat];
    this.currentHand = null;
  }

  get totalChips(): number {
    return this.seats.reduce((sum, s) => sum + (s?.stack ?? 0), 0);
  }
}

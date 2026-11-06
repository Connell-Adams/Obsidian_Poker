import type { Card } from './cards';
import type { Deck } from './deck';
import { type EvaluatedHand, evaluateHand } from './evaluator';
import { computePots, type Pot, splitPot } from './pots';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type BettingStreet = Exclude<Street, 'showdown'>;

export interface HandSeatInit {
  seat: number;
  id: string;
  name: string;
  stack: number;
}

export interface HandConfig {
  handNumber: number;
  /** Every player dealt in (stack > 0), in any order. */
  players: readonly HandSeatInit[];
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  deck: Deck;
}

export interface HandPlayer {
  seat: number;
  id: string;
  name: string;
  position: string;
  startStack: number;
  stack: number;
  hole: [Card, Card];
  /** Chips in front of the player this betting round. */
  streetBet: number;
  /** Total chips committed this hand, antes included. */
  contributed: number;
  folded: boolean;
  allIn: boolean;
  /** Has taken a voluntary action this betting round. Blinds do not count. */
  hasActed: boolean;
  /** The bet level the player last faced and responded to, used for the reopen rule. */
  matchedLevel: number;
}

export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'bet'; to: number }
  | { type: 'raise'; to: number }
  | { type: 'allin' };

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise';

export interface LegalActions {
  seat: number;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** Chips the call costs, already capped by the stack. */
  callAmount: number;
  callIsAllIn: boolean;
  /** True when opening the betting is legal (no live bet this round). */
  canBet: boolean;
  /** True when raising is legal. False after a short all-in that did not reopen the action. */
  canRaise: boolean;
  /** Smallest legal total street bet for a bet or raise. */
  minTo: number;
  /** Largest legal total street bet (the all-in amount). */
  maxTo: number;
  /** True when the only legal aggressive size is a short all-in below the normal minimum. */
  shortAllInOnly: boolean;
  /** True when moving all-in is legal (as a call, bet or raise). */
  canAllIn: boolean;
  /** Pot including all bets currently on the table. */
  pot: number;
  currentBet: number;
  streetBet: number;
  stack: number;
  bigBlind: number;
  lastRaiseSize: number;
}

export type HandEvent =
  | { t: 'hand_start'; handNumber: number; buttonSeat: number; sbSeat: number; bbSeat: number; smallBlind: number; bigBlind: number; ante: number }
  | { t: 'post'; seat: number; kind: 'ante' | 'sb' | 'bb'; amount: number; allIn: boolean }
  | { t: 'deal_hole'; seat: number; cardIndex: 0 | 1 }
  | { t: 'action'; seat: number; street: BettingStreet; action: ActionKind; added: number; to: number; allIn: boolean; pot: number; facing: number; potBefore: number }
  | { t: 'uncalled'; seat: number; amount: number }
  | { t: 'collect'; pot: number }
  | { t: 'burn'; street: BettingStreet }
  | { t: 'board'; street: BettingStreet; cards: Card[]; board: Card[] }
  | { t: 'allin_reveal'; hands: Array<{ seat: number; cards: [Card, Card] }> }
  | { t: 'show'; seat: number; cards: [Card, Card]; description: string; bestFive: Card[] }
  | { t: 'muck'; seat: number }
  | { t: 'award'; potIndex: number; potCount: number; potAmount: number; seat: number; amount: number; description: string | null; bestFive: Card[] | null }
  | { t: 'hand_end' };

export interface PotResult extends Pot {
  winners: Array<{ seat: number; amount: number }>;
}

export interface HandResult {
  pots: PotResult[];
  /** Chips won minus chips put in, by seat. Always sums to zero. */
  net: Record<number, number>;
  finalStacks: Record<number, number>;
  wentToShowdown: boolean;
  /** Seats whose hole cards were publicly revealed. */
  shownSeats: number[];
  /** Showdown evaluation for every live seat (public only for shown seats). */
  evaluations: Record<number, EvaluatedHand>;
  /** Seats still live when the hand ended. */
  liveSeats: number[];
  allInRunout: boolean;
}

export type ActResult = { ok: true } | { ok: false; error: string };

const POSITION_TABLES: Record<number, string[]> = {
  2: ['BB', 'BTN'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'UTG', 'BTN'],
  5: ['SB', 'BB', 'UTG', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'MP', 'CO', 'BTN'],
  7: ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'CO', 'BTN'],
  8: ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO', 'BTN'],
};

/** Position names in deal order: index 0 sits directly left of the button. */
export function positionLabels(playerCount: number): string[] {
  const labels = POSITION_TABLES[playerCount];
  if (!labels) throw new Error(`Unsupported player count: ${playerCount}`);
  return labels;
}

/**
 * The state machine for one hand of no-limit hold'em. It owns the deck, posts
 * blinds, deals, validates every action and pays out. It has no knowledge of
 * timers, rendering or bots, and it never mutates state on an illegal action.
 */
export class Hand {
  readonly handNumber: number;
  readonly buttonSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  /** Deal order: index 0 is directly left of the button, the last index is the button. */
  readonly players: HandPlayer[];
  readonly sbSeat: number;
  readonly bbSeat: number;
  readonly events: HandEvent[] = [];
  readonly board: Card[] = [];

  street: Street = 'preflop';
  /** Chips already collected from previous betting rounds. */
  pot = 0;
  currentBet = 0;
  lastRaiseSize: number;
  /** Seat of the last player to bet or raise on the current street. */
  lastAggressorSeat: number | null = null;
  /** Seat of the last aggressor on the preceding streets, used for showdown order. */
  private showdownLeadSeat: number | null = null;
  result: HandResult | null = null;

  private actorIndex: number | null = null;
  private readonly deck: Deck;
  private readonly startTotal: number;
  private revealedRunout = false;

  constructor(config: HandConfig) {
    const { players, buttonSeat, smallBlind, bigBlind, deck } = config;
    const ante = config.ante ?? 0;
    if (players.length < 2) throw new Error('A hand needs at least two players');
    if (players.length > 9) throw new Error('A hand supports at most nine players');
    if (!Number.isInteger(smallBlind) || !Number.isInteger(bigBlind) || smallBlind <= 0 || bigBlind < smallBlind) {
      throw new Error('Invalid blinds');
    }
    if (!Number.isInteger(ante) || ante < 0) throw new Error('Invalid ante');
    const seats = new Set(players.map((p) => p.seat));
    if (seats.size !== players.length) throw new Error('Duplicate seat');
    for (const p of players) {
      if (!Number.isInteger(p.stack) || p.stack <= 0) throw new Error(`Invalid stack for seat ${p.seat}: ${p.stack}`);
    }
    if (!seats.has(buttonSeat)) throw new Error('The button must sit on a dealt-in player');

    this.handNumber = config.handNumber;
    this.buttonSeat = buttonSeat;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.ante = ante;
    this.deck = deck;
    this.lastRaiseSize = bigBlind;

    const sorted = [...players].sort((a, b) => a.seat - b.seat);
    const buttonIndex = sorted.findIndex((p) => p.seat === buttonSeat);
    const inDealOrder: HandSeatInit[] = [];
    for (let i = 1; i <= sorted.length; i++) inDealOrder.push(sorted[(buttonIndex + i) % sorted.length]);

    const labels = positionLabels(inDealOrder.length);
    this.players = inDealOrder.map((p, i) => ({
      seat: p.seat,
      id: p.id,
      name: p.name,
      position: labels[i],
      startStack: p.stack,
      stack: p.stack,
      hole: [-1, -1],
      streetBet: 0,
      contributed: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      matchedLevel: 0,
    }));
    this.startTotal = this.players.reduce((sum, p) => sum + p.stack, 0);

    // Heads-up the button posts the small blind and acts first preflop.
    const headsUp = this.players.length === 2;
    const sbIndex = headsUp ? 1 : 0;
    const bbIndex = headsUp ? 0 : 1;
    this.sbSeat = this.players[sbIndex].seat;
    this.bbSeat = this.players[bbIndex].seat;

    this.events.push({
      t: 'hand_start',
      handNumber: this.handNumber,
      buttonSeat,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      smallBlind,
      bigBlind,
      ante,
    });

    if (ante > 0) {
      for (const p of this.players) {
        const paid = Math.min(ante, p.stack);
        p.stack -= paid;
        p.contributed += paid;
        this.pot += paid;
        p.allIn = p.stack === 0;
        this.events.push({ t: 'post', seat: p.seat, kind: 'ante', amount: paid, allIn: p.allIn });
      }
    }
    this.postBlind(this.players[sbIndex], smallBlind, 'sb');
    this.postBlind(this.players[bbIndex], bigBlind, 'bb');
    // The bet to match is the nominal big blind even when the big blind is short.
    this.currentBet = bigBlind;

    for (const round of [0, 1] as const) {
      for (const p of this.players) {
        p.hole[round] = deck.draw();
        this.events.push({ t: 'deal_hole', seat: p.seat, cardIndex: round });
      }
    }

    const firstIndex = headsUp ? sbIndex : (bbIndex + 1) % this.players.length;
    this.actorIndex = null;
    const next = this.needsAction(this.players[firstIndex]) ? firstIndex : this.findNextActor(firstIndex);
    if (next !== null) this.actorIndex = next;
    else this.endBettingRound();
  }

  private postBlind(p: HandPlayer, amount: number, kind: 'sb' | 'bb'): void {
    const paid = Math.min(amount, p.stack);
    p.stack -= paid;
    p.streetBet = paid;
    p.contributed += paid;
    p.allIn = p.stack === 0;
    this.events.push({ t: 'post', seat: p.seat, kind, amount: paid, allIn: p.allIn });
  }

  get isComplete(): boolean {
    return this.result !== null;
  }

  /** The seat that must act now, or null when the hand has finished. */
  get actorSeat(): number | null {
    return this.actorIndex === null ? null : this.players[this.actorIndex].seat;
  }

  playerAt(seat: number): HandPlayer | undefined {
    return this.players.find((p) => p.seat === seat);
  }

  /** Collected pot plus all bets currently in front of the players. */
  get totalPot(): number {
    return this.pot + this.players.reduce((sum, p) => sum + p.streetBet, 0);
  }

  /** Clockwise seats starting directly left of the button. */
  get seatOrder(): number[] {
    return this.players.map((p) => p.seat);
  }

  private otherCanAct(p: HandPlayer): boolean {
    return this.players.some((o) => o !== p && !o.folded && !o.allIn);
  }

  /** What `p` must reach to stay in. Never more than what an opponent can actually match. */
  private callTarget(p: HandPlayer): number {
    if (this.otherCanAct(p)) return this.currentBet;
    let highest = 0;
    for (const o of this.players) if (o !== p && !o.folded) highest = Math.max(highest, o.streetBet);
    return Math.min(this.currentBet, highest);
  }

  private needsAction(p: HandPlayer): boolean {
    if (p.folded || p.allIn) return false;
    if (!this.otherCanAct(p)) return p.streetBet < this.callTarget(p);
    return !p.hasActed || p.streetBet < this.currentBet;
  }

  private findNextActor(fromIndex: number): number | null {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const index = (fromIndex + i) % n;
      if (this.needsAction(this.players[index])) return index;
    }
    return null;
  }

  /** The full set of legal options for the player to act. Null for anyone else. */
  legalActions(seat: number): LegalActions | null {
    if (this.actorSeat !== seat) return null;
    const p = this.players[this.actorIndex!];
    const target = this.callTarget(p);
    const toCall = Math.max(0, target - p.streetBet);
    const callAmount = Math.min(toCall, p.stack);
    const maxTo = p.streetBet + p.stack;

    // Facing less than a full raise since the player last acted does not reopen the betting.
    const reopened = !p.hasActed || this.currentBet - p.matchedLevel >= this.lastRaiseSize;
    const canAggress = reopened && this.otherCanAct(p) && maxTo > this.currentBet;
    const normalMin = this.currentBet + this.lastRaiseSize;
    const opening = this.currentBet === 0;

    return {
      seat,
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount,
      callIsAllIn: toCall > 0 && callAmount === p.stack,
      canBet: canAggress && opening,
      canRaise: canAggress && !opening,
      minTo: canAggress ? Math.min(normalMin, maxTo) : 0,
      maxTo: canAggress ? maxTo : 0,
      shortAllInOnly: canAggress && maxTo < normalMin,
      canAllIn: canAggress || (toCall > 0 && callAmount === p.stack),
      pot: this.totalPot,
      currentBet: this.currentBet,
      streetBet: p.streetBet,
      stack: p.stack,
      bigBlind: this.bigBlind,
      lastRaiseSize: this.lastRaiseSize,
    };
  }

  /** Applies an action for `seat`. Illegal actions are rejected without changing any state. */
  act(seat: number, action: PlayerAction): ActResult {
    if (this.isComplete) return { ok: false, error: 'The hand is over' };
    const legal = this.legalActions(seat);
    if (!legal) return { ok: false, error: `Seat ${seat} is not the player to act` };
    const p = this.players[this.actorIndex!];
    const potBefore = this.totalPot;
    const facing = legal.callAmount;

    let resolved = action;
    if (resolved.type === 'allin') {
      if (!legal.canAllIn) return { ok: false, error: 'Moving all-in is not legal: the betting was not reopened' };
      if (legal.canBet) resolved = { type: 'bet', to: legal.maxTo };
      else if (legal.canRaise) resolved = { type: 'raise', to: legal.maxTo };
      else resolved = { type: 'call' };
    }

    switch (resolved.type) {
      case 'fold':
        p.folded = true;
        this.record(p, 'fold', 0, facing, potBefore);
        break;
      case 'check':
        if (!legal.canCheck) return { ok: false, error: 'Cannot check when facing a bet' };
        this.record(p, 'check', 0, facing, potBefore);
        break;
      case 'call': {
        if (!legal.canCall) return { ok: false, error: 'Nothing to call' };
        this.commit(p, legal.callAmount);
        this.record(p, 'call', legal.callAmount, facing, potBefore);
        break;
      }
      case 'bet':
      case 'raise': {
        const allowed = resolved.type === 'bet' ? legal.canBet : legal.canRaise;
        if (!allowed) return { ok: false, error: `A ${resolved.type} is not legal here` };
        const to = resolved.to;
        if (!Number.isInteger(to)) return { ok: false, error: 'Bet sizes must be whole chips' };
        if (to < legal.minTo) return { ok: false, error: `The minimum ${resolved.type} is to ${legal.minTo}` };
        if (to > legal.maxTo) return { ok: false, error: `You only have enough chips to reach ${legal.maxTo}` };
        const raiseSize = to - this.currentBet;
        const added = to - p.streetBet;
        this.commit(p, added);
        if (raiseSize >= this.lastRaiseSize) this.lastRaiseSize = raiseSize;
        this.currentBet = to;
        this.lastAggressorSeat = p.seat;
        this.record(p, resolved.type, added, facing, potBefore);
        break;
      }
    }

    p.hasActed = true;
    p.matchedLevel = this.currentBet;
    const fromIndex = this.actorIndex!;
    this.actorIndex = null;

    if (this.players.filter((o) => !o.folded).length === 1) {
      this.endBettingRound();
    } else {
      const next = this.findNextActor(fromIndex);
      if (next !== null) this.actorIndex = next;
      else this.endBettingRound();
    }
    this.assertChipsConserved();
    return { ok: true };
  }

  private commit(p: HandPlayer, chips: number): void {
    p.stack -= chips;
    p.streetBet += chips;
    p.contributed += chips;
    p.allIn = p.stack === 0;
  }

  private record(p: HandPlayer, action: ActionKind, added: number, facing: number, potBefore: number): void {
    this.events.push({
      t: 'action',
      seat: p.seat,
      street: this.street as BettingStreet,
      action,
      added,
      to: p.streetBet,
      allIn: p.allIn,
      pot: this.totalPot,
      facing,
      potBefore,
    });
  }

  /** Returns the part of the top bet nobody matched. Folded chips count as matched. */
  private returnUncalled(): void {
    let top: HandPlayer | null = null;
    let second = 0;
    for (const p of this.players) {
      if (!top || p.streetBet > top.streetBet) {
        if (top) second = Math.max(second, top.streetBet);
        top = p;
      } else {
        second = Math.max(second, p.streetBet);
      }
    }
    if (!top || top.folded || top.streetBet <= second) return;
    const refund = top.streetBet - second;
    top.streetBet -= refund;
    top.contributed -= refund;
    top.stack += refund;
    top.allIn = top.stack === 0;
    this.events.push({ t: 'uncalled', seat: top.seat, amount: refund });
  }

  private endBettingRound(): void {
    this.returnUncalled();
    const collected = this.players.reduce((sum, p) => sum + p.streetBet, 0);
    if (collected > 0) {
      for (const p of this.players) p.streetBet = 0;
      this.pot += collected;
      this.events.push({ t: 'collect', pot: this.pot });
    }
    if (this.lastAggressorSeat !== null) this.showdownLeadSeat = this.lastAggressorSeat;

    const live = this.players.filter((p) => !p.folded);
    if (live.length === 1) {
      this.finishWithoutShowdown(live[0]);
      return;
    }

    for (;;) {
      if (this.street === 'river') {
        this.finishAtShowdown();
        return;
      }
      for (const p of this.players) {
        p.hasActed = false;
        p.matchedLevel = 0;
      }
      this.currentBet = 0;
      this.lastRaiseSize = this.bigBlind;
      this.lastAggressorSeat = null;

      const canAct = live.filter((p) => !p.allIn);
      if (canAct.length <= 1 && !this.revealedRunout) {
        this.revealedRunout = true;
        this.events.push({
          t: 'allin_reveal',
          hands: live.map((p) => ({ seat: p.seat, cards: [p.hole[0], p.hole[1]] })),
        });
      }

      this.dealNextStreet();

      if (canAct.length >= 2) {
        const first = this.players.findIndex((p) => !p.folded && !p.allIn);
        this.actorIndex = first;
        return;
      }
    }
  }

  private dealNextStreet(): void {
    const street: BettingStreet = this.street === 'preflop' ? 'flop' : this.street === 'flop' ? 'turn' : 'river';
    this.street = street;
    this.deck.burn();
    this.events.push({ t: 'burn', street });
    const count = street === 'flop' ? 3 : 1;
    const cards: Card[] = [];
    for (let i = 0; i < count; i++) cards.push(this.deck.draw());
    this.board.push(...cards);
    this.events.push({ t: 'board', street, cards, board: [...this.board] });
  }

  private finishWithoutShowdown(winner: HandPlayer): void {
    const pots: PotResult[] = [
      { amount: this.pot, eligible: [winner.seat], winners: [{ seat: winner.seat, amount: this.pot }] },
    ];
    winner.stack += this.pot;
    this.events.push({
      t: 'award',
      potIndex: 0,
      potCount: 1,
      potAmount: this.pot,
      seat: winner.seat,
      amount: this.pot,
      description: null,
      bestFive: null,
    });
    this.finalize(pots, {}, [], false);
  }

  private finishAtShowdown(): void {
    this.street = 'showdown';
    const live = this.players.filter((p) => !p.folded);
    const evaluations: Record<number, EvaluatedHand> = {};
    for (const p of live) evaluations[p.seat] = evaluateHand([p.hole[0], p.hole[1], ...this.board]);

    const pots = computePots(this.players.map((p) => ({ seat: p.seat, amount: p.contributed, folded: p.folded })));
    const potted = pots.reduce((sum, pot) => sum + pot.amount, 0);
    if (potted !== this.pot) throw new Error(`Pot mismatch: layers ${potted} vs pot ${this.pot}`);

    const results: PotResult[] = pots.map((pot) => {
      let best = -1;
      for (const seat of pot.eligible) best = Math.max(best, evaluations[seat].score);
      const winners = pot.eligible.filter((seat) => evaluations[seat].score === best);
      return { ...pot, winners: splitPot(pot.amount, winners, this.seatOrder) };
    });

    const winnerSeats = new Set(results.flatMap((r) => r.winners.map((w) => w.seat)));
    const shown: number[] = [];

    // Last aggressor shows first, then clockwise. Others show only when they
    // can still win something, otherwise they muck. All-in hands are already face up.
    const order = this.showdownOrder(live);
    let bestShown = -1;
    for (const p of order) {
      const score = evaluations[p.seat].score;
      if (this.revealedRunout || score >= bestShown || winnerSeats.has(p.seat)) {
        bestShown = Math.max(bestShown, score);
        shown.push(p.seat);
        this.events.push({
          t: 'show',
          seat: p.seat,
          cards: [p.hole[0], p.hole[1]],
          description: evaluations[p.seat].description,
          bestFive: evaluations[p.seat].bestFive,
        });
      } else {
        this.events.push({ t: 'muck', seat: p.seat });
      }
    }

    results.forEach((pot, potIndex) => {
      for (const w of pot.winners) {
        this.playerAt(w.seat)!.stack += w.amount;
        const showingDown = pot.eligible.length > 1;
        this.events.push({
          t: 'award',
          potIndex,
          potCount: results.length,
          potAmount: pot.amount,
          seat: w.seat,
          amount: w.amount,
          description: showingDown ? evaluations[w.seat].description : null,
          bestFive: showingDown ? evaluations[w.seat].bestFive : null,
        });
      }
    });
    this.finalize(results, evaluations, shown, true);
  }

  private showdownOrder(live: HandPlayer[]): HandPlayer[] {
    const startIndex = this.showdownLeadSeat === null ? -1 : live.findIndex((p) => p.seat === this.showdownLeadSeat);
    if (startIndex < 0) return live;
    return [...live.slice(startIndex), ...live.slice(0, startIndex)];
  }

  private finalize(
    pots: PotResult[],
    evaluations: Record<number, EvaluatedHand>,
    shownSeats: number[],
    wentToShowdown: boolean,
  ): void {
    this.actorIndex = null;
    const net: Record<number, number> = {};
    const finalStacks: Record<number, number> = {};
    for (const p of this.players) {
      net[p.seat] = p.stack - p.startStack;
      finalStacks[p.seat] = p.stack;
      p.allIn = false;
    }
    this.pot = 0;
    this.result = {
      pots,
      net,
      finalStacks,
      wentToShowdown,
      shownSeats,
      evaluations,
      liveSeats: this.players.filter((p) => !p.folded).map((p) => p.seat),
      allInRunout: this.revealedRunout,
    };
    this.events.push({ t: 'hand_end' });
    this.assertChipsConserved();
  }

  /** Every chip is always either in a stack, in a bet or in the pot. */
  private assertChipsConserved(): void {
    const total = this.players.reduce((sum, p) => sum + p.stack + p.streetBet, this.pot);
    if (total !== this.startTotal) {
      throw new Error(`Chip conservation violated on hand ${this.handNumber}: ${total} vs ${this.startTotal}`);
    }
  }
}

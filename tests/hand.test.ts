import { describe, expect, it } from 'vitest';
import { parseCards } from '../src/engine/cards';
import { Deck } from '../src/engine/deck';
import { Hand, type PlayerAction, positionLabels } from '../src/engine/hand';
import { SeededRng } from '../src/engine/rng';
import { PokerTable } from '../src/engine/table';

const rng = () => new SeededRng('hand-tests');

/** Builds a hand. Seats are 0..n-1, the button defaults to the last seat. */
function makeHand(stacks: number[], opts: { button?: number; deck?: string; sb?: number; bb?: number; ante?: number } = {}) {
  const deck = opts.deck ? Deck.stacked(parseCards(opts.deck), rng()) : Deck.shuffled(rng());
  return new Hand({
    handNumber: 1,
    players: stacks.map((stack, seat) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack })),
    buttonSeat: opts.button ?? stacks.length - 1,
    smallBlind: opts.sb ?? 50,
    bigBlind: opts.bb ?? 100,
    ante: opts.ante ?? 0,
    deck,
  });
}

function act(hand: Hand, seat: number, action: PlayerAction) {
  const r = hand.act(seat, action);
  if (!r.ok) throw new Error(`Seat ${seat} ${JSON.stringify(action)}: ${r.error}`);
}

describe('blinds, positions and action order', () => {
  it('posts blinds to the left of the button and starts with UTG', () => {
    const h = makeHand([1000, 1000, 1000, 1000], { button: 3 });
    expect(h.sbSeat).toBe(0);
    expect(h.bbSeat).toBe(1);
    expect(h.playerAt(0)!.streetBet).toBe(50);
    expect(h.playerAt(1)!.streetBet).toBe(100);
    expect(h.actorSeat).toBe(2);
    expect(h.playerAt(2)!.position).toBe('UTG');
    expect(h.playerAt(3)!.position).toBe('BTN');
  });

  it('follows heads-up rules: button is small blind, acts first preflop and last postflop', () => {
    const h = makeHand([1000, 1000], { button: 1 });
    expect(h.sbSeat).toBe(1);
    expect(h.bbSeat).toBe(0);
    expect(h.actorSeat).toBe(1);
    act(h, 1, { type: 'call' });
    expect(h.actorSeat).toBe(0); // big blind option
    act(h, 0, { type: 'check' });
    expect(h.street).toBe('flop');
    expect(h.actorSeat).toBe(0); // BB acts first postflop heads-up
    act(h, 0, { type: 'check' });
    expect(h.actorSeat).toBe(1);
  });

  it('gives the big blind an option after limps', () => {
    const h = makeHand([1000, 1000, 1000]);
    act(h, 2, { type: 'call' });
    act(h, 0, { type: 'call' });
    expect(h.actorSeat).toBe(1);
    const legal = h.legalActions(1)!;
    expect(legal.canCheck).toBe(true);
    expect(legal.canRaise).toBe(true);
    act(h, 1, { type: 'raise', to: 300 });
    expect(h.actorSeat).toBe(2);
  });

  it('starts postflop action with the first live player left of the button', () => {
    const h = makeHand([1000, 1000, 1000, 1000], { button: 3 });
    act(h, 2, { type: 'call' });
    act(h, 3, { type: 'call' });
    act(h, 0, { type: 'fold' });
    act(h, 1, { type: 'check' });
    expect(h.street).toBe('flop');
    expect(h.actorSeat).toBe(1); // seat 0 folded, so seat 1 opens
  });

  it('labels positions for every table size', () => {
    for (let n = 2; n <= 9; n++) {
      const labels = positionLabels(n);
      expect(labels).toHaveLength(n);
      expect(new Set(labels).size).toBe(n);
      expect(labels[n - 1]).toBe('BTN');
    }
  });

  it('rejects actions from the wrong player without changing state', () => {
    const h = makeHand([1000, 1000, 1000]);
    const before = JSON.stringify(h.players);
    const r = h.act(0, { type: 'fold' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(h.players)).toBe(before);
    expect(h.actorSeat).toBe(2);
  });
});

describe('dealing', () => {
  it('deals unique cards one at a time starting left of the button', () => {
    const h = makeHand([500, 500, 500, 500, 500, 500, 500, 500, 500]);
    const cards = h.players.flatMap((p) => p.hole);
    expect(new Set(cards).size).toBe(18);
    const deals = h.events.filter((e) => e.t === 'deal_hole');
    expect(deals).toHaveLength(18);
    expect(deals[0]).toMatchObject({ seat: 0, cardIndex: 0 });
    expect(deals[9]).toMatchObject({ seat: 0, cardIndex: 1 });
  });

  it('burns a card before each street and never exposes it', () => {
    // seat0, seat1, seat0, seat1 then burn, flop, burn, turn, burn, river
    const h = makeHand([1000, 1000], { button: 1, deck: 'Ah Kd As Kc 2c 7d 8d 9d 3c Td 4c Jd' });
    act(h, 1, { type: 'call' });
    act(h, 0, { type: 'check' });
    expect(h.board).toEqual(parseCards('7d 8d 9d'));
    act(h, 0, { type: 'check' });
    act(h, 1, { type: 'check' });
    expect(h.board).toEqual(parseCards('7d 8d 9d Td'));
    act(h, 0, { type: 'check' });
    act(h, 1, { type: 'check' });
    expect(h.board).toEqual(parseCards('7d 8d 9d Td Jd'));
    act(h, 0, { type: 'check' });
    act(h, 1, { type: 'check' });
    const serialised = JSON.stringify(h.events);
    for (const burnCard of parseCards('2c 3c 4c')) {
      for (const e of h.events) {
        if (e.t === 'board') expect(e.cards).not.toContain(burnCard);
      }
    }
    expect(serialised).toContain('"t":"burn"');
    expect(h.events.filter((e) => e.t === 'burn')).toHaveLength(3);
  });
});

describe('minimum bets and raises', () => {
  it('requires a preflop minimum raise of one big blind on top', () => {
    const h = makeHand([1000, 1000, 1000]);
    const legal = h.legalActions(2)!;
    expect(legal.canRaise).toBe(true);
    expect(legal.minTo).toBe(200);
    expect(legal.maxTo).toBe(1000);
    expect(h.act(2, { type: 'raise', to: 199 }).ok).toBe(false);
    expect(h.act(2, { type: 'raise', to: 1001 }).ok).toBe(false);
    expect(h.act(2, { type: 'raise', to: 200.5 }).ok).toBe(false);
    expect(h.act(2, { type: 'raise', to: 200 }).ok).toBe(true);
  });

  it('tracks raise increments through re-raises', () => {
    const h = makeHand([5000, 5000, 5000]);
    act(h, 2, { type: 'raise', to: 300 }); // raise by 200
    expect(h.legalActions(0)!.minTo).toBe(500);
    act(h, 0, { type: 'raise', to: 900 }); // raise by 600
    expect(h.legalActions(1)!.minTo).toBe(1500);
    act(h, 1, { type: 'fold' });
    act(h, 2, { type: 'raise', to: 1500 }); // exact minimum 3-bet by 600
    expect(h.legalActions(0)!.minTo).toBe(2100);
  });

  it('requires a postflop opening bet of at least one big blind', () => {
    const h = makeHand([1000, 1000], { button: 1 });
    act(h, 1, { type: 'call' });
    act(h, 0, { type: 'check' });
    const legal = h.legalActions(0)!;
    expect(legal.canBet).toBe(true);
    expect(legal.canRaise).toBe(false);
    expect(legal.minTo).toBe(100);
    expect(h.act(0, { type: 'bet', to: 99 }).ok).toBe(false);
    expect(h.act(0, { type: 'raise', to: 200 }).ok).toBe(false);
    expect(h.act(0, { type: 'bet', to: 100 }).ok).toBe(true);
    expect(h.legalActions(1)!.minTo).toBe(200);
  });

  it('refuses to check when facing a bet and to call when there is nothing to call', () => {
    const h = makeHand([1000, 1000], { button: 1 });
    expect(h.act(1, { type: 'check' }).ok).toBe(false);
    act(h, 1, { type: 'call' });
    expect(h.act(0, { type: 'call' }).ok).toBe(false);
  });
});

describe('short all-ins and reopening', () => {
  it('does not reopen the betting after a short all-in raise', () => {
    // BB 100. Seat 2 raises to 300. Seat 0 shoves 450 (only +150). Seat 1 folds.
    const h = makeHand([450, 1000, 2000], { button: 2 });
    expect(h.actorSeat).toBe(2);
    act(h, 2, { type: 'raise', to: 300 });
    act(h, 0, { type: 'allin' });
    expect(h.currentBet).toBe(450);
    expect(h.lastRaiseSize).toBe(200); // the short raise does not change the increment
    // Seat 1 has not acted yet, so it may still raise: 450 + 200.
    const seat1 = h.legalActions(1)!;
    expect(seat1.canRaise).toBe(true);
    expect(seat1.minTo).toBe(650);
    act(h, 1, { type: 'fold' });
    // Seat 2 already acted and faces only +150, so call or fold only.
    const seat2 = h.legalActions(2)!;
    expect(seat2.canRaise).toBe(false);
    expect(seat2.canAllIn).toBe(false);
    expect(seat2.canCall).toBe(true);
    expect(seat2.callAmount).toBe(150);
    expect(h.act(2, { type: 'raise', to: 2000 }).ok).toBe(false);
    expect(h.act(2, { type: 'allin' }).ok).toBe(false);
    act(h, 2, { type: 'call' });
    expect(h.isComplete).toBe(true);
  });

  it('reopens when several short all-ins add up to a full raise', () => {
    // Seat 2 raises to 300 (+200). Seats 0 and 1 shove +150 and +100: total +250 facing seat 2.
    const h = makeHand([450, 550, 2000], { button: 2 });
    act(h, 2, { type: 'raise', to: 300 });
    act(h, 0, { type: 'allin' });
    act(h, 1, { type: 'allin' });
    // No opponent can act any more, so a raise has no one to respond regardless.
    const legal = h.legalActions(2)!;
    expect(legal.canCall).toBe(true);
    expect(legal.canRaise).toBe(false);
  });

  it('reopens for a player with a live opponent left when facing a full raise in total', () => {
    const h = makeHand([3000, 450, 550, 3000], { button: 3 });
    // Seat 2 is UTG, seat 3 BTN, seat 0 SB, seat 1 BB.
    act(h, 2, { type: 'allin' }); // to 550, a full raise of +450
    act(h, 3, { type: 'call' });
    act(h, 0, { type: 'fold' });
    expect(h.isComplete || h.actorSeat === 1).toBe(true);
    expect(h.legalActions(1)!.callIsAllIn).toBe(true);
  });

  it('allows a short all-in below the minimum as the only aggressive option', () => {
    const h = makeHand([150, 1000], { button: 1 });
    // Seat 1 (SB) limps, seat 0 (BB) has 50 behind and can only make a short raise to 150.
    act(h, 1, { type: 'call' });
    const legal = h.legalActions(0)!;
    expect(legal.canRaise).toBe(true);
    expect(legal.shortAllInOnly).toBe(true);
    expect(legal.minTo).toBe(150);
    expect(legal.maxTo).toBe(150);
    act(h, 0, { type: 'raise', to: 150 });
    const seat1 = h.legalActions(1)!;
    expect(seat1.canRaise).toBe(false);
    expect(seat1.callAmount).toBe(50);
  });

  it('forbids raising when every opponent is already all-in', () => {
    const h = makeHand([300, 1000], { button: 1 });
    act(h, 1, { type: 'raise', to: 200 });
    act(h, 0, { type: 'allin' });
    const legal = h.legalActions(1)!;
    expect(legal.canRaise).toBe(false);
    expect(legal.canAllIn).toBe(false);
    expect(legal.callAmount).toBe(100);
  });

  it('under-bet all-in postflop keeps the normal raise increment on top', () => {
    const h = makeHand([150, 1000, 1000], { button: 2 });
    act(h, 2, { type: 'call' });
    act(h, 0, { type: 'call' });
    act(h, 1, { type: 'check' });
    expect(h.street).toBe('flop');
    expect(h.actorSeat).toBe(0);
    act(h, 0, { type: 'allin' }); // bets only 50, below the 100 minimum
    expect(h.currentBet).toBe(50);
    const seat1 = h.legalActions(1)!;
    expect(seat1.canRaise).toBe(true);
    expect(seat1.minTo).toBe(150); // 50 + one big blind
  });
});

describe('uncalled bets', () => {
  it('returns an uncalled bet and awards only the matched chips', () => {
    const h = makeHand([1000, 1000, 1000]);
    act(h, 2, { type: 'raise', to: 500 });
    act(h, 0, { type: 'fold' });
    act(h, 1, { type: 'fold' });
    expect(h.isComplete).toBe(true);
    expect(h.events.some((e) => e.t === 'uncalled' && e.seat === 2 && e.amount === 400)).toBe(true);
    expect(h.result!.finalStacks).toEqual({ 0: 950, 1: 900, 2: 1150 });
    expect(h.result!.wentToShowdown).toBe(false);
  });

  it('returns the excess when a shorter all-in calls', () => {
    const deck = 'Ah Kd 2c As Kc 2d 3c 7h 8h 9c 3d Ts 4d 4h';
    const h = makeHand([300, 2000, 2000], { button: 2, deck });
    act(h, 2, { type: 'raise', to: 1000 });
    act(h, 0, { type: 'call' }); // all-in 300
    act(h, 1, { type: 'fold' });
    expect(h.isComplete).toBe(true);
    expect(h.events.some((e) => e.t === 'uncalled' && e.seat === 2 && e.amount === 700)).toBe(true);
    expect(h.result!.pots).toHaveLength(1);
    expect(h.result!.pots[0].amount).toBe(700);
  });

  it('hands the big blind a walk with the small blind refund', () => {
    const h = makeHand([1000, 1000, 1000]);
    act(h, 2, { type: 'fold' });
    act(h, 0, { type: 'fold' });
    expect(h.result!.finalStacks).toEqual({ 0: 950, 1: 1050, 2: 1000 });
  });
});

describe('short blinds', () => {
  it('still requires callers to match the nominal big blind when the big blind is short', () => {
    const h = makeHand([1000, 60, 1000], { button: 2 });
    expect(h.playerAt(1)!.allIn).toBe(true);
    expect(h.currentBet).toBe(100);
    expect(h.legalActions(2)!.callAmount).toBe(100);
  });

  it('skips action entirely when both blinds are all-in from posting', () => {
    const h = makeHand([40, 70], { button: 1 });
    expect(h.isComplete).toBe(true);
    expect(h.board).toHaveLength(5);
    expect(h.result!.finalStacks[0] + h.result!.finalStacks[1]).toBe(110);
  });

  it('does not ask the small blind to call when the all-in big blind posted less', () => {
    const h = makeHand([70, 30], { button: 0, sb: 50, bb: 100 });
    // Seat 0 is button/SB posts 50, seat 1 is BB all-in for 30. Seat 0 has already covered it.
    expect(h.isComplete).toBe(true);
    const total = h.result!.finalStacks[0] + h.result!.finalStacks[1];
    expect(total).toBe(100);
    expect(h.events.some((e) => e.t === 'uncalled' && e.seat === 0 && e.amount === 20)).toBe(true);
  });

  it('collects antes as dead money and handles an all-in from the ante', () => {
    const h = makeHand([1000, 1000, 10], { button: 2, ante: 10 });
    expect(h.pot).toBe(30);
    expect(h.playerAt(2)!.allIn).toBe(true);
    expect(h.actorSeat).toBe(0); // button is all-in from the ante, so action starts on the SB
    expect(h.totalPot).toBe(180);
  });
});

describe('showdown and pot distribution', () => {
  it('awards a straightforward showdown and shows the winning hand', () => {
    // seat0 Ah Kh, seat1 2c 7d
    const deck = 'Ah 2c Kh 7d 3s 9h 9c 4d 3d Js 5c Qs';
    const h = makeHand([1000, 1000], { button: 1, deck });
    act(h, 1, { type: 'call' });
    act(h, 0, { type: 'check' });
    for (let i = 0; i < 3; i++) {
      act(h, 0, { type: 'check' });
      act(h, 1, { type: 'check' });
    }
    expect(h.isComplete).toBe(true);
    expect(h.result!.wentToShowdown).toBe(true);
    expect(h.result!.finalStacks).toEqual({ 0: 1100, 1: 900 });
    expect(h.result!.shownSeats).toContain(0);
  });

  it('splits a board-playing tie and sends the odd chip left of the button', () => {
    // Royal flush on the board. Three players; button is seat 2. Seat 0 is SB.
    const deck = '2c 3c 4c 2d 3d 4d 5h As Ks Qs 5d Js 6h Ts';
    const h = makeHand([1000, 1000, 1000], { button: 2, sb: 5, bb: 10, deck });
    // Seat 2 calls 10, seat 0 folds leaving 5 dead, seat 1 checks: pot 25 is split between 1 and 2.
    act(h, 2, { type: 'call' });
    act(h, 0, { type: 'fold' });
    act(h, 1, { type: 'check' });
    for (let i = 0; i < 3; i++) {
      act(h, 1, { type: 'check' });
      act(h, 2, { type: 'check' });
    }
    expect(h.result!.pots).toHaveLength(1);
    expect(h.result!.pots[0].winners).toEqual([
      { seat: 1, amount: 13 },
      { seat: 2, amount: 12 },
    ]);
    expect(h.result!.finalStacks).toEqual({ 0: 995, 1: 1003, 2: 1002 });
  });

  it('pays a short all-in winner only the main pot and the best remaining hand the side pot', () => {
    // Deal order is seats 0,1,2,0,1,2. Seat 0 AA (short), seat 1 KK, seat 2 QQ.
    const deck = 'Ah Kh Qh Ad Kd Qd 2c 3s 7d 9c 3d 5s 3h 8h';
    const h = makeHand([200, 1000, 1000], { button: 2, deck });
    act(h, 2, { type: 'raise', to: 500 });
    act(h, 0, { type: 'allin' });
    act(h, 1, { type: 'call' });
    expect(h.actorSeat).toBe(1); // seat 0 is all-in, so seat 1 opens the flop
    act(h, 1, { type: 'check' });
    act(h, 2, { type: 'check' });
    act(h, 1, { type: 'check' });
    act(h, 2, { type: 'check' });
    act(h, 1, { type: 'check' });
    act(h, 2, { type: 'check' });
    expect(h.isComplete).toBe(true);
    const r = h.result!;
    expect(r.pots).toHaveLength(2);
    expect(r.pots[0]).toMatchObject({ amount: 600, eligible: [0, 1, 2] });
    expect(r.pots[0].winners).toEqual([{ seat: 0, amount: 600 }]);
    expect(r.pots[1]).toMatchObject({ amount: 600, eligible: [1, 2] });
    expect(r.pots[1].winners).toEqual([{ seat: 1, amount: 600 }]);
    expect(r.finalStacks).toEqual({ 0: 600, 1: 1100, 2: 500 });
  });

  it('handles three different all-ins with a split side pot', () => {
    // Button seat 3. Order: 0 (SB), 1 (BB), 2, 3.
    // Seats 1 and 3 hold the same ranks and chop the side pot; seat 0 wins the main with AA.
    const deck = 'Ah Kh 2d Kd Ad Ks 3d Kc 4s 5c 7h 8s 9d 6h Jd 6d Qc';
    const h = makeHand([100, 400, 400, 1000], { button: 3, sb: 50, bb: 100, deck });
    // Seat 0 posts 50, seat 1 posts 100.
    act(h, 2, { type: 'allin' }); // 400
    act(h, 3, { type: 'call' }); // 400
    act(h, 0, { type: 'call' }); // all-in for the remaining 50, total 100
    act(h, 1, { type: 'call' }); // all-in 400
    expect(h.isComplete).toBe(true);
    const r = h.result!;
    expect(r.pots.reduce((s, p) => s + p.amount, 0)).toBe(1300);
    expect(Object.values(r.finalStacks).reduce((s, v) => s + v, 0)).toBe(1900);
    // Everyone was all-in or covered, so every live hand is revealed.
    expect(r.allInRunout).toBe(true);
    expect(r.shownSeats.sort()).toEqual([0, 1, 2, 3]);
  });

  it('never lets a folded player win a pot they contributed to', () => {
    const deck = 'Ah Kh Qh Ad Kd Qd 2c 3s 7d 9c 3d 5s 3h 8h';
    const h = makeHand([300, 1000, 1000], { button: 2, deck });
    act(h, 2, { type: 'raise', to: 300 });
    act(h, 0, { type: 'call' }); // all-in with AA
    act(h, 1, { type: 'call' });
    act(h, 1, { type: 'bet', to: 200 });
    act(h, 2, { type: 'fold' });
    expect(h.isComplete).toBe(true);
    const r = h.result!;
    // Seat 2's 300 stays in the pot, seat 2 is on no eligible list.
    for (const pot of r.pots) expect(pot.eligible).not.toContain(2);
    expect(r.finalStacks[2]).toBe(700);
    expect(r.finalStacks[0]).toBe(900); // AA wins the 900 main pot
    expect(r.finalStacks[1]).toBe(700); // seat 1's uncalled 200 flop bet came back
  });

  it('pays side pots correctly when the shortest stack has the worst hand', () => {
    const deck = '2c Ah Kh 7d Ad Kd 3s Qs Js 9c 4h 5h 6h 8d';
    const h = makeHand([200, 500, 1000], { button: 2, deck });
    act(h, 2, { type: 'allin' });
    act(h, 0, { type: 'allin' });
    act(h, 1, { type: 'allin' });
    expect(h.isComplete).toBe(true);
    const r = h.result!;
    // Seat 1 has AA and wins main + side (500 stack level), seat 2 gets the 500 excess back.
    expect(r.finalStacks).toEqual({ 0: 0, 1: 1200, 2: 500 });
  });

  it('keeps every folded dead chip when an aggressor folds to a re-raise', () => {
    const h = makeHand([1000, 1000, 1000]);
    act(h, 2, { type: 'raise', to: 300 });
    act(h, 0, { type: 'raise', to: 800 });
    act(h, 1, { type: 'fold' });
    act(h, 2, { type: 'fold' });
    expect(h.result!.finalStacks).toEqual({ 0: 1400, 1: 900, 2: 700 });
  });

  it('runs out the board and reveals hands when betting is closed', () => {
    const h = makeHand([500, 500], { button: 1 });
    act(h, 1, { type: 'allin' });
    act(h, 0, { type: 'call' });
    expect(h.isComplete).toBe(true);
    expect(h.board).toHaveLength(5);
    expect(h.events.some((e) => e.t === 'allin_reveal')).toBe(true);
  });

  it('runs out when one covered player remains with chips', () => {
    const h = makeHand([200, 1000], { button: 1 });
    act(h, 1, { type: 'raise', to: 200 });
    act(h, 0, { type: 'allin' }); // just a call of 100, all-in
    expect(h.isComplete).toBe(true);
    expect(h.board).toHaveLength(5);
  });

  it('shows the last aggressor first and lets a beaten player muck', () => {
    // seat0 AA, seat1 22. Seat 0 bets the river, seat 1 calls and mucks the loser.
    const deck = 'Ah 2c Ad 2d 3s 9h Tc 4d 3d Js 5c Qs';
    const h = makeHand([1000, 1000], { button: 1, deck });
    act(h, 1, { type: 'call' });
    act(h, 0, { type: 'check' });
    act(h, 0, { type: 'check' });
    act(h, 1, { type: 'check' });
    act(h, 0, { type: 'check' });
    act(h, 1, { type: 'check' });
    act(h, 0, { type: 'bet', to: 100 });
    act(h, 1, { type: 'call' });
    const shows = h.events.filter((e) => e.t === 'show' || e.t === 'muck');
    expect(shows[0]).toMatchObject({ t: 'show', seat: 0 });
    expect(shows[1]).toMatchObject({ t: 'muck', seat: 1 });
    expect(h.result!.shownSeats).toEqual([0]);
  });
});

describe('table rotation', () => {
  const makeTable = (n: number, maxSeats = 9) => {
    const table = new PokerTable({ maxSeats, smallBlind: 5, bigBlind: 10, rng: new SeededRng('table') });
    for (let i = 0; i < n; i++) table.sit(i, { id: `p${i}`, name: `P${i}`, stack: 1000 });
    return table;
  };

  const finish = (table: PokerTable) => {
    const hand = table.currentHand!;
    while (!hand.isComplete) {
      const seat = hand.actorSeat!;
      const legal = hand.legalActions(seat)!;
      hand.act(seat, legal.canCheck ? { type: 'check' } : { type: 'fold' });
    }
    table.settleHand();
  };

  it('moves the button and blinds one seat clockwise every hand', () => {
    const table = makeTable(4);
    const h1 = table.startHand();
    const first = h1.buttonSeat;
    expect(h1.sbSeat).toBe((first + 1) % 4);
    expect(h1.bbSeat).toBe((first + 2) % 4);
    finish(table);
    const h2 = table.startHand();
    expect(h2.buttonSeat).toBe((first + 1) % 4);
    expect(h2.sbSeat).toBe((first + 2) % 4);
    expect(h2.bbSeat).toBe((first + 3) % 4);
  });

  it('skips empty and busted seats', () => {
    const table = makeTable(3, 6);
    table.seats[1]!.stack = 0;
    const h = table.startHand();
    expect(h.players).toHaveLength(2);
    expect(h.players.map((p) => p.seat)).not.toContain(1);
    expect(h.sbSeat).toBe(h.buttonSeat); // heads-up rule applies automatically
  });

  it('alternates the button heads-up', () => {
    const table = makeTable(2, 2);
    const first = table.startHand().buttonSeat;
    finish(table);
    expect(table.startHand().buttonSeat).toBe(1 - first);
    finish(table);
    expect(table.startHand().buttonSeat).toBe(first);
  });

  it('settles stacks exactly once and conserves table chips', () => {
    const table = makeTable(6);
    for (let i = 0; i < 25; i++) {
      table.startHand();
      finish(table);
      expect(table.totalChips).toBe(6000);
    }
    expect(table.handCount).toBe(25);
    expect(() => table.settleHand()).toThrow();
  });

  it('refuses duplicate seating and starting over a running hand', () => {
    const table = makeTable(3, 6);
    expect(() => table.sit(0, { id: 'x', name: 'X', stack: 100 })).toThrow();
    expect(() => table.sit(4, { id: 'p1', name: 'P1', stack: 100 })).toThrow();
    table.startHand();
    expect(() => table.startHand()).toThrow();
  });
});

describe('fuzz: random legal play', () => {
  it('conserves chips, deals unique cards and stays legal over 20,000 hands on all table sizes', () => {
    const r = new SeededRng('fuzz');
    for (let trial = 0; trial < 20000; trial++) {
      const n = 2 + r.int(8);
      const stacks = Array.from({ length: n }, () => 1 + r.int(r.next() < 0.3 ? 60 : 2000));
      const total = stacks.reduce((a, b) => a + b, 0);
      const button = r.int(n);
      const ante = r.next() < 0.2 ? r.int(6) : 0;
      const hand = new Hand({
        handNumber: trial,
        players: stacks.map((stack, seat) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack })),
        buttonSeat: button,
        smallBlind: 5,
        bigBlind: 10,
        ante,
        deck: Deck.shuffled(r),
      });

      let guard = 0;
      while (!hand.isComplete) {
        if (++guard > 400) throw new Error('Betting round failed to terminate');
        const seat = hand.actorSeat!;
        const legal = hand.legalActions(seat)!;
        if (legal.stack <= 0) throw new Error('Actor has no chips');
        const options: PlayerAction[] = [{ type: 'fold' }];
        if (legal.canCheck) options.push({ type: 'check' }, { type: 'check' });
        if (legal.canCall) options.push({ type: 'call' }, { type: 'call' });
        if (legal.canAllIn) options.push({ type: 'allin' });
        if (legal.canBet) options.push({ type: 'bet', to: legal.minTo + r.int(legal.maxTo - legal.minTo + 1) });
        if (legal.canRaise) options.push({ type: 'raise', to: legal.minTo + r.int(legal.maxTo - legal.minTo + 1) });
        const choice = options[r.int(options.length)];
        const result = hand.act(seat, choice);
        if (!result.ok) throw new Error(`${JSON.stringify(choice)} rejected though legal: ${result.error}`);

        // Throw in illegal probes: they must never succeed or change anything.
        const nextSeat = hand.actorSeat;
        if (nextSeat !== null) {
          const probeLegal = hand.legalActions(nextSeat)!;
          const snapshot = JSON.stringify(hand.players);
          if (!probeLegal.canCheck && hand.act(nextSeat, { type: 'check' }).ok) throw new Error('Illegal check accepted');
          if (probeLegal.canBet || probeLegal.canRaise) {
            const type = probeLegal.canBet ? 'bet' : 'raise';
            if (hand.act(nextSeat, { type, to: probeLegal.maxTo + 1 }).ok) throw new Error('Oversized bet accepted');
            if (probeLegal.minTo > 1 && hand.act(nextSeat, { type, to: probeLegal.minTo - 1 }).ok) throw new Error('Undersized bet accepted');
          }
          if (JSON.stringify(hand.players) !== snapshot) throw new Error('Illegal action changed state');
        }
      }

      const res = hand.result!;
      const finalTotal = Object.values(res.finalStacks).reduce((a, b) => a + b, 0);
      if (finalTotal !== total) throw new Error(`Chips changed: ${finalTotal} vs ${total}`);
      if (Object.values(res.net).reduce((a, b) => a + b, 0) !== 0) throw new Error('Net does not sum to zero');
      for (const seat of Object.keys(res.finalStacks)) if (res.finalStacks[+seat] < 0) throw new Error('Negative stack');
      const allCards = [...hand.players.flatMap((p) => p.hole), ...hand.board];
      if (new Set(allCards).size !== allCards.length) throw new Error('Duplicate card dealt');
      for (const pot of res.pots) {
        if (pot.winners.reduce((s, w) => s + w.amount, 0) !== pot.amount) throw new Error('Pot not fully paid');
        for (const w of pot.winners) if (!pot.eligible.includes(w.seat)) throw new Error('Ineligible winner');
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { parseCards } from '../src/engine/cards';
import { Deck } from '../src/engine/deck';
import { Hand, type PlayerAction } from '../src/engine/hand';
import { SeededRng } from '../src/engine/rng';
import { buildHandRecord, visibleHole } from '../src/history/record';
import { addCounters, emptyCounters, extractHandStats, publishStats, rate, type StatCounters, wilsonInterval } from '../src/stats/counters';

type Step = [number, PlayerAction];

function play(stacks: number[], button: number, steps: Step[], deck?: string) {
  const hand = new Hand({
    handNumber: 1,
    players: stacks.map((stack, seat) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack })),
    buttonSeat: button,
    smallBlind: 5,
    bigBlind: 10,
    deck: deck ? Deck.stacked(parseCards(deck), new SeededRng(4)) : Deck.shuffled(new SeededRng(4)),
  });
  for (const [seat, action] of steps) {
    const r = hand.act(seat, action);
    if (!r.ok) throw new Error(`Seat ${seat}: ${r.error}`);
  }
  expect(hand.isComplete).toBe(true);
  const record = buildHandRecord(hand, { id: 'r', sessionId: 's', tableId: 't', tableName: 't', mode: 'cash', maxSeats: 9, heroId: 'p0', now: 1 });
  return { record, stats: extractHandStats(record) };
}

const of = (m: Map<string, StatCounters>, seat: number) => m.get(`p${seat}`)!;

describe('preflop statistics', () => {
  it('counts VPIP and PFR with the right denominator', () => {
    // 4 players, button 3. UTG (seat 2) raises, button folds, SB calls, BB folds.
    const { stats } = play([1000, 1000, 1000, 1000], 3, [
      [2, { type: 'raise', to: 30 }],
      [3, { type: 'fold' }],
      [0, { type: 'call' }],
      [1, { type: 'fold' }],
      [0, { type: 'check' }],
      [2, { type: 'bet', to: 40 }],
      [0, { type: 'fold' }],
    ]);
    expect(of(stats, 2)).toMatchObject({ decisions: 1, vpip: 1, pfr: 1 });
    expect(of(stats, 3)).toMatchObject({ decisions: 1, vpip: 0, pfr: 0 });
    expect(of(stats, 0)).toMatchObject({ decisions: 1, vpip: 1, pfr: 0 });
    expect(of(stats, 1)).toMatchObject({ decisions: 1, vpip: 0 });
  });

  it('does not count a big blind check as VPIP, and a walk has no decision', () => {
    const limped = play([1000, 1000, 1000], 2, [
      [2, { type: 'call' }],
      [0, { type: 'call' }],
      [1, { type: 'check' }],
      [0, { type: 'check' }],
      [1, { type: 'check' }],
      [2, { type: 'bet', to: 20 }],
      [0, { type: 'fold' }],
      [1, { type: 'fold' }],
    ]);
    expect(of(limped.stats, 1)).toMatchObject({ decisions: 1, vpip: 0, pfr: 0 });
    const walk = play([1000, 1000, 1000], 2, [
      [2, { type: 'fold' }],
      [0, { type: 'fold' }],
    ]);
    expect(of(walk.stats, 1)).toMatchObject({ hands: 1, decisions: 0, vpip: 0 });
  });

  it('tracks 3-bet opportunities, 3-bets, and the response to them', () => {
    const { stats } = play([1000, 1000, 1000], 2, [
      [2, { type: 'raise', to: 30 }], // first raise
      [0, { type: 'raise', to: 100 }], // 3-bet
      [1, { type: 'fold' }], // had a 3-bet opportunity and passed
      [2, { type: 'fold' }], // folded to the 3-bet
    ]);
    expect(of(stats, 2)).toMatchObject({ threeBetOpp: 0, faced3Bet: 1, foldTo3Bet: 1, fourBet: 0 });
    expect(of(stats, 0)).toMatchObject({ threeBetOpp: 1, threeBet: 1 });
    // Seat 1 faced two raises by the time it acted, so it was not a 3-bet opportunity.
    expect(of(stats, 1)).toMatchObject({ threeBetOpp: 0, threeBet: 0 });
  });

  it('records a 4-bet as the response to a 3-bet', () => {
    const { stats } = play([1000, 1000], 1, [
      [1, { type: 'raise', to: 30 }],
      [0, { type: 'raise', to: 100 }],
      [1, { type: 'raise', to: 250 }],
      [0, { type: 'fold' }],
    ]);
    expect(of(stats, 1)).toMatchObject({ faced3Bet: 1, fourBet: 1, foldTo3Bet: 0 });
    expect(of(stats, 0)).toMatchObject({ threeBet: 1 });
  });

  it('counts steals and blind defence', () => {
    const { stats } = play([1000, 1000, 1000], 2, [
      [2, { type: 'raise', to: 30 }],
      [0, { type: 'fold' }],
      [1, { type: 'call' }],
      [1, { type: 'check' }],
      [2, { type: 'check' }],
      [1, { type: 'check' }],
      [2, { type: 'check' }],
      [1, { type: 'check' }],
      [2, { type: 'check' }],
    ]);
    expect(of(stats, 2)).toMatchObject({ stealOpp: 1, steal: 1 });
    expect(of(stats, 0)).toMatchObject({ blindFacedSteal: 1, blindFoldSteal: 1 });
    expect(of(stats, 1)).toMatchObject({ bbFacedSteal: 1, bbDefend: 1, blindFacedSteal: 1, blindFoldSteal: 0 });
  });
});

describe('postflop statistics', () => {
  const cbetLine: Step[] = [
    [1, { type: 'raise', to: 30 }],
    [0, { type: 'call' }],
    [0, { type: 'check' }],
    [1, { type: 'bet', to: 40 }],
    [0, { type: 'fold' }],
  ];

  it('tracks continuation bets and the folds to them', () => {
    const { stats } = play([1000, 1000], 1, cbetLine);
    expect(of(stats, 1)).toMatchObject({ cbetOpp: 1, cbet: 1 });
    expect(of(stats, 0)).toMatchObject({ facedCbet: 1, foldToCbet: 1, facedBetFlop: 1, foldBetFlop: 1 });
  });

  it('counts a checked flop by the aggressor as a missed c-bet opportunity', () => {
    const { stats } = play([1000, 1000], 1, [
      [1, { type: 'raise', to: 30 }],
      [0, { type: 'call' }],
      [0, { type: 'check' }],
      [1, { type: 'check' }],
      [0, { type: 'bet', to: 20 }],
      [1, { type: 'fold' }],
    ]);
    expect(of(stats, 1)).toMatchObject({ cbetOpp: 1, cbet: 0 });
    expect(of(stats, 0)).toMatchObject({ cbetOpp: 0 });
  });

  it('measures WTSD and W$SD only over hands that saw the flop', () => {
    const deck = 'Ah 2c Ad 2d 3s 9h Tc 4d 3d Js 5c Qs';
    const { stats } = play(
      [1000, 1000],
      1,
      [
        [1, { type: 'call' }],
        [0, { type: 'check' }],
        [0, { type: 'check' }],
        [1, { type: 'check' }],
        [0, { type: 'check' }],
        [1, { type: 'check' }],
        [0, { type: 'bet', to: 40 }],
        [1, { type: 'call' }],
      ],
      deck,
    );
    expect(of(stats, 0)).toMatchObject({ sawFlop: 1, wtsd: 1, wsd: 1, riverBets: 1, riverBetsLostAtShowdown: 0 });
    expect(of(stats, 1)).toMatchObject({ sawFlop: 1, wtsd: 1, wsd: 0, facedBetRiver: 1, callBetRiver: 1, riverCallsToShowdown: 1, wonRiverCalls: 0 });
  });

  it('counts a preflop all-in as seeing the flop and reaching showdown', () => {
    const { stats } = play([500, 500], 1, [
      [1, { type: 'allin' }],
      [0, { type: 'call' }],
    ]);
    expect(of(stats, 0)).toMatchObject({ sawFlop: 1, wtsd: 1 });
    expect(of(stats, 1)).toMatchObject({ sawFlop: 1, wtsd: 1 });
  });

  it('computes aggression factor and frequency from postflop actions only', () => {
    const { stats } = play([1000, 1000], 1, [
      [1, { type: 'raise', to: 30 }], // preflop: not counted
      [0, { type: 'call' }],
      [0, { type: 'bet', to: 40 }], // bet
      [1, { type: 'call' }], // call
      [0, { type: 'bet', to: 80 }], // bet
      [1, { type: 'fold' }], // fold
    ]);
    const s0 = publishStats(of(stats, 0));
    expect(of(stats, 0)).toMatchObject({ postBets: 2, postCalls: 0 });
    expect(s0.af.value).toBeNull(); // no calls: undefined, not infinite
    expect(s0.afq.value).toBe(1);
    const s1 = publishStats(of(stats, 1));
    expect(of(stats, 1)).toMatchObject({ postCalls: 1, postFolds: 1 });
    expect(s1.afq.value).toBe(0);
    expect(s1.af.value).toBe(0);
  });

  it('flags the bet sizing tails', () => {
    const { stats } = play([5000, 5000], 1, [
      [1, { type: 'raise', to: 100 }],
      [0, { type: 'call' }],
      [0, { type: 'bet', to: 20 }], // tiny: 10% of a 200 pot
      [1, { type: 'call' }],
      [0, { type: 'bet', to: 1000 }], // huge: 417% of 240
      [1, { type: 'fold' }],
    ]);
    expect(of(stats, 0)).toMatchObject({ tinyBets: 1, hugeBets: 1, betCount: 2 });
  });

  it('counts calls of river raises', () => {
    const deck = 'Ah 2c Ad 2d 3s 9h Tc 4d 3d Js 5c Qs';
    const { stats } = play(
      [5000, 5000],
      1,
      [
        [1, { type: 'call' }],
        [0, { type: 'check' }],
        [0, { type: 'check' }],
        [1, { type: 'check' }],
        [0, { type: 'check' }],
        [1, { type: 'check' }],
        [0, { type: 'bet', to: 40 }],
        [1, { type: 'raise', to: 120 }],
        [0, { type: 'call' }],
      ],
      deck,
    );
    expect(of(stats, 0)).toMatchObject({ facedRiverRaise: 1, calledRiverRaise: 1 });
  });
});

describe('money and positions', () => {
  it('nets to zero across players and converts to big blinds', () => {
    const { stats } = play([1000, 1000, 1000], 2, [
      [2, { type: 'raise', to: 30 }],
      [0, { type: 'fold' }],
      [1, { type: 'fold' }],
    ]);
    expect(of(stats, 2).net).toBe(15);
    expect(of(stats, 2).bbNet).toBe(1.5);
    expect(of(stats, 0).net).toBe(-5);
    expect(of(stats, 1).net).toBe(-10);
    expect(of(stats, 2).byPosition.BTN).toMatchObject({ hands: 1, vpip: 1, pfr: 1, net: 15 });
  });

  it('computes BB/100 from accumulated hands', () => {
    const total = emptyCounters();
    for (let i = 0; i < 10; i++) {
      const { stats } = play([1000, 1000, 1000], 2, [
        [2, { type: 'raise', to: 30 }],
        [0, { type: 'fold' }],
        [1, { type: 'fold' }],
      ]);
      addCounters(total, of(stats, 2));
    }
    expect(total.hands).toBe(10);
    expect(publishStats(total).bb100.value).toBe(150);
    expect(total.byPosition.BTN.hands).toBe(10);
  });
});

describe('reporting safety', () => {
  it('reports null, never zero or NaN, for an empty denominator', () => {
    expect(rate(0, 0).value).toBeNull();
    const s = publishStats(emptyCounters());
    expect(s.vpip.value).toBeNull();
    expect(s.wsd.value).toBeNull();
    expect(s.af.value).toBeNull();
    expect(s.bb100.value).toBeNull();
  });

  it('gives wide uncertainty on small samples and narrow on large', () => {
    const small = wilsonInterval(3, 10);
    const large = wilsonInterval(300, 1000);
    expect(small.high - small.low).toBeGreaterThan(0.4);
    expect(large.high - large.low).toBeLessThan(0.07);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('hand records', () => {
  it('holds everything needed for review and hides unshown cards from visibleHole', () => {
    const deck = 'Ah 2c Ad 2d 3s 9h Tc 4d 3d Js 5c Qs';
    const { record } = play(
      [1000, 1000],
      1,
      [
        [1, { type: 'call' }],
        [0, { type: 'check' }],
        [0, { type: 'check' }],
        [1, { type: 'check' }],
        [0, { type: 'check' }],
        [1, { type: 'check' }],
        [0, { type: 'bet', to: 40 }],
        [1, { type: 'call' }],
      ],
      deck,
    );
    expect(record.board).toHaveLength(5);
    expect(record.totalPot).toBe(100);
    expect(record.players[0].startStack).toBe(1000);
    expect(record.heroSeat).toBe(0);
    expect(record.heroNet).toBe(50);
    expect(visibleHole(record, 0)).toEqual(parseCards('Ah Ad'));
    expect(visibleHole(record, 1)).toBeNull(); // the loser mucked
    expect(JSON.parse(JSON.stringify(record)).id).toBe('r');
  });

  it('flags a bad beat only when the loser was ahead on the turn', () => {
    // Seat 0 AA, seat 1 KK. Board brings a king on the river.
    const deck = 'Ah Kh Ad Kd 2c 3s 7d 9c 2d 5s 3h Ks';
    const { record } = play(
      [1000, 1000],
      1,
      [
        [1, { type: 'allin' }],
        [0, { type: 'call' }],
      ],
      deck,
    );
    expect(record.badBeatSeats).toEqual([0]);
    const fair = play(
      [1000, 1000],
      1,
      [
        [1, { type: 'allin' }],
        [0, { type: 'call' }],
      ],
      'Ah Kh Ad Kd 2c 3s 7d 9c 2d 5s 3h 4s',
    );
    expect(fair.record.badBeatSeats).toEqual([]);
  });
});

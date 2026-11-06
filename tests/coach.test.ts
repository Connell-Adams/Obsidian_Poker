import { describe, expect, it } from 'vitest';
import { computeAllInEquity } from '../src/coach/allIn';
import { reviewHand } from '../src/coach/analyzer';
import { runEquityQuery } from '../src/coach/equityQuery';
import { findLeaks } from '../src/coach/leaks';
import { buildRecommendation } from '../src/coach/training';
import { parseCards } from '../src/engine/cards';
import { Deck } from '../src/engine/deck';
import { Hand, type PlayerAction } from '../src/engine/hand';
import { SeededRng } from '../src/engine/rng';
import { buildHandRecord } from '../src/history/record';
import { emptyCounters, extractHandStats, type StatCounters } from '../src/stats/counters';

type Step = [number, PlayerAction];

function recordOf(stacks: number[], button: number, deck: string, steps: Step[]) {
  const hand = new Hand({
    handNumber: 1,
    players: stacks.map((stack, seat) => ({ seat, id: seat === 0 ? 'hero' : `p${seat}`, name: seat === 0 ? 'Hero' : `P${seat}`, stack })),
    buttonSeat: button,
    smallBlind: 5,
    bigBlind: 10,
    deck: Deck.stacked(parseCards(deck), new SeededRng(4)),
  });
  for (const [seat, action] of steps) {
    const r = hand.act(seat, action);
    if (!r.ok) throw new Error(`Seat ${seat}: ${r.error}`);
  }
  return buildHandRecord(hand, { id: 'r1', sessionId: 's', tableId: 't', tableName: 't', mode: 'cash', maxSeats: 6, heroId: 'hero', now: 1 });
}

const opts = (counters?: Record<string, StatCounters>) => ({ iterations: 6000, rng: new SeededRng('coach'), countersOf: (id: string) => counters?.[id] });

describe('hand review', () => {
  it('flags a river call with too little equity and shows the working', () => {
    // Hero has bottom pair and calls a big river bet from a player modelled as tight.
    const deck = '3c Ah 3d Kh Kd 7c 9s 2h Jc 5d Qs';
    const tight = emptyCounters();
    tight.hands = 300;
    tight.decisions = 300;
    tight.vpip = 36;
    tight.pfr = 30;
    tight.postBets = 8;
    tight.postCalls = 40;
    tight.postFolds = 40;
    const record = recordOf([2000, 2000], 1, deck, [
      [1, { type: 'raise', to: 30 }],
      [0, { type: 'call' }],
      [0, { type: 'check' }],
      [1, { type: 'bet', to: 40 }],
      [0, { type: 'call' }],
      [0, { type: 'check' }],
      [1, { type: 'bet', to: 100 }],
      [0, { type: 'call' }],
      [0, { type: 'check' }],
      [1, { type: 'bet', to: 300 }],
      [0, { type: 'call' }],
    ]);
    const review = reviewHand(record, opts({ p1: tight }))!;
    const river = review.decisions.filter((d) => d.street === 'river' && d.action.startsWith('Call'))[0];
    expect(river).toBeDefined();
    expect(river.requiredEquity).toBeGreaterThan(0.25);
    expect(river.equity).toBeLessThan(river.requiredEquity! - 0.05);
    expect(['questionable', 'mistake']).toContain(river.verdict);
    expect(river.text).toMatch(/break even/);
    expect(river.text).toMatch(/negative EV/);
    expect(river.evLossBB).toBeGreaterThan(0);
    expect(river.known.join(' ')).toMatch(/You held/);
    expect(river.estimated.join(' ')).toMatch(/modelled|observed/);
  });

  it('approves a strong value bet', () => {
    const deck = 'Ah 2c Ad 7d 3s Ac 9c 4d 3d Js 5c Qs';
    const record = recordOf([2000, 2000], 1, deck, [
      [1, { type: 'call' }],
      [0, { type: 'raise', to: 40 }],
      [1, { type: 'call' }],
      [0, { type: 'bet', to: 50 }],
      [1, { type: 'fold' }],
    ]);
    const review = reviewHand(record, opts())!;
    const flop = review.decisions.find((d) => d.street === 'flop')!;
    expect(flop.equity).toBeGreaterThan(0.8);
    expect(['good', 'fine']).toContain(flop.verdict);
  });

  it('does not use hidden opponent cards: identical actions give the same estimate whatever they held', () => {
    const steps: Step[] = [
      [1, { type: 'call' }],
      [0, { type: 'check' }],
      [0, { type: 'bet', to: 10 }],
      [1, { type: 'fold' }],
    ];
    const strong = recordOf([2000, 2000], 1, 'Kh Ah Qd Ad 9c 2s 5h', steps);
    const weak = recordOf([2000, 2000], 1, 'Kh 7h Qd 2d 9c 3s 5h', steps);
    const a = reviewHand(strong, { iterations: 4000, rng: new SeededRng('same'), countersOf: () => undefined })!;
    const b = reviewHand(weak, { iterations: 4000, rng: new SeededRng('same'), countersOf: () => undefined })!;
    const fa = a.decisions.find((d) => d.street === 'flop')!;
    const fb = b.decisions.find((d) => d.street === 'flop')!;
    // Board differs slightly in the stacked deck only for burn cards, so compare the estimates' scale.
    expect(Math.abs(fa.equity! - fb.equity!)).toBeLessThan(0.15);
  });

  it('adds real equity notes only for cards shown at showdown', () => {
    const deck = 'Ah 2c Ad 2d 3s 9h Tc 4d 3d Js 5c Qs';
    const shown = recordOf([1000, 1000], 1, deck, [
      [1, { type: 'call' }],
      [0, { type: 'check' }],
      [0, { type: 'check' }],
      [1, { type: 'check' }],
      [0, { type: 'check' }],
      [1, { type: 'check' }],
      [0, { type: 'bet', to: 40 }],
      [1, { type: 'call' }],
    ]);
    const review = reviewHand(shown, opts())!;
    // The opponent mucked the loser, so no card-based note may appear about them.
    expect(review.showdownNotes.join(' ')).not.toMatch(/P1 showed/);

    const tied = recordOf([1000, 1000], 1, 'Ah Kd Ad Kc 3s 9h Tc 4d 3d Js 5c Qs', [
      [1, { type: 'allin' }],
      [0, { type: 'call' }],
    ]);
    const open = reviewHand(tied, opts())!;
    expect(open.showdownNotes.join(' ')).toMatch(/P1 showed/);
    expect(open.showdownNotes.join(' ')).toMatch(/actual equity/);
  });

  it('returns null without a hero and handles a hand with no decision', () => {
    const hand = recordOf([1000, 1000, 1000], 2, '2c 3c 4c 5c 6c 7c', [
      [2, { type: 'fold' }],
      [0, { type: 'fold' }],
    ]);
    expect(reviewHand({ ...hand, heroSeat: null }, opts())).toBeNull();
    const walk = recordOf([1000, 1000, 1000], 1, '2c 3c 4c 5c 6c 7c', [
      [1, { type: 'fold' }],
      [2, { type: 'fold' }],
    ]);
    const review = reviewHand(walk, opts())!;
    expect(review.decisions).toHaveLength(0);
    expect(review.headline).toMatch(/no decision/);
  });

  it('critiques first-in preflop play against position guidelines', () => {
    // Hero in seat 2 is UTG. Use a separate deal to give hero 72o UTG with a raise.
    const hand = new Hand({
      handNumber: 1,
      players: [0, 1, 2, 3, 4, 5].map((seat) => ({ seat, id: seat === 2 ? 'hero' : `p${seat}`, name: `P${seat}`, stack: 1000 })),
      buttonSeat: 5,
      smallBlind: 5,
      bigBlind: 10,
      deck: Deck.stacked(parseCards('2c 3c 7h 5c 6c 8c 9d Td 2s Qd Kd Ah'), new SeededRng(5)),
    });
    hand.act(2, { type: 'raise', to: 30 });
    for (const seat of [3, 4, 5, 0, 1]) hand.act(seat, { type: 'fold' });
    const r = buildHandRecord(hand, { id: 'x', sessionId: 's', tableId: 't', tableName: 't', mode: 'cash', maxSeats: 6, heroId: 'hero', now: 1 });
    const review = reviewHand(r, opts())!;
    expect(review.decisions[0].verdict).toBe('questionable');
    expect(review.decisions[0].text).toMatch(/wider than/);
  });
});

describe('all-in equity', () => {
  it('computes equity from revealed cards and records luck against expectation', () => {
    const record = recordOf([1000, 1000], 1, 'Ah Kh Ad Kd 2c 3s 7d 9c 2d 5s 3h Ks', [
      [1, { type: 'allin' }],
      [0, { type: 'call' }],
    ]);
    const result = computeAllInEquity(record, new SeededRng(1), 20000)!;
    expect(result).toHaveLength(2);
    const hero = result.find((r) => r.seat === 0)!;
    const villain = result.find((r) => r.seat === 1)!;
    expect(hero.equity).toBeCloseTo(0.82, 1);
    expect(hero.equity + villain.equity).toBeCloseTo(1, 5);
    // Hero was the favourite and lost: negative difference. Villain the reverse.
    expect(hero.evDiff).toBeLessThan(-1000);
    expect(villain.evDiff).toBeGreaterThan(1000);
    expect(hero.evDiff + villain.evDiff).toBeCloseTo(0, 5);
  });

  it('enumerates exactly once a flop is out', () => {
    const record = recordOf([1000, 1000], 1, 'Ah Kh Ad Kd 2c 3s 7d 9c 2d 5s 3h 4s', [
      [1, { type: 'call' }],
      [0, { type: 'check' }],
      [0, { type: 'allin' }],
      [1, { type: 'call' }],
    ]);
    const a = computeAllInEquity(record, new SeededRng(1))!;
    const b = computeAllInEquity(record, new SeededRng(99))!;
    expect(a[0].equity).toBe(b[0].equity); // exact, so no randomness
  });

  it('returns nothing for hands with no all-in', () => {
    const record = recordOf([1000, 1000, 1000], 2, '2c 3c 4c 5c 6c 7c', [
      [2, { type: 'fold' }],
      [0, { type: 'fold' }],
    ]);
    expect(computeAllInEquity(record, new SeededRng(1))).toBeUndefined();
  });

  it('feeds into the statistics', () => {
    const record = recordOf([1000, 1000], 1, 'Ah Kh Ad Kd 2c 3s 7d 9c 2d 5s 3h Ks', [
      [1, { type: 'allin' }],
      [0, { type: 'call' }],
    ]);
    record.allInEquity = computeAllInEquity(record, new SeededRng(1), 5000);
    const stats = extractHandStats(record);
    expect(stats.get('hero')!.allInShowdowns).toBe(1);
    expect(stats.get('hero')!.allInEquitySum).toBeGreaterThan(0.7);
    expect(stats.get('hero')!.allInEvDiff).toBeLessThan(0);
  });
});

describe('leak finder', () => {
  const base = () => {
    const c = emptyCounters();
    c.hands = 1000;
    c.decisions = 1000;
    c.vpip = 240;
    c.pfr = 180;
    return c;
  };

  it('stays silent with no data and with insufficient samples', () => {
    expect(findLeaks(emptyCounters())).toEqual([]);
    const small = base();
    small.facedBetRiver = 10;
    small.callBetRiver = 10; // 100% of a sample that is too small to mean anything
    expect(findLeaks(small).find((l) => l.id === 'calling_river')).toBeUndefined();
  });

  it('finds a river-calling leak, with evidence, sample, impact and a fix', () => {
    const c = base();
    c.facedBetRiver = 120;
    c.callBetRiver = 96;
    const leak = findLeaks(c).find((l) => l.id === 'calling_river')!;
    expect(leak).toBeDefined();
    expect(leak.sampleSize).toBe(120);
    expect(leak.evidence).toMatch(/80%/);
    expect(leak.estimatedImpactBB100).toBeGreaterThan(0);
    expect(leak.correction.length).toBeGreaterThan(20);
    expect(leak.confidence).toBe('supported');
  });

  it('calls a borderline sample a tendency, not a proven error', () => {
    const c = base();
    c.faced3Bet = 22;
    c.foldTo3Bet = 18; // 82%, whose interval still overlaps the healthy range
    const leak = findLeaks(c).find((l) => l.id === 'folding_to_3bets')!;
    expect(leak).toBeDefined();
    expect(leak.confidence).toBe('tendency');
  });

  it('detects big blind under-defence and early-position looseness', () => {
    const c = base();
    c.bbFacedSteal = 100;
    c.bbDefend = 15;
    c.byPosition.UTG = { hands: 120, decisions: 120, vpip: 60, pfr: 40, net: -2000, bbNet: -200 };
    const ids = findLeaks(c).map((l) => l.id);
    expect(ids).toContain('bb_underdefend');
    expect(ids).toContain('ep_too_loose');
    expect(ids).toContain('position_UTG');
  });

  it('reports nothing for a healthy player', () => {
    const c = base();
    c.faced3Bet = 60;
    c.foldTo3Bet = 33;
    c.cbetOpp = 100;
    c.cbet = 62;
    c.facedCbet = 100;
    c.foldToCbet = 45;
    c.facedBetRiver = 60;
    c.callBetRiver = 26;
    c.bbFacedSteal = 80;
    c.bbDefend = 44;
    expect(findLeaks(c)).toEqual([]);
  });

  it('tracks progress across windows', () => {
    const c = base();
    c.facedBetRiver = 200;
    c.callBetRiver = 150;
    const window = (faced: number, called: number) => {
      const w = emptyCounters();
      w.hands = 25;
      w.facedBetRiver = faced;
      w.callBetRiver = called;
      return w;
    };
    const improving = findLeaks(c, { windows: [window(10, 9), window(10, 9), window(10, 5), window(10, 4)] }).find((l) => l.id === 'calling_river')!;
    expect(improving.progress.direction).toBe('improving');
    const worsening = findLeaks(c, { windows: [window(10, 4), window(10, 4), window(10, 9), window(10, 9)] }).find((l) => l.id === 'calling_river')!;
    expect(worsening.progress.direction).toBe('worsening');
    const unknown = findLeaks(c).find((l) => l.id === 'calling_river')!;
    expect(unknown.progress.direction).toBe('unknown');
  });
});

describe('training recommendations', () => {
  const reviewed = { good: 40, fine: 40, close: 10, questionable: 5, mistake: 5 };

  it('does not advise a difficulty change after a short lucky run', () => {
    const c = emptyCounters();
    c.hands = 100;
    c.decisions = 100;
    c.bbNet = 400; // +400 BB/100, but only 100 hands
    const rec = buildRecommendation({ career: c, windows: [], currentDifficulty: 5, reviewed, now: 1 });
    expect(rec.difficulty).toBe('keep');
    expect(rec.difficultyReason).toMatch(/too few/);
  });

  it('advises raising only when the win rate clears the uncertainty', () => {
    const c = emptyCounters();
    c.hands = 20000;
    c.decisions = 20000;
    c.vpip = 5000;
    c.pfr = 4000;
    c.bbNet = 3000; // 15 BB/100
    expect(buildRecommendation({ career: c, windows: [], currentDifficulty: 5, reviewed, now: 1 }).difficulty).toBe('raise');
    expect(buildRecommendation({ career: c, windows: [], currentDifficulty: 10, reviewed, now: 1 }).difficulty).toBe('keep');
    const noisy = { ...c, hands: 600, decisions: 600, bbNet: 60 };
    expect(buildRecommendation({ career: noisy, windows: [], currentDifficulty: 5, reviewed, now: 1 }).difficulty).toBe('keep');
  });

  it('advises lowering only on a clear, sustained loss', () => {
    const c = emptyCounters();
    c.hands = 20000;
    c.decisions = 20000;
    c.vpip = 5000;
    c.pfr = 4000;
    c.bbNet = -6000; // -30 BB/100
    expect(buildRecommendation({ career: c, windows: [], currentDifficulty: 5, reviewed, now: 1 }).difficulty).toBe('lower');
  });

  it('names the biggest leak as the training focus', () => {
    const c = emptyCounters();
    c.hands = 800;
    c.decisions = 800;
    c.vpip = 200;
    c.pfr = 150;
    c.facedBetRiver = 100;
    c.callBetRiver = 85;
    const rec = buildRecommendation({ career: c, windows: [], currentDifficulty: 5, reviewed, now: 1 });
    expect(rec.focus).toMatch(/river/i);
    expect(rec.weakest.length).toBeGreaterThan(0);
    expect(rec.level).not.toBe('Gathering data');
  });

  it('asks for more data at the very start', () => {
    const rec = buildRecommendation({ career: emptyCounters(), windows: [], currentDifficulty: 5, reviewed: { good: 0, fine: 0, close: 0, questionable: 0, mistake: 0 }, now: 1 });
    expect(rec.level).toBe('Gathering data');
    expect(rec.focus).toBe('Build a sample');
  });
});

describe('equity calculator queries', () => {
  const rng = new SeededRng('query');

  it('handles hand vs hand exactly', () => {
    const r = runEquityQuery({ sideA: 'AsAh', sideB: 'KdKc', board: '', iterations: 1000 }, rng);
    expect(r.mode).toBe('hand_vs_hand');
    expect(r.a.exact).toBe(true);
    expect(r.a.equity + r.bEquity).toBeCloseTo(1, 10);
  });

  it('handles hand vs range and range vs hand consistently', () => {
    const board = 'Kh 7d 2c 3s';
    const a = runEquityQuery({ sideA: 'KsQs', sideB: 'TT+, AQs+', board, iterations: 1000 }, rng);
    const b = runEquityQuery({ sideA: 'TT+, AQs+', sideB: 'KsQs', board, iterations: 1000 }, rng);
    expect(a.mode).toBe('hand_vs_range');
    expect(b.mode).toBe('range_vs_hand');
    expect(a.a.equity).toBeCloseTo(b.bEquity, 5);
  });

  it('handles range vs range', () => {
    const r = runEquityQuery({ sideA: 'top10%', sideB: 'top40%', board: '', iterations: 8000 }, rng);
    expect(r.mode).toBe('range_vs_range');
    expect(r.a.equity).toBeGreaterThan(0.55);
    expect(r.a.exact).toBe(false);
  });

  it('rejects bad boards and impossible combinations with readable errors', () => {
    expect(() => runEquityQuery({ sideA: 'AsAh', sideB: 'KdKc', board: 'Ks Qd', iterations: 100 }, rng)).toThrow(/0, 3, 4 or 5/);
    expect(() => runEquityQuery({ sideA: 'AsAh', sideB: 'AsKc', board: '', iterations: 100 }, rng)).toThrow(/Duplicate/);
    expect(() => runEquityQuery({ sideA: 'AsAh', sideB: 'banana', board: '', iterations: 100 }, rng)).toThrow(/Cannot read/);
  });
});

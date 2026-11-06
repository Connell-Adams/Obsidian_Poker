import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/brain';
import { chatReaction } from '../src/ai/chat';
import { type Decision, decide, enforceLegal } from '../src/ai/decision';
import { effectiveStyle, neutralEmotions, updateEmotions } from '../src/ai/emotions';
import { ARCHETYPES, type Archetype, createBotProfile, skillFor } from '../src/ai/profiles';
import { estimateRange, toRange } from '../src/ai/rangeEstimate';
import { buildPublicView } from '../src/ai/view';
import { parseCards } from '../src/engine/cards';
import { Deck } from '../src/engine/deck';
import { Hand, type LegalActions } from '../src/engine/hand';
import { SeededRng } from '../src/engine/rng';
import { PokerTable } from '../src/engine/table';
import { rangeCombos } from '../src/equity/range';
import { buildHandRecord } from '../src/history/record';
import { buildRead, emptyCounters, ObservedStats, publishStats, type StatCounters, addCounters } from '../src/stats/counters';

const profileOf = (archetype: Archetype, difficulty = 6, seed = 'p') =>
  createBotProfile({ id: `bot-${archetype}`, name: archetype, difficulty, archetype, rng: new SeededRng(`${seed}-${archetype}`) });

/** Plays a mixed table and returns published stats per archetype. */
function simulate(line: Archetype[], hands: number, seed: string, difficulty = 6): Map<Archetype, StatCounters> {
  const rng = new SeededRng(seed);
  const table = new PokerTable({ maxSeats: line.length, smallBlind: 5, bigBlind: 10, rng });
  const observed = new ObservedStats();
  const brains = line.map((archetype, i) => {
    const profile = createBotProfile({ id: `b${i}`, name: `B${i}`, difficulty, archetype, rng });
    table.sit(i, { id: profile.id, name: profile.name, stack: 1000 });
    return new BotBrain(profile, new SeededRng(`${seed}-${i}`));
  });
  for (let h = 0; h < hands; h++) {
    for (let i = 0; i < line.length; i++) table.seats[i]!.stack = 1000;
    const hand = table.startHand();
    while (!hand.isComplete) {
      const seat = hand.actorSeat!;
      const d = brains[seat].decide(buildPublicView(hand, seat), (id) => observed.get(id));
      const r = hand.act(seat, d.action);
      if (!r.ok) throw new Error(`Illegal: ${JSON.stringify(d.action)} ${r.error}`);
    }
    const record = buildHandRecord(hand, { id: `${h}`, sessionId: 's', tableId: 't', tableName: 't', mode: 'cash', maxSeats: line.length, heroId: null, now: 0 });
    observed.addRecord(record);
    table.settleHand();
  }
  const out = new Map<Archetype, StatCounters>();
  line.forEach((archetype, i) => {
    const total = out.get(archetype) ?? emptyCounters();
    addCounters(total, observed.get(`b${i}`)!);
    out.set(archetype, total);
  });
  return out;
}

describe('legal action generation', () => {
  it('never produces an illegal action across every archetype and stack depth', () => {
    const r = new SeededRng('legal');
    const brains = ARCHETYPES.flatMap((archetype, i) => [1, 5, 10].map((difficulty) => new BotBrain(createBotProfile({ id: `b${i}-${difficulty}`, name: 'x', difficulty, archetype, rng: r }), r)));
    for (let trial = 0; trial < 1500; trial++) {
      const n = 2 + r.int(8);
      const hand = new Hand({
        handNumber: trial,
        players: Array.from({ length: n }, (_, seat) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack: 1 + r.int(r.next() < 0.3 ? 80 : 3000) })),
        buttonSeat: r.int(n),
        smallBlind: 5,
        bigBlind: 10,
        ante: r.next() < 0.2 ? 2 : 0,
        deck: Deck.shuffled(r),
      });
      let guard = 0;
      while (!hand.isComplete) {
        if (++guard > 300) throw new Error('Runaway hand');
        const seat = hand.actorSeat!;
        const brain = brains[r.int(brains.length)];
        const decision = brain.decide(buildPublicView(hand, seat), () => undefined, r.next() < 0.3);
        const result = hand.act(seat, decision.action);
        if (!result.ok) throw new Error(`${brain.profile.archetype}: ${JSON.stringify(decision.action)}: ${result.error}`);
      }
    }
  }, 60000);

  it('degrades impossible actions to the safest legal one', () => {
    const base: LegalActions = {
      seat: 0, canFold: true, canCheck: true, canCall: false, callAmount: 0, callIsAllIn: false, canBet: false, canRaise: false,
      minTo: 0, maxTo: 0, shortAllInOnly: false, canAllIn: false, pot: 100, currentBet: 0, streetBet: 0, stack: 100, bigBlind: 10, lastRaiseSize: 10,
    };
    expect(enforceLegal({ type: 'fold' }, base)).toEqual({ type: 'check' });
    expect(enforceLegal({ type: 'raise', to: 500 }, base)).toEqual({ type: 'check' });
    expect(enforceLegal({ type: 'allin' }, base)).toEqual({ type: 'check' });
    const facing = { ...base, canCheck: false, canCall: true, callAmount: 50 };
    expect(enforceLegal({ type: 'check' }, facing)).toEqual({ type: 'fold' });
    expect(enforceLegal({ type: 'raise', to: 500 }, facing)).toEqual({ type: 'call' });
  });
});

describe('personalities behave differently', () => {
  const line: Archetype[] = ['nit', 'maniac', 'calling_station', 'tag', 'lag', 'abc'];
  const stats = simulate(line, 1800, 'personalities');
  const pub = (a: Archetype) => publishStats(stats.get(a)!);

  it('orders VPIP from tight to loose', () => {
    expect(pub('nit').vpip.value!).toBeLessThan(pub('tag').vpip.value!);
    expect(pub('tag').vpip.value!).toBeLessThan(pub('lag').vpip.value!);
    expect(pub('nit').vpip.value!).toBeLessThan(0.25);
    expect(pub('maniac').vpip.value!).toBeGreaterThan(0.35);
    expect(pub('calling_station').vpip.value!).toBeGreaterThan(0.35);
  });

  it('separates passive callers from aggressors', () => {
    expect(pub('calling_station').pfr.value!).toBeLessThan(pub('maniac').pfr.value! * 0.6);
    expect(pub('calling_station').afq.value!).toBeLessThan(pub('maniac').afq.value!);
    expect(pub('maniac').threeBet.value!).toBeGreaterThan(pub('nit').threeBet.value!);
  });

  it('makes stations reach showdown more and fold less than nits', () => {
    expect(pub('calling_station').wtsd.value!).toBeGreaterThan(pub('nit').wtsd.value!);
    expect(pub('calling_station').foldToCbet.value!).toBeLessThan(pub('nit').foldToCbet.value!);
  });
});

describe('decisions respond to context', () => {
  /** Runs one decision many times for a stable frequency. */
  const frequency = (makeHand: () => Hand, archetype: Archetype, seat: number, test: (d: Decision) => boolean, trials = 150, difficulty = 7): number => {
    let hits = 0;
    for (let i = 0; i < trials; i++) {
      const rng = new SeededRng(`f-${archetype}-${i}`);
      const hand = makeHand();
      const profile = createBotProfile({ id: 'x', name: 'x', difficulty, archetype, rng });
      const d = decide({ profile, mood: neutralEmotions(), view: buildPublicView(hand, seat), countersOf: () => undefined, rng });
      if (test(d)) hits++;
    }
    return hits / trials;
  };

  const handWith = (order: string, stacks: number[], button: number) => () =>
    new Hand({
      handNumber: 1,
      players: stacks.map((stack, seat) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack })),
      buttonSeat: button,
      smallBlind: 5,
      bigBlind: 10,
      deck: Deck.stacked(parseCards(order), new SeededRng(9)),
    });

  const isAggressive = (d: Decision) => ['raise', 'bet', 'allin'].includes(d.action.type);

  it('opens the same hand far more often in late position than early', () => {
    // Six seats, button on seat 5. Seat 2 is UTG. To reach the button, seats 2-4 fold.
    const cards = '2c 3c Kh 4d 5d 6d 7h 8h 9d Ts Td 2d'; // seat 2 holds K9o
    const utg = frequency(handWith(cards, [1000, 1000, 1000, 1000, 1000, 1000], 5), 'tag', 2, isAggressive);
    const btnCards = '2c 3c 4c 5s 6s Kh 7h 8h 9h Ts Jh 9d'; // seat 5 holds K9o
    const btn = frequency(
      () => {
        const h = handWith(btnCards, [1000, 1000, 1000, 1000, 1000, 1000], 5)();
        h.act(2, { type: 'fold' });
        h.act(3, { type: 'fold' });
        h.act(4, { type: 'fold' });
        return h;
      },
      'tag',
      5,
      isAggressive,
    );
    expect(btn).toBeGreaterThan(utg + 0.3);
  });

  it('shoves wider when short than when deep with the same weak ace', () => {
    // Hero on the button with A4o, folded to. Deal order is seat 0, 1, 2, then again.
    const cards = '2c 3c Ad 5c 6c 4h';
    const shortShove = frequency(handWith(cards, [1000, 1000, 80], 2), 'short_stack', 2, (d) => d.action.type === 'allin');
    const deepShove = frequency(handWith(cards, [1000, 1000, 1000], 2), 'short_stack', 2, (d) => d.action.type === 'allin');
    expect(shortShove).toBeGreaterThan(0.5);
    expect(deepShove).toBeLessThan(0.1);
  });

  it('calls with a price and folds without one holding a marginal draw', () => {
    // Seat 0 acts second heads-up postflop? Use river-less flop: hero has a gutshot.
    const makeFacing = (bet: number) => () => {
      const h = handWith('9h 8d Kc 7c 2c 5s Jd Tc 3s 2h', [2000, 2000], 1)();
      h.act(1, { type: 'call' });
      h.act(0, { type: 'check' });
      h.act(0, { type: 'check' });
      h.act(1, { type: 'bet', to: bet });
      return h;
    };
    // Seat 0 holds 9h Kc? Deal order: seat 0 gets 9h, seat 1 gets 8d, seat 0 Kc, seat 1 7c.
    const cheap = frequency(makeFacing(10), 'abc', 0, (d) => d.action.type !== 'fold', 120);
    const dear = frequency(makeFacing(400), 'abc', 0, (d) => d.action.type !== 'fold', 120);
    expect(cheap).toBeGreaterThan(dear);
  });

  it('bluffs more with a bluff-heavy personality than a nit', () => {
    const facingCheck = () => {
      // Seat 1 is the button with 7c 2d on an unconnected board, checked to.
      const h = handWith('Ah 7c Kd 2d 3s Qs 9h 4c', [2000, 2000], 1)();
      h.act(1, { type: 'call' });
      h.act(0, { type: 'check' });
      h.act(0, { type: 'check' });
      return h;
    };
    const bluffer = frequency(facingCheck, 'aggressive_bluffer', 1, (d) => d.action.type === 'bet');
    const nit = frequency(facingCheck, 'nit', 1, (d) => d.action.type === 'bet');
    expect(bluffer).toBeGreaterThan(nit + 0.15);
  });

  it('marks modelled errors separately from informed decisions', () => {
    const rng = new SeededRng('mistakes');
    let mistakes = 0;
    for (let i = 0; i < 400; i++) {
      const h = handWith('Ah 2c Kd 7h 3s Ks 8d 4c', [2000, 2000], 1)();
      h.act(1, { type: 'call' });
      h.act(0, { type: 'check' });
      const profile = createBotProfile({ id: 'x', name: 'x', difficulty: 1, archetype: 'recreational', rng });
      const d = decide({ profile, mood: neutralEmotions(), view: buildPublicView(h, 0), countersOf: () => undefined, rng });
      if (d.basis === 'mistake') {
        mistakes++;
        expect(d.mistake).toBeTruthy();
      }
    }
    expect(mistakes).toBeGreaterThan(20);
    // A top-difficulty thinker should be close to never making a scripted mistake.
    let strong = 0;
    for (let i = 0; i < 400; i++) {
      const h = handWith('Ah 2c Kd 7h 3s Ks 8d 4c', [2000, 2000], 1)();
      h.act(1, { type: 'call' });
      h.act(0, { type: 'check' });
      const profile = createBotProfile({ id: 'x', name: 'x', difficulty: 10, archetype: 'gto_reg', rng });
      if (decide({ profile, mood: neutralEmotions(), view: buildPublicView(h, 0), countersOf: () => undefined, rng }).basis === 'mistake') strong++;
    }
    expect(strong).toBeLessThan(mistakes / 5);
  });
});

describe('tilt and emotions', () => {
  const nit = profileOf('nit');
  const pro = profileOf('gto_reg');
  const badBeat = { netBB: -100, stackFraction: -1, badBeat: true, wonShowdown: false };
  const quiet = { netBB: 0, stackFraction: 0, badBeat: false, wonShowdown: false };

  it('activates after a bad beat or a big loss', () => {
    const after = updateEmotions(neutralEmotions(), badBeat, nit.attrs);
    expect(after.tilt).toBeGreaterThan(0.2);
    expect(after.frustration).toBeGreaterThan(0.2);
    expect(updateEmotions(neutralEmotions(), { ...quiet, stackFraction: -0.6, netBB: -60 }, nit.attrs).tilt).toBeGreaterThan(0.1);
    expect(updateEmotions(neutralEmotions(), { ...quiet, stackFraction: -0.05, netBB: -5 }, nit.attrs).tilt).toBe(0);
  });

  it('hits tilt-prone players harder than resilient ones', () => {
    const maniac = profileOf('maniac');
    expect(updateEmotions(neutralEmotions(), badBeat, maniac.attrs).tilt).toBeGreaterThan(updateEmotions(neutralEmotions(), badBeat, pro.attrs).tilt);
  });

  it('recovers gradually rather than staying tilted', () => {
    let mood = updateEmotions(neutralEmotions(), badBeat, nit.attrs);
    const peak = mood.tilt;
    let prev = peak;
    for (let i = 0; i < 40; i++) {
      mood = updateEmotions(mood, quiet, nit.attrs);
      expect(mood.tilt).toBeLessThanOrEqual(prev);
      prev = mood.tilt;
    }
    expect(mood.tilt).toBeLessThan(peak * 0.1);
  });

  it('changes the style in the archetype direction', () => {
    const tilted = { ...neutralEmotions(), tilt: 0.9 };
    const calm = effectiveStyle(nit, neutralEmotions());
    const hot = effectiveStyle(nit, tilted);
    expect(hot.aggression).toBeGreaterThan(calm.aggression);
    expect(hot.patience).toBeLessThan(calm.patience);
    const rec = profileOf('recreational');
    expect(effectiveStyle(rec, tilted).aggression).toBeLessThan(effectiveStyle(rec, neutralEmotions()).aggression);
    const station = profileOf('calling_station');
    expect(effectiveStyle(station, tilted).calling).toBeGreaterThanOrEqual(effectiveStyle(station, neutralEmotions()).calling);
    expect(hot.skill).toBeLessThan(calm.skill);
  });

  it('makes a tilted nit play more hands', () => {
    const run = (tilt: number) => {
      let played = 0;
      for (let i = 0; i < 400; i++) {
        const rng = new SeededRng(`t-${tilt}-${i}`);
        const hand = new Hand({
          handNumber: 1,
          players: Array.from({ length: 6 }, (_, seat) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack: 1000 })),
          buttonSeat: 5,
          smallBlind: 5,
          bigBlind: 10,
          deck: Deck.shuffled(rng),
        });
        const d = decide({ profile: nit, mood: { ...neutralEmotions(), tilt }, view: buildPublicView(hand, hand.actorSeat!), countersOf: () => undefined, rng });
        if (d.action.type !== 'fold') played++;
      }
      return played;
    };
    expect(run(1)).toBeGreaterThan(run(0) + 15);
  });
});

describe('adapting to the player', () => {
  const countersShowing = (hands: number, folds: number): StatCounters => {
    const c = emptyCounters();
    c.hands = hands;
    c.decisions = hands;
    c.blindFacedSteal = hands;
    c.blindFoldSteal = Math.round(hands * folds);
    c.facedBetFlop = hands;
    c.foldBetFlop = Math.round(hands * folds);
    c.facedCbet = hands;
    c.foldToCbet = Math.round(hands * folds);
    return c;
  };

  const stealRate = (counters: StatCounters | undefined, seedPrefix: string) => {
    let raises = 0;
    for (let i = 0; i < 600; i++) {
      const rng = new SeededRng(`${seedPrefix}-${i}`);
      const hand = new Hand({
        handNumber: 1,
        players: Array.from({ length: 6 }, (_, seat) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack: 1000 })),
        buttonSeat: 5,
        smallBlind: 5,
        bigBlind: 10,
        deck: Deck.shuffled(rng),
      });
      hand.act(2, { type: 'fold' });
      hand.act(3, { type: 'fold' });
      hand.act(4, { type: 'fold' });
      const profile = createBotProfile({ id: 'x', name: 'x', difficulty: 9, archetype: 'exploitative_pro', rng });
      const d = decide({ profile, mood: neutralEmotions(), view: buildPublicView(hand, 5), countersOf: () => counters, rng });
      if (d.action.type === 'raise') raises++;
    }
    return raises / 600;
  };

  it('steals more against players who over-fold their blinds, given a real sample', () => {
    const overfolder = stealRate(countersShowing(400, 0.92), 'a');
    const defender = stealRate(countersShowing(400, 0.15), 'b');
    expect(overfolder).toBeGreaterThan(defender + 0.04);
  });

  it('does not overreact to a handful of hands', () => {
    const tiny = stealRate(countersShowing(6, 1), 'c');
    const none = stealRate(undefined, 'd');
    expect(Math.abs(tiny - none)).toBeLessThan(0.05);
  });

  it('shrinks small samples toward the population', () => {
    const c = emptyCounters();
    c.decisions = 4;
    c.vpip = 4;
    expect(buildRead(c).vpip).toBeLessThan(0.45);
    const big = emptyCounters();
    big.decisions = 1000;
    big.vpip = 900;
    expect(buildRead(big).vpip).toBeGreaterThan(0.85);
  });
});

describe('range estimation stays honest', () => {
  it('narrows when a player raises, and never needs anyone hole cards', () => {
    const rng = new SeededRng('range');
    const hand = new Hand({
      handNumber: 1,
      players: Array.from({ length: 3 }, (_, seat) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack: 1000 })),
      buttonSeat: 2,
      smallBlind: 5,
      bigBlind: 10,
      deck: Deck.shuffled(rng),
    });
    hand.act(2, { type: 'raise', to: 30 });
    const view = buildPublicView(hand, 0);
    // The view's serialized form holds only this player's two hole cards.
    const others = hand.players.filter((p) => p.seat !== 0).flatMap((p) => p.hole);
    const serialized = JSON.stringify({ ...view, hole: null, legal: null });
    for (const card of others) expect(serialized.includes(`"hole":[${card}`)).toBe(false);
    expect(Object.keys(view.players[0])).not.toContain('hole');

    const ctx = { players: view.players, actions: view.actions, boardByStreet: view.boardByStreet, dead: [...view.hole], bigBlind: 10 };
    const raiser = estimateRange(ctx, 2, buildRead(undefined));
    const unknown = estimateRange(ctx, 1, buildRead(undefined));
    expect(rangeCombos(toRange(raiser))).toBeLessThan(rangeCombos(toRange(unknown)) * 0.5);
  });
});

describe('thinking times and tells', () => {
  const makeHand = (rng: SeededRng) =>
    new Hand({
      handNumber: 1,
      players: Array.from({ length: 4 }, (_, seat) => ({ seat, id: `p${seat}`, name: `P${seat}`, stack: 1000 })),
      buttonSeat: 3,
      smallBlind: 5,
      bigBlind: 10,
      deck: Deck.shuffled(rng),
    });

  it('stays in a human range and varies, with snaps and occasional tanks', () => {
    const rng = new SeededRng('timing');
    const times: number[] = [];
    const kinds = new Set<string>();
    for (let i = 0; i < 1500; i++) {
      const hand = makeHand(rng);
      const brain = new BotBrain(profileOf(ARCHETYPES[i % ARCHETYPES.length]), rng);
      const view = buildPublicView(hand, hand.actorSeat!);
      const t = brain.thinkTime(brain.decide(view, () => undefined), view);
      times.push(t.ms);
      kinds.add(t.kind);
      expect(t.ms).toBeGreaterThanOrEqual(350);
      expect(t.ms).toBeLessThanOrEqual(13000);
    }
    expect(kinds).toEqual(new Set(['snap', 'normal', 'tank']));
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    expect(median).toBeGreaterThan(800);
    expect(median).toBeLessThan(6000);
  });

  it('gives only an imperfect tell: strong hands are snappier but not reliably so', () => {
    const rng = new SeededRng('tells');
    const profile = profileOf('abc');
    const brain = new BotBrain(profile, rng);
    const hand = makeHand(rng);
    const view = buildPublicView(hand, hand.actorSeat!);
    const call = (strength: number): Decision => ({ action: { type: 'call' }, basis: 'ev', equity: strength, potOdds: 0.3, complexity: 0.4, strength, candidates: [] });
    const snaps = (strength: number) => {
      let n = 0;
      for (let i = 0; i < 3000; i++) if (brain.thinkTime(call(strength), view).kind === 'snap') n++;
      return n / 3000;
    };
    const strong = snaps(0.9);
    const medium = snaps(0.5);
    expect(strong).toBeGreaterThan(medium + 0.05);
    expect(strong).toBeLessThan(0.5); // far from a giveaway
  });
});

describe('difficulty and chat', () => {
  it('raises skill with difficulty for every archetype', () => {
    for (const a of ARCHETYPES) {
      for (let d = 2; d <= 10; d++) expect(skillFor(d, a)).toBeGreaterThanOrEqual(skillFor(d - 1, a));
    }
  });

  it('keeps chat occasional and quiet for quiet personalities', () => {
    const rng = new SeededRng('chat');
    let maniac = 0;
    let nit = 0;
    for (let i = 0; i < 500; i++) {
      if (chatReaction('big_win', profileOf('maniac'), 0, rng)) maniac++;
      if (chatReaction('big_win', profileOf('nit'), 0, rng)) nit++;
    }
    expect(maniac).toBeGreaterThan(nit * 2);
    expect(maniac).toBeLessThan(400);
  });
});

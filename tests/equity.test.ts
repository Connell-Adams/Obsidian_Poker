import { describe, expect, it } from 'vitest';
import { analyzeBoard, analyzeHand } from '../src/ai/features';
import { parseCards } from '../src/engine/cards';
import { SeededRng } from '../src/engine/rng';
import { equityVsRange, handVsHandExact, handVsRangeExact, multiwayEquity, rangeVsRange } from '../src/equity/equity';
import { CLASS_PERCENTILE, parseRange, rangeCombos, topPercentRange } from '../src/equity/range';

const hand = (text: string) => parseCards(text) as [number, number];
const rng = () => new SeededRng('equity-tests');

describe('exact equity', () => {
  it('matches well-known preflop matchups', () => {
    const aaVsKk = handVsHandExact(hand('As Ah'), hand('Kd Kc'), []).equity;
    expect(aaVsKk).toBeGreaterThan(0.81); // published AA vs KK: 81-83% depending on suits
    expect(aaVsKk).toBeLessThan(0.83);
    expect(handVsHandExact(hand('Ah Kh'), hand('Qs Qd'), []).equity).toBeCloseTo(0.4624, 1);
    expect(handVsHandExact(hand('As Ah'), hand('7d 2c'), []).equity).toBeGreaterThan(0.87);
  }, 30000);

  it('is symmetric: the two sides always add up to one', () => {
    const board = parseCards('2s 7s 9c');
    const a = handVsHandExact(hand('As Ks'), hand('Qh Qd'), board);
    const b = handVsHandExact(hand('Qh Qd'), hand('As Ks'), board);
    expect(a.equity + b.equity).toBeCloseTo(1, 10);
    expect(a.exact).toBe(true);
  });

  it('computes a known turn scenario exactly: flush draw has 9 of 44 outs plus pair outs', () => {
    // Heart draw against a set-free top pair. Nine hearts win; three aces also win for the draw.
    const board = parseCards('Kh 7h 2c 3d');
    const r = handVsHandExact(hand('Ah Qh'), hand('Ks Jd'), board);
    expect(r.samples).toBe(44);
    expect(r.equity).toBeCloseTo((9 + 3) / 44, 5);
  });

  it('reports a dead-certain river', () => {
    const board = parseCards('2c 7d 9h Js 3c');
    expect(handVsHandExact(hand('Ah Ad'), hand('Kh Kd'), board).equity).toBe(1);
    expect(handVsHandExact(hand('Kh Kd'), hand('Ah Ad'), board).equity).toBe(0);
  });

  it('splits a chop evenly', () => {
    const board = parseCards('As Ks Qs Js Ts');
    const r = handVsHandExact(hand('2c 3d'), hand('4h 5c'), board);
    expect(r.equity).toBe(0.5);
    expect(r.tie).toBe(1);
  });

  it('rejects duplicate cards', () => {
    expect(() => handVsHandExact(hand('As Ah'), hand('As Kc'), [])).toThrow(/Duplicate/);
  });
});

describe('ranges', () => {
  it('parses the common notations', () => {
    expect(rangeCombos(parseRange('AA'))).toBe(6);
    expect(rangeCombos(parseRange('AKs'))).toBe(4);
    expect(rangeCombos(parseRange('AKo'))).toBe(12);
    expect(rangeCombos(parseRange('AK'))).toBe(16);
    expect(rangeCombos(parseRange('QQ+'))).toBe(18);
    expect(rangeCombos(parseRange('99-77'))).toBe(18);
    expect(rangeCombos(parseRange('ATs+'))).toBe(16);
    expect(rangeCombos(parseRange('A9s-A7s'))).toBe(12);
    expect(rangeCombos(parseRange('AsKd'))).toBe(1);
    expect(rangeCombos(parseRange('QQ+, AKs'))).toBe(22);
    expect(rangeCombos(parseRange('AA, AA'))).toBe(6);
  });

  it('has a sensible top-percent range', () => {
    const top = topPercentRange(0.05);
    expect(rangeCombos(top) / 1326).toBeCloseTo(0.05, 1);
    expect(CLASS_PERCENTILE['AA']).toBeLessThan(CLASS_PERCENTILE['KK']);
    expect(CLASS_PERCENTILE['AKs']).toBeLessThan(CLASS_PERCENTILE['72o']);
    expect(CLASS_PERCENTILE['72o']).toBeGreaterThan(0.95);
  });

  it('gives a useful error on nonsense', () => {
    expect(() => parseRange('hello')).toThrow(/Cannot read/);
    expect(() => parseRange('')).toThrow(/empty/);
  });
});

describe('Monte Carlo agrees with exact', () => {
  it('hand versus hand', () => {
    const board = parseCards('2s 7s 9c');
    const exact = handVsHandExact(hand('As Ks'), hand('Qh Qd'), board).equity;
    const mc = multiwayEquity(hand('As Ks'), [parseRange('QhQd')], board, 40000, rng());
    expect(Math.abs(mc.equity - exact)).toBeLessThan(4 * mc.stderr + 0.002);
    expect(mc.exact).toBe(false);
  });

  it('hand versus range', () => {
    const board = parseCards('Kh 7d 2c');
    const range = parseRange('TT+, AQs+, AKo');
    const exact = handVsRangeExact(hand('Ks Qs'), range, board).equity;
    const mc = multiwayEquity(hand('Ks Qs'), [range], board, 40000, rng());
    expect(Math.abs(mc.equity - exact)).toBeLessThan(4 * mc.stderr + 0.003);
  });

  it('picks exact enumeration on the river and turn and says so', () => {
    const range = parseRange('TT+, AQs+');
    expect(equityVsRange(hand('Ks Qs'), range, parseCards('Kh 7d 2c 3s 9d'), { iterations: 100, rng: rng() }).exact).toBe(true);
    expect(equityVsRange(hand('Ks Qs'), range, parseCards('Kh 7d 2c 3s'), { iterations: 100, rng: rng() }).exact).toBe(true);
    expect(equityVsRange(hand('Ks Qs'), topPercentRange(1), [], { iterations: 200, rng: rng() }).exact).toBe(false);
  });

  it('range versus range sums to one with its mirror', () => {
    const a = parseRange('QQ+, AKs');
    const b = parseRange('77-99, AJs');
    const ab = rangeVsRange(a, b, [], 30000, rng());
    const ba = rangeVsRange(b, a, [], 30000, new SeededRng('mirror'));
    expect(ab.equity + ba.equity).toBeCloseTo(1, 1);
    expect(ab.equity).toBeGreaterThan(0.6);
  });

  it('respects card removal: AA facing a range of aces cannot collide', () => {
    const r = multiwayEquity(hand('As Ah'), [parseRange('AA')], [], 5000, rng());
    expect(r.equity).toBeCloseTo(0.5, 1); // only AdAc is possible, a near-certain chop
  });

  it('falls with more opponents', () => {
    const one = multiwayEquity(hand('Ts Th'), [topPercentRange(1)], [], 8000, rng()).equity;
    const three = multiwayEquity(hand('Ts Th'), [topPercentRange(1), topPercentRange(1), topPercentRange(1)], [], 8000, rng()).equity;
    expect(three).toBeLessThan(one - 0.1);
  });
});

describe('hand and board features', () => {
  it('classifies pairs correctly', () => {
    expect(analyzeHand(hand('Ah Qd'), parseCards('Ad 7c 2s')).topPair).toBe(true);
    expect(analyzeHand(hand('Ah Qd'), parseCards('Ad 7c 2s')).goodKicker).toBe(true);
    expect(analyzeHand(hand('Ah 4d'), parseCards('Ad 7c 2s')).goodKicker).toBe(false);
    expect(analyzeHand(hand('Kh Kd'), parseCards('Qd 7c 2s')).overPair).toBe(true);
    expect(analyzeHand(hand('7h 8d'), parseCards('Qd 7c 2s')).middlePair).toBe(true);
    expect(analyzeHand(hand('2h 8d'), parseCards('Qd 7c 2s')).bottomPair).toBe(true);
  });

  it('detects draws that use a hole card', () => {
    const fd = analyzeHand(hand('Ah 5h'), parseCards('Kh 7h 2c'));
    expect(fd.flushDraw).toBe(true);
    expect(fd.nutFlushDraw).toBe(true);
    expect(analyzeHand(hand('Kd 5h'), parseCards('Ah 7h 2h')).flushDraw).toBe(true);
    expect(analyzeHand(hand('9d 8c'), parseCards('Ts Js 2h')).openEnded).toBe(true);
    expect(analyzeHand(hand('9d 7c'), parseCards('Ts Js 2h')).gutshot).toBe(true);
    expect(analyzeHand(hand('Ad Kc'), parseCards('2s 7h 9d')).outs).toBe(6);
  });

  it('describes board texture', () => {
    expect(analyzeBoard(parseCards('Ks 7d 2c')).wetness).toBeLessThan(0.3);
    expect(analyzeBoard(parseCards('Ts 9s 8s')).wetness).toBeGreaterThan(0.6);
    expect(analyzeBoard(parseCards('Ks Kd 2c')).paired).toBe(true);
    expect(analyzeBoard(parseCards('Ks 7s 2s')).monotone).toBe(true);
  });
});

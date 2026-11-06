import { describe, expect, it } from 'vitest';
import type { LegalActions } from '../src/engine/hand';
import { resolvePreAction } from '../src/session/preActions';

function legal(overrides: Partial<LegalActions> = {}): LegalActions {
  return {
    seat: 0,
    canFold: true,
    canCheck: false,
    canCall: true,
    callAmount: 50,
    callIsAllIn: false,
    canBet: false,
    canRaise: true,
    minTo: 200,
    maxTo: 1000,
    shortAllInOnly: false,
    canAllIn: true,
    pot: 300,
    currentBet: 100,
    streetBet: 50,
    stack: 950,
    bigBlind: 100,
    lastRaiseSize: 100,
    ...overrides,
  };
}
const free = (o: Partial<LegalActions> = {}) => legal({ canCheck: true, canCall: false, callAmount: 0, currentBet: 0, streetBet: 0, canBet: true, canRaise: false, minTo: 100, ...o });

describe('resolvePreAction', () => {
  const hand = 7;
  const pre = (kind: Parameters<typeof resolvePreAction>[0]['kind'], multiple?: number) => ({ kind, multiple, handNumber: hand });

  it('Check/Fold checks when free and folds when facing a bet', () => {
    expect(resolvePreAction(pre('check_fold'), free(), hand)).toMatchObject({ kind: 'execute', action: { type: 'check' } });
    expect(resolvePreAction(pre('check_fold'), legal(), hand)).toMatchObject({ kind: 'execute', action: { type: 'fold' } });
  });

  it('Check never turns into a call: it cancels instead', () => {
    expect(resolvePreAction(pre('check'), free(), hand)).toMatchObject({ kind: 'execute', action: { type: 'check' } });
    const r = resolvePreAction(pre('check'), legal(), hand);
    expect(r.kind).toBe('cancel');
  });

  it('Fold to Any Bet folds to any positive bet and waits when nothing is bet', () => {
    expect(resolvePreAction(pre('fold_any'), legal({ callAmount: 1 }), hand)).toMatchObject({ kind: 'execute', action: { type: 'fold' } });
    expect(resolvePreAction(pre('fold_any'), free(), hand).kind).toBe('wait');
  });

  it('Call Any Bet calls through the engine, which caps at the remaining stack', () => {
    expect(resolvePreAction(pre('call_any'), legal({ callAmount: 950, callIsAllIn: true }), hand)).toMatchObject({ kind: 'execute', action: { type: 'call' } });
    expect(resolvePreAction(pre('call_any'), free(), hand)).toMatchObject({ kind: 'execute', action: { type: 'check' } });
  });

  it('Preset raises respect the legal minimum and maximum', () => {
    expect(resolvePreAction(pre('raise_x', 3), legal(), hand)).toMatchObject({ kind: 'execute', action: { type: 'raise', to: 300 } });
    expect(resolvePreAction(pre('raise_x', 2), legal({ minTo: 400 }), hand)).toMatchObject({ kind: 'execute', action: { type: 'raise', to: 400 } });
    expect(resolvePreAction(pre('raise_x', 50), legal(), hand)).toMatchObject({ kind: 'execute', action: { type: 'raise', to: 1000 } });
    expect(resolvePreAction(pre('raise_x', 3), free(), hand)).toMatchObject({ kind: 'execute', action: { type: 'bet', to: 300 } });
  });

  it('Preset raises cancel when raising is illegal, such as after a short all-in', () => {
    expect(resolvePreAction(pre('raise_x', 3), legal({ canRaise: false }), hand).kind).toBe('cancel');
  });

  it('Refuses a stale pre-action from a previous hand', () => {
    for (const kind of ['check_fold', 'fold_any', 'check', 'call_any', 'raise_x'] as const) {
      expect(resolvePreAction({ kind, handNumber: 6 }, legal(), hand).kind).toBe('cancel');
    }
  });
});

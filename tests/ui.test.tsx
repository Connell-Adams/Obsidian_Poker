// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCards } from '../src/engine/cards';
import { Deck } from '../src/engine/deck';
import { Hand, type LegalActions } from '../src/engine/hand';
import { SeededRng } from '../src/engine/rng';
import { buildHandRecord } from '../src/history/record';
import { buildReplayFrames, filterHands } from '../src/history/replay';
import { FakeClock } from '../src/session/clock';
import { DEFAULT_TIMING, TableController } from '../src/session/tableController';
import type { TableView } from '../src/session/tableView';
import { emptyCounters } from '../src/stats/counters';
import { PlayingCard } from '../src/ui/components/Art';
import { DivergingBars, LineChart } from '../src/ui/components/Charts';
import { ActionPanel, PreActionPanel } from '../src/ui/components/Controls';
import { HudBadge } from '../src/ui/components/Hud';
import { TableSurface } from '../src/ui/components/TableSurface';

afterEach(() => cleanup());

const APPEARANCE = { theme: 'emerald', cardFace: 'four_color', cardBack: 'obsidian', chipStyle: 'casino', animation: 'off' } as const;

function makeController() {
  const clock = new FakeClock();
  const rng = new SeededRng('ui');
  const controller = new TableController(
    { id: 'T', name: 'Table 1', sessionId: 's', mode: 'cash', maxSeats: 2, smallBlind: 5, bigBlind: 10, ante: 0, timing: { ...DEFAULT_TIMING, animationScale: 0, botSpeedScale: 0.01 } },
    [
      { seat: 0, id: 'hero', name: 'Hero', isHuman: true, avatar: 0, stack: 1000 },
      { seat: 1, id: 'bot', name: 'Villain', isHuman: false, avatar: 1, stack: 1000 },
    ],
    clock,
    rng,
  );
  controller.start();
  clock.runUntil(() => controller.getView().phase === 'hero_turn', 50);
  return { clock, controller };
}

const legal = (over: Partial<LegalActions> = {}): LegalActions => ({
  seat: 0, canFold: true, canCheck: false, canCall: true, callAmount: 50, callIsAllIn: false, canBet: false, canRaise: true,
  minTo: 200, maxTo: 1000, shortAllInOnly: false, canAllIn: true, pot: 300, currentBet: 100, streetBet: 50, stack: 950, bigBlind: 100, lastRaiseSize: 100, ...over,
});

describe('playing cards', () => {
  it('names each card for assistive technology and draws no identity on the back', () => {
    const { container } = render(<PlayingCard card={parseCards('Ah')[0]} />);
    expect(screen.getByRole('img', { name: 'A of hearts' })).toBeTruthy();
    expect(container.querySelector('.card-rank')!.textContent).toBe('A');
    const back = render(<PlayingCard card={null} />);
    expect(back.container.querySelector('.card-rank')).toBeNull();
    expect(screen.getByRole('img', { name: 'Face-down card' })).toBeTruthy();
  });
});

describe('action panel', () => {
  const setup = (over?: Partial<LegalActions>, props?: { isFocused?: boolean; hotkeys?: boolean }) => {
    const { controller } = makeController();
    const act = vi.spyOn(controller, 'heroAct').mockReturnValue(true);
    const bank = vi.spyOn(controller, 'useTimeBank').mockReturnValue(true);
    const view = controller.getView();
    const utils = render(<ActionPanel controller={controller} view={view} legal={legal(over)} presets={[0.5, 1]} isFocused={props?.isFocused ?? true} hotkeys={props?.hotkeys ?? true} />);
    return { act, bank, view, ...utils };
  };

  it('shows the exact amount a raise commits', () => {
    setup();
    const raise = screen.getByRole('button', { name: /raise 200/i });
    expect(raise.textContent).toContain('commits 150');
  });

  it('sends legal actions from each button', () => {
    const { act } = setup();
    fireEvent.click(screen.getByRole('button', { name: /fold/i }));
    expect(act).toHaveBeenLastCalledWith({ type: 'fold' });
    fireEvent.click(screen.getByRole('button', { name: /^call/i }));
    expect(act).toHaveBeenLastCalledWith({ type: 'call' });
    fireEvent.click(screen.getByRole('button', { name: /raise 200/i }));
    expect(act).toHaveBeenLastCalledWith({ type: 'raise', to: 200 });
    fireEvent.click(screen.getByRole('button', { name: /^all-in/i }));
    expect(act).toHaveBeenLastCalledWith({ type: 'allin' });
  });

  it('clamps custom amounts to the legal range', () => {
    const { act } = setup();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '99999' } });
    fireEvent.click(screen.getByRole('button', { name: /raise all-in/i }));
    expect(act).toHaveBeenLastCalledWith({ type: 'raise', to: 1000 });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /raise 200/i }));
    expect(act).toHaveBeenLastCalledWith({ type: 'raise', to: 200 });
  });

  it('sizes presets from the pot', () => {
    const { act } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Pot' }));
    // Pot-sized raise: 100 to match + (300 + 50) on top.
    fireEvent.click(screen.getByRole('button', { name: /raise 450/i }));
    expect(act).toHaveBeenLastCalledWith({ type: 'raise', to: 450 });
  });

  it('offers Check, hides Call and uses the word Bet when there is no bet', () => {
    setup({ canCheck: true, canCall: false, callAmount: 0, currentBet: 0, streetBet: 0, canBet: true, canRaise: false, minTo: 100 });
    expect(screen.getByRole('button', { name: /^check/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^call/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^bet 100/i })).toBeTruthy();
  });

  it('removes raising when the action was not reopened', () => {
    setup({ canRaise: false, canAllIn: false });
    expect(screen.queryByRole('button', { name: /raise/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^all-in/i })).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('uses keyboard shortcuts on the focused table only, after a short grace period', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const focused = setup();
      fireEvent.keyDown(window, { key: 'f' });
      expect(focused.act).not.toHaveBeenCalled(); // grace period straight after focus moved
      vi.setSystemTime(1_000_000 + 400);
      fireEvent.keyDown(window, { key: 'f' });
      expect(focused.act).toHaveBeenLastCalledWith({ type: 'fold' });
      fireEvent.keyDown(window, { key: 'a' });
      expect(focused.act).toHaveBeenCalledTimes(1); // plain A is not all-in
      fireEvent.keyDown(window, { key: 'A', shiftKey: true });
      expect(focused.act).toHaveBeenLastCalledWith({ type: 'allin' });
      fireEvent.keyDown(window, { key: 't' });
      expect(focused.bank).toHaveBeenCalled();
      cleanup();

      const other = setup(undefined, { isFocused: false });
      vi.setSystemTime(1_000_000 + 900);
      fireEvent.keyDown(window, { key: 'f' });
      expect(other.act).not.toHaveBeenCalled();
      cleanup();

      const off = setup(undefined, { hotkeys: false });
      vi.setSystemTime(1_000_000 + 1400);
      fireEvent.keyDown(window, { key: 'f' });
      expect(off.act).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores shortcuts typed into the amount box', () => {
    vi.useFakeTimers({ now: 2_000_000 });
    try {
      const { act } = setup();
      vi.setSystemTime(2_000_000 + 500);
      fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'f' });
      expect(act).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pre-action panel', () => {
  const inHand = (over: Partial<TableView> = {}) => {
    const { controller } = makeController();
    const spy = vi.spyOn(controller, 'setPreAction');
    const base = controller.getView();
    const view: TableView = { ...base, phase: 'bot_thinking', legal: null, ...over };
    return { controller, spy, view };
  };

  it('offers every required pre-action and toggles them', () => {
    const { controller, spy, view } = inHand();
    render(<PreActionPanel controller={controller} view={view} />);
    for (const label of ['Check/Fold', 'Fold to Any', 'Check', 'Call Any', 'Raise 3x']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Call Any' }));
    expect(spy).toHaveBeenLastCalledWith('call_any', undefined);
  });

  it('shows immediate feedback for the armed choice and clears it on a second click', () => {
    const { controller, spy, view } = inHand({ preAction: { kind: 'check', handNumber: 1 } });
    render(<PreActionPanel controller={controller} view={view} />);
    const check = screen.getByRole('button', { name: 'Check' });
    expect(check.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Call Any' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(check);
    expect(spy).toHaveBeenLastCalledWith(null);
  });

  it('changes the preset raise size', () => {
    const { controller, spy, view } = inHand();
    render(<PreActionPanel controller={controller} view={view} />);
    fireEvent.change(screen.getByRole('combobox', { name: /preset raise size/i }), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Raise 4x' }));
    expect(spy).toHaveBeenLastCalledWith('raise_x', 4);
  });

  it('hides pre-actions after folding', () => {
    const { controller, view } = inHand();
    const folded: TableView = { ...view, seats: view.seats.map((s) => (s && s.isHuman ? { ...s, folded: true } : s)) };
    render(<PreActionPanel controller={controller} view={folded} />);
    expect(screen.queryByRole('button', { name: 'Call Any' })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/folded/i);
  });
});

describe('table surface', () => {
  it('shows only the player own cards and renders the seats', () => {
    const { controller } = makeController();
    const view = controller.getView();
    const { container } = render(<TableSurface view={view} appearance={APPEARANCE} />);
    expect(screen.getByText('Hero')).toBeTruthy();
    expect(screen.getByText('Villain')).toBeTruthy();
    const faces = container.querySelectorAll('.seat-hero .card-rank');
    expect(faces).toHaveLength(2);
    const villainSeat = [...container.querySelectorAll('.seat')].find((s) => s.textContent?.includes('Villain'))!;
    expect(villainSeat.querySelectorAll('.card-rank')).toHaveLength(0);
    expect(villainSeat.querySelectorAll('.card-back')).toHaveLength(2);
  });

  it('never puts text, timers or chips inside the hero card elements', () => {
    const { controller } = makeController();
    const { container } = render(<TableSurface view={controller.getView()} appearance={APPEARANCE} />);
    const cards = container.querySelector('.hero-cards')!;
    expect(cards.querySelector('.clock-ring')).toBeNull();
    expect(cards.querySelector('.chip')).toBeNull();
    expect(cards.querySelector('.action-word')).toBeNull();
    expect(cards.querySelector('.hud')).toBeNull();
  });
});

describe('HUD badge', () => {
  it('admits when nothing has been observed', () => {
    render(<HudBadge counters={undefined} stats={['vpip']} density="standard" name="X" />);
    expect(screen.getByText('no reads')).toBeTruthy();
  });

  it('hides percentages until a minimum sample, and shows the sample size', () => {
    const c = emptyCounters();
    c.hands = 4;
    c.decisions = 4;
    c.vpip = 4;
    render(<HudBadge counters={c} stats={['vpip', 'hands']} density="standard" name="X" />);
    const line = screen.getByRole('button', { name: /X, 4 hands observed/ });
    expect(line.textContent).toContain('–');
    expect(line.textContent).not.toContain('100%');
  });

  it('shows figures with enough data and expands to full statistics', () => {
    const c = emptyCounters();
    c.hands = 100;
    c.decisions = 100;
    c.vpip = 25;
    c.pfr = 18;
    render(<HudBadge counters={c} stats={['vpip', 'pfr']} density="standard" name="Mira" />);
    const line = screen.getByRole('button', { name: /Mira, 100 hands observed/ });
    expect(line.textContent).toContain('25%');
    fireEvent.click(line);
    expect(screen.getByRole('dialog', { name: /Mira statistics/ })).toBeTruthy();
    expect(screen.getAllByText('n=100', { exact: false }).length).toBeGreaterThan(0);
  });
});

describe('charts', () => {
  it('says so instead of drawing a chart from nothing', () => {
    render(<LineChart values={[5]} label="Test" />);
    expect(screen.getByText(/Not enough data/)).toBeTruthy();
  });

  it('labels its data and shows a value on hover', () => {
    const { container } = render(<LineChart values={[0, 10, -5, 20]} label="Profit" />);
    expect(container.querySelector('title')!.textContent).toContain('4 points');
    expect(container.querySelector('.chart-line')).toBeTruthy();
  });

  it('prints value text next to diverging bars, so colour is never the only signal', () => {
    render(<DivergingBars rows={[{ label: 'BTN', value: 12.5, n: 40 }, { label: 'UTG', value: -8, n: 30 }, { label: 'SB', value: null, n: 0 }]} />);
    expect(screen.getByText('+12.5')).toBeTruthy();
    expect(screen.getByText('-8.0')).toBeTruthy();
    expect(screen.getByText('–')).toBeTruthy();
  });
});

describe('replay', () => {
  function record() {
    const hand = new Hand({
      handNumber: 7,
      players: [
        { seat: 0, id: 'hero', name: 'Hero', stack: 1000 },
        { seat: 1, id: 'bot', name: 'Bot', stack: 1000 },
      ],
      buttonSeat: 1,
      smallBlind: 5,
      bigBlind: 10,
      deck: Deck.stacked(parseCards('Ah 2c Ad 2d 3s 9h Tc 4d 3d Js 5c Qs'), new SeededRng(1)),
    });
    hand.act(1, { type: 'call' });
    hand.act(0, { type: 'check' });
    hand.act(0, { type: 'bet', to: 20 });
    hand.act(1, { type: 'call' });
    hand.act(0, { type: 'check' });
    hand.act(1, { type: 'check' });
    hand.act(0, { type: 'check' });
    hand.act(1, { type: 'check' });
    return buildHandRecord(hand, { id: 'r', sessionId: 's', tableId: 't', tableName: 'Table', mode: 'cash', maxSeats: 2, heroId: 'hero', now: 5 });
  }

  it('steps through actions with captions, and pot and stacks tracked at each frame', () => {
    const frames = buildReplayFrames(record());
    expect(frames[0].kind).toBe('start');
    const captions = frames.map((f) => f.caption);
    expect(captions.some((c) => c.includes('You bet 20'))).toBe(true);
    expect(captions.some((c) => c.includes('Bot calls 20'))).toBe(true);
    expect(captions.some((c) => c === 'Flop')).toBe(true);
    expect(captions.some((c) => /\bwins?\b/.test(c))).toBe(true);
    const betFrame = frames.find((f) => f.caption.includes('You bet 20'))!;
    expect(betFrame.view.potTotal).toBe(40);
    const last = frames[frames.length - 1].view;
    expect(last.seats[0]!.stack + last.seats[1]!.stack).toBe(2000);
  });

  it('hides the opponent mucked cards in every frame', () => {
    const r = record();
    const frames = buildReplayFrames(r);
    const villainCards = r.players[1].hole;
    for (const f of frames) {
      const shown = f.view.seats[1]!.cards;
      for (const c of villainCards) expect(shown).not.toContain(c);
    }
    // Hero's own cards are visible from the first frame.
    expect(frames[0].view.seats[0]!.cards).toEqual(parseCards('Ah Ad'));
  });

  it('renders any frame through the shared table component', () => {
    const frames = buildReplayFrames(record());
    const { container } = render(<TableSurface view={frames[frames.length - 1].view} appearance={APPEARANCE} still />);
    expect(container.querySelectorAll('.board-card')).toHaveLength(5);
  });

  it('filters hands', () => {
    const a = { ...record(), id: 'a', heroNet: 500, totalPot: 1000, ts: 1 };
    const b = { ...record(), id: 'b', heroNet: -800, totalPot: 1600, ts: 2 };
    const c = { ...record(), id: 'c', heroNet: 10, totalPot: 40, wentToShowdown: false, ts: 3 };
    const all = [a, b, c];
    expect(filterHands(all, { filter: 'won' }).map((h) => h.id).sort()).toEqual(['a', 'c']);
    expect(filterHands(all, { filter: 'lost' }).map((h) => h.id)).toEqual(['b']);
    expect(filterHands(all, { filter: 'biggest_pots' })[0].id).toBe('b');
    expect(filterHands(all, { filter: 'biggest_losses' })[0].id).toBe('b');
    expect(filterHands(all, { filter: 'showdowns' }).map((h) => h.id)).not.toContain('c');
    expect(filterHands(all, { filter: 'all', opponent: 'Nobody' })).toEqual([]);
    expect(filterHands(all, { filter: 'all', opponent: 'Bot' })).toHaveLength(3);
    expect(filterHands(all, { filter: 'all', position: 'BB' })).toHaveLength(3);
    expect(filterHands(all, { filter: 'all', position: 'BTN' })).toEqual([]);
    expect(filterHands(all, { filter: 'all' })[0].id).toBe('c');
  });
});

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNow } from '../../app/context';
import type { LegalActions, PlayerAction } from '../../engine/hand';
import { aggressiveAction, chipsToCommit, clampTo, potFractionTo } from '../../engine/sizing';
import type { PreActionKind } from '../../session/preActions';
import type { TableController } from '../../session/tableController';
import type { TableView } from '../../session/tableView';
import { cx, fmt, fmtShort } from '../format';

const PRESET_LABEL = (p: number): string => {
  if (p === 0.5) return '½';
  if (p === 0.33) return '⅓';
  if (p === 0.66) return '⅔';
  if (p === 0.75) return '¾';
  if (p === 1) return 'Pot';
  return `${Math.round(p * 100)}%`;
};

export interface ActionPanelProps {
  controller: ActionTarget;
  view: TableView;
  legal: LegalActions;
  presets: readonly number[];
  /** Hotkeys act only on the focused table, and never in the first moments after focus moves. */
  isFocused: boolean;
  hotkeys: boolean;
}

const FOCUS_GRACE_MS = 350;

/** Where the buttons send moves: an offline table, or the online game server. */
export interface ActionTarget {
  heroAct(action: PlayerAction): boolean;
  useTimeBank(seconds?: number): boolean;
}

/** Betting controls. They only ever talk to this table's controller, so a click cannot land elsewhere. */
export function ActionPanel({ controller, view, legal, presets, isFocused, hotkeys }: ActionPanelProps) {
  const canAggress = legal.canBet || legal.canRaise;
  const [to, setTo] = useState(() => legal.minTo);
  const [text, setText] = useState<string | null>(null);

  // A new decision on this table resets the sizing to a safe default.
  const decisionKey = `${view.handNumber}-${view.street}-${legal.currentBet}-${legal.streetBet}-${legal.stack}`;
  useEffect(() => {
    setTo(legal.minTo);
    setText(null);
  }, [decisionKey, legal.minTo]);

  const legalTo = canAggress ? clampTo(legal, to) : 0;
  const commit = canAggress ? chipsToCommit(legal, legalTo) : 0;
  const isAllInSize = canAggress && legalTo === legal.maxTo;
  const verb = legal.canBet ? 'Bet' : 'Raise';

  const act = useCallback((action: PlayerAction) => controller.heroAct(action), [controller]);
  const onFold = () => act({ type: 'fold' });
  const onCheckCall = () => act(legal.canCheck ? { type: 'check' } : { type: 'call' });
  const onAggress = () => {
    const action = aggressiveAction(legal, legalTo);
    if (action) act(action);
  };
  const onAllIn = () => act({ type: 'allin' });

  const focusedAt = useRef(0);
  useEffect(() => {
    if (isFocused) focusedAt.current = Date.now();
  }, [isFocused]);

  const latest = useRef({ onFold, onCheckCall, onAggress, onAllIn, canAggress, legal, controller });
  latest.current = { onFold, onCheckCall, onAggress, onAllIn, canAggress, legal, controller };

  useEffect(() => {
    if (!isFocused || !hotkeys) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      if (Date.now() - focusedAt.current < FOCUS_GRACE_MS) return;
      const a = latest.current;
      switch (event.key.toLowerCase()) {
        case 'f':
          a.onFold();
          break;
        case 'c':
          a.onCheckCall();
          break;
        case 'r':
          if (a.canAggress) a.onAggress();
          break;
        case 'a':
          if (event.shiftKey && a.legal.canAllIn) a.onAllIn();
          break;
        case 't':
          a.controller.useTimeBank();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFocused, hotkeys]);

  const presetSizes = useMemo(() => {
    if (!canAggress) return [];
    return presets.map((p) => ({ p, to: potFractionTo(legal, p) ?? legal.minTo }));
  }, [canAggress, presets, legal]);

  const now = useNow(view.deadline !== null, 200);
  const secondsLeft = view.deadline !== null ? Math.max(0, Math.ceil((view.deadline - now) / 1000)) : 0;
  const urgent = secondsLeft <= 5;

  return (
    <div className="action-panel" role="group" aria-label={`Your action at ${view.tableName}`}>
      {canAggress && !legal.shortAllInOnly && (
        <div className="sizing-row">
          <button type="button" className="preset" onClick={() => setTo(legal.minTo)} data-active={legalTo === legal.minTo}>Min</button>
          {presetSizes.map(({ p, to: size }) => (
            <button type="button" key={p} className="preset" onClick={() => { setTo(size); setText(null); }} data-active={legalTo === size}>
              {PRESET_LABEL(p)}
            </button>
          ))}
          <input
            className="size-slider"
            type="range"
            min={legal.minTo}
            max={legal.maxTo}
            step={1}
            value={legalTo}
            aria-label={`${verb} size`}
            onChange={(e) => { setTo(Number(e.target.value)); setText(null); }}
          />
          <input
            className="size-input"
            type="number"
            inputMode="numeric"
            min={legal.minTo}
            max={legal.maxTo}
            aria-label={`${verb} to amount`}
            value={text ?? String(legalTo)}
            onChange={(e) => {
              setText(e.target.value);
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) setTo(n);
            }}
            onBlur={() => setText(null)}
          />
        </div>
      )}
      <div className="button-row">
        <button type="button" className="act act-fold" onClick={onFold}>
          <span className="act-word">Fold</span>
          <kbd>F</kbd>
        </button>
        <button type="button" className="act act-primary" onClick={onCheckCall}>
          <span className="act-word">{legal.canCheck ? 'Check' : legal.callIsAllIn ? 'Call all-in' : 'Call'}</span>
          {legal.canCall && <span className="act-amount">{fmt(legal.callAmount)}</span>}
          <kbd>C</kbd>
        </button>
        {canAggress && (
          <button type="button" className="act act-raise" onClick={onAggress}>
            <span className="act-word">{isAllInSize ? (legal.shortAllInOnly ? 'All-in' : `${verb} all-in`) : `${verb} ${fmt(legalTo)}`}</span>
            <span className="act-amount act-commit">commits {fmt(commit)}</span>
            <kbd>R</kbd>
          </button>
        )}
        {legal.canAllIn && !legal.callIsAllIn && !legal.shortAllInOnly && (
          <button type="button" className="act act-allin" onClick={onAllIn}>
            <span className="act-word">All-in</span>
            <span className="act-amount">{fmtShort(legal.stack)}</span>
          </button>
        )}
        <div className={cx('clock-block', urgent && 'urgent')} aria-live="off">
          <span className="clock-seconds" aria-label={`${secondsLeft} seconds left`}>{secondsLeft}</span>
          {view.timeBank > 0 && <button
            type="button"
            className="timebank"
            disabled={view.timeBank <= 0}
            onClick={() => controller.useTimeBank()}
            title="Use time bank: adds up to 15 seconds"
          >
            +15s <small>{Math.floor(view.timeBank)}s</small>
          </button>}
        </div>
      </div>
      {view.preActionNote && <div className="panel-note" role="status">{view.preActionNote}</div>}
    </div>
  );
}

const RAISE_MULTIPLES = [2, 2.5, 3, 4];

export function PreActionPanel({ controller, view }: { controller: TableController; view: TableView }) {
  const armed = view.preAction;
  const [multiple, setMultiple] = useState(3);
  const [customOpen, setCustomOpen] = useState(false);
  const hero = view.heroSeat !== null ? view.seats[view.heroSeat] : null;
  const available = view.isHeroInHand && hero && !hero.folded && !hero.allIn && view.phase !== 'hand_over';

  const toggle = (kind: PreActionKind, mult?: number) => {
    if (armed?.kind === kind && (kind !== 'raise_x' || armed.multiple === mult)) controller.setPreAction(null);
    else controller.setPreAction(kind, mult);
  };

  if (!available) {
    let message = 'Waiting for the next hand';
    if (hero?.folded) message = 'You folded. Next hand soon.';
    else if (hero?.allIn) message = 'You are all-in. Good luck!';
    else if (view.phase === 'hand_over') message = view.lastHandSummary ?? 'Hand complete';
    return (
      <div className="pre-panel pre-idle" role="status">
        <span>{message}</span>
      </div>
    );
  }

  const options: Array<{ kind: PreActionKind; label: string }> = [
    { kind: 'check_fold', label: 'Check/Fold' },
    { kind: 'fold_any', label: 'Fold to Any' },
    { kind: 'check', label: 'Check' },
    { kind: 'call_any', label: 'Call Any' },
  ];

  return (
    <div className="pre-panel" role="group" aria-label={`Pre-select an action at ${view.tableName}`}>
      {options.map(({ kind, label }) => (
        <button key={kind} type="button" className="pre" aria-pressed={armed?.kind === kind} onClick={() => toggle(kind)}>
          <span className="pre-box" aria-hidden="true" />
          {label}
        </button>
      ))}
      <div className="pre-raise-group">
        <button type="button" className="pre pre-raise" aria-pressed={armed?.kind === 'raise_x'} onClick={() => toggle('raise_x', multiple)}>
          <span className="pre-box" aria-hidden="true" />
          Raise {multiple}x
        </button>
        {customOpen ? (
          <input
            className="pre-select"
            type="number"
            min={1.5}
            max={50}
            step={0.5}
            autoFocus
            aria-label="Custom raise multiple"
            value={multiple}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (!Number.isFinite(value) || value < 1.5 || value > 50) return;
              setMultiple(value);
              if (armed?.kind === 'raise_x') controller.setPreAction('raise_x', value);
            }}
            onBlur={() => setCustomOpen(false)}
          />
        ) : (
          <select
            className="pre-select"
            aria-label="Preset raise size"
            value={RAISE_MULTIPLES.includes(multiple) ? multiple : 'custom-value'}
            onChange={(e) => {
              if (e.target.value === 'custom') {
                setCustomOpen(true);
                return;
              }
              const value = Number(e.target.value);
              setMultiple(value);
              if (armed?.kind === 'raise_x') controller.setPreAction('raise_x', value);
            }}
          >
            {RAISE_MULTIPLES.map((m) => (
              <option key={m} value={m}>{m}x</option>
            ))}
            {!RAISE_MULTIPLES.includes(multiple) && <option value="custom-value">{multiple}x</option>}
            <option value="custom">Custom…</option>
          </select>
        )}
      </div>
      {view.preActionNote && <div className="panel-note" role="status">{view.preActionNote}</div>}
    </div>
  );
}

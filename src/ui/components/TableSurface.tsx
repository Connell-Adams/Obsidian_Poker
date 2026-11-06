import { type CSSProperties, memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type Card } from '../../engine/cards';
import { evaluateHand } from '../../engine/evaluator';
import type { AnimationSpeed, CardBack, CardFace, ChipStyle, TableTheme } from '../../persistence/settings';
import type { SeatView, TableView } from '../../session/tableView';
import { cx, fmtShort } from '../format';
import { Avatar, ChipStack, PlayingCard } from './Art';

export interface SurfaceAppearance {
  theme: TableTheme;
  cardFace: CardFace;
  cardBack: CardBack;
  chipStyle: ChipStyle;
  animation: AnimationSpeed;
}

/** Where a seat sits on the oval, as a percentage, with the viewer always at the bottom. */
export function seatPoint(displayIndex: number, maxSeats: number): { x: number; y: number } {
  if (displayIndex === 0) return { x: 50, y: 88 };
  const angle = (displayIndex / maxSeats) * Math.PI * 2;
  // Clockwise on screen: the seat acting after the viewer sits to their left.
  return { x: 50 - 41.5 * Math.sin(angle), y: 45 + 37 * Math.cos(angle) };
}

/** Where chips fly to and from for the viewer: their nameplate, never their cards. */
const HERO_PLATE_POINT = { x: 40, y: 88 };
const HERO_BET_POINT = { x: 40, y: 72 };
const betPoint = (p: { x: number; y: number }, isHero: boolean) => (isHero ? HERO_BET_POINT : { x: 50 + (p.x - 50) * 0.66, y: 45 + (p.y - 45) * 0.56 });
const POT_POINT = { x: 50, y: 28 };
const DECK_POINT = { x: 37, y: 27 };
const MUCK_POINT = { x: 63, y: 27 };

const ACTION_WORDS: Record<string, string> = { fold: 'FOLD', check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', post: '', win: 'WINS' };

function displayIndexOf(seat: number, view: TableView): number {
  const anchor = view.heroSeat ?? 0;
  return (seat - anchor + view.maxSeats) % view.maxSeats;
}

interface SeatProps {
  seat: SeatView;
  point: { x: number; y: number };
  isHero: boolean;
  isActor: boolean;
  isButton: boolean;
  isSB: boolean;
  isBB: boolean;
  deadline: number | null;
  clockTotal: number;
  appearance: SurfaceAppearance;
  hud?: ReactNode;
  madeHand: string | null;
  chipStyle: ChipStyle;
}

/** The countdown is one CSS animation, so ticking never re-renders React. */
const ClockRing = memo(function ClockRing({ deadline, total }: { deadline: number; total: number }) {
  const elapsed = Math.max(0, total - (deadline - Date.now()));
  return (
    <svg className="clock-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="clock-track" cx="50" cy="50" r="47" />
      <circle
        className="clock-arc"
        cx="50"
        cy="50"
        r="47"
        pathLength={100}
        style={{ animationDuration: `${total}ms`, animationDelay: `-${elapsed}ms` }}
      />
    </svg>
  );
});

const Seat = memo(function Seat({ seat, point, isHero, isActor, isButton, isSB, isBB, deadline, clockTotal, appearance, hud, madeHand, chipStyle }: SeatProps) {
  const { cardFace, cardBack } = appearance;
  const action = seat.lastAction;
  const words = action ? ACTION_WORDS[action.kind] : '';
  let actionText = '';
  if (action && words) {
    const showAmount = action.kind === 'call' || action.kind === 'bet' || action.kind === 'raise' || action.kind === 'win';
    actionText = `${words}${showAmount && action.amount ? ` ${fmtShort(action.amount)}` : ''}`;
    if (action.allIn && action.kind !== 'fold') actionText = 'ALL-IN';
  }
  const style = { '--sx': point.x, '--sy': point.y } as CSSProperties;

  const cards = seat.inHand && seat.dealt > 0 && (!seat.mucked || isHero) && (
    <div className={cx('seat-cards', isHero && 'hero-cards', seat.showing && !isHero && 'seat-cards-shown')}>
      {[0, 1].map((i) => {
        if (seat.dealt <= i) return null;
        return (
          <PlayingCard
            key={i}
            card={seat.cards[i]}
            face={cardFace}
            back={cardBack}
            className={cx('hole-card', `hole-${i}`, seat.showing && !isHero && 'revealed')}
          />
        );
      })}
    </div>
  );

  return (
    <div
      className={cx('seat', isHero && 'seat-hero', (seat.folded || (isHero && seat.mucked)) && 'is-folded', isActor && 'is-actor', seat.won > 0 && 'is-winner', seat.allIn && 'is-allin')}
      style={style}
    >
      {!isHero && cards}
      {/* The viewer's bet is laid out beside their cards, so it can never cover them. */}
      {isHero && seat.bet > 0 && (
        <div className="hero-bet">
          <ChipStack amount={seat.bet} chipStyle={chipStyle} />
        </div>
      )}
      <div className="seat-plate">
        {isButton && <span className="dealer-disc" aria-label="Dealer button">D</span>}
        {!isButton && isSB && <span className="blind-tag">SB</span>}
        {isBB && <span className="blind-tag">BB</span>}
        <div className="seat-avatar">
          <Avatar index={seat.avatar} name={seat.name} />
          {isActor && deadline !== null && <ClockRing key={deadline} deadline={deadline} total={clockTotal} />}
        </div>
        <div className="seat-info">
          <div className="seat-name">
            {seat.position && <span className="seat-position">{seat.position}</span>}
            <span className="seat-name-text" title={seat.name}>{seat.name}</span>
          </div>
          <div className="seat-stack" data-testid={isHero ? 'hero-stack' : undefined}>{seat.stack === 0 && seat.allIn ? 'ALL-IN' : fmtShort(seat.stack)}</div>
        </div>
      </div>
      {isHero && cards}
      <div className="seat-status" aria-live={isHero ? 'polite' : undefined}>
        {actionText && <span key={action?.key} className={cx('action-word', action && `word-${action.kind}`, action?.allIn && 'word-allin')}>{actionText}</span>}
        {seat.handDescription ? <span className="hand-words">{seat.handDescription}</span> : isHero && madeHand ? <span className="hand-words">{madeHand}</span> : null}
      </div>
      {hud}
    </div>
  );
});

interface Flight {
  key: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  amount: number;
}

/** Chips sliding to the middle and back out to winners, driven only by engine-derived keys. */
function useChipFlights(view: TableView): Flight[] {
  const [flights, setFlights] = useState<Flight[]>([]);
  const prevBets = useRef<Array<{ seat: number; bet: number }>>([]);
  const prevCollect = useRef(view.collectKey);
  const prevAward = useRef(view.awardKey);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const next: Flight[] = [];
    if (view.collectKey !== prevCollect.current) {
      prevCollect.current = view.collectKey;
      for (const { seat, bet } of prevBets.current) {
        if (bet <= 0) continue;
        const display = displayIndexOf(seat, view);
        next.push({ key: `c${view.collectKey}-${seat}`, from: betPoint(seatPoint(display, view.maxSeats), display === 0), to: POT_POINT, amount: bet });
      }
    }
    if (view.awardKey !== prevAward.current) {
      prevAward.current = view.awardKey;
      const last = view.winners[view.winners.length - 1];
      if (last) {
        const display = displayIndexOf(last.seat, view);
        next.push({ key: `a${view.awardKey}`, from: POT_POINT, to: display === 0 ? HERO_PLATE_POINT : seatPoint(display, view.maxSeats), amount: last.amount });
      }
    }
    prevBets.current = view.seats.flatMap((s) => (s && s.bet > 0 ? [{ seat: s.seat, bet: s.bet }] : []));
    if (next.length === 0) return;
    setFlights((f) => [...f, ...next]);
    const id = setTimeout(() => {
      timers.current.delete(id);
      setFlights((f) => f.filter((x) => !next.includes(x)));
    }, 650);
    timers.current.add(id);
  }, [view]);

  // Only unmounting cancels removal: a re-render must not leave flights behind.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const id of pending) clearTimeout(id);
      pending.clear();
    };
  }, []);
  return flights;
}

export interface TableSurfaceProps {
  view: TableView;
  appearance: SurfaceAppearance;
  hudFor?: (seat: SeatView) => ReactNode;
  /** Replay frames skip entry animations so that stepping stays crisp. */
  still?: boolean;
}

/**
 * The drawn table. A pure function of `TableView`: it holds no game state, cannot
 * affect the engine, and draws the same thing for live play and replays.
 */
export const TableSurface = memo(function TableSurface({ view, appearance, hudFor, still }: TableSurfaceProps) {
  const { theme, cardFace, cardBack, chipStyle, animation } = appearance;
  const flights = useChipFlights(view);
  const hero = view.heroSeat !== null ? view.seats[view.heroSeat] : null;

  const winnerCards = useMemo(() => {
    const winner = view.seats.find((s) => s && s.won > 0 && s.bestFive);
    return new Set<Card>(winner?.bestFive ?? []);
  }, [view.seats]);

  const madeHand = useMemo(() => {
    if (!hero || hero.folded || view.board.length < 3 || hero.cards[0] === null || hero.cards[1] === null) return null;
    return evaluateHand([hero.cards[0], hero.cards[1], ...view.board]).description;
  }, [hero, view.board]);

  return (
    <div className={cx('surface', `theme-${theme}`, `anim-${animation}`, still && 'is-still')}>
      <div className="rail">
        <div className="felt">
          <div className="felt-mark" aria-hidden="true" />
        </div>
      </div>

      <div className="deck-pile" style={{ left: `${DECK_POINT.x}%`, top: `${DECK_POINT.y}%` }} title="Dealer deck">
        <PlayingCard card={null} back={cardBack} className="pile-card pile-1" />
        <PlayingCard card={null} back={cardBack} className="pile-card pile-2" />
        <PlayingCard key={view.burnCount} card={null} back={cardBack} className={cx('pile-card', 'pile-3', view.burnCount > 0 && 'burn-pulse')} />
      </div>
      {view.muckCount > 0 && (
        <div className="muck-pile" style={{ left: `${MUCK_POINT.x}%`, top: `${MUCK_POINT.y}%` }} title="Muck">
          {Array.from({ length: Math.min(view.muckCount, 4) }, (_, i) => (
            <PlayingCard key={i} card={null} back={cardBack} className="pile-card muck-card" style={{ '--r': `${(i - 1.5) * 16}deg` } as CSSProperties} />
          ))}
        </div>
      )}

      <div className="pot" style={{ left: `${POT_POINT.x}%`, top: `${POT_POINT.y}%` }}>
        {view.potTotal > 0 && (
          <>
            <ChipStack amount={view.pot || view.potTotal} chipStyle={chipStyle} showLabel={false} />
            <span className="pot-label">Pot <b>{fmtShort(view.potTotal)}</b></span>
          </>
        )}
      </div>

      <div className="board" aria-label="Community cards">
        {[0, 1, 2, 3, 4].map((i) => {
          const card = view.board[i];
          return card === undefined ? (
            <div key={`slot-${i}`} className="board-slot" />
          ) : (
            <PlayingCard key={`card-${card}`} card={card} face={cardFace} back={cardBack} className={cx('board-card', i < 3 && `flop-${i}`, winnerCards.has(card) && 'is-best', winnerCards.size > 0 && !winnerCards.has(card) && 'is-dim')} />
          );
        })}
      </div>

      {view.seats.map((s) => {
        if (!s || s.bet <= 0 || s.seat === view.heroSeat) return null;
        const display = displayIndexOf(s.seat, view);
        const p = betPoint(seatPoint(display, view.maxSeats), display === 0);
        const from = seatPoint(display, view.maxSeats);
        return (
          <div
            key={s.seat}
            className="bet"
            style={{ left: `${p.x}%`, top: `${p.y}%`, '--fx': (from.x - p.x).toFixed(1), '--fy': (from.y - p.y).toFixed(1) } as CSSProperties}
          >
            <ChipStack amount={s.bet} chipStyle={chipStyle} />
          </div>
        );
      })}

      {flights.map((f) => (
        <div
          key={f.key}
          className="chip-flight"
          style={{ left: `${f.from.x}%`, top: `${f.from.y}%`, '--dx': (f.to.x - f.from.x).toFixed(1), '--dy': (f.to.y - f.from.y).toFixed(1) } as CSSProperties}
        >
          <ChipStack amount={f.amount} chipStyle={chipStyle} showLabel={false} />
        </div>
      ))}

      {view.seats.map((s) => {
        if (!s) return null;
        const display = displayIndexOf(s.seat, view);
        const isHero = s.seat === view.heroSeat;
        return (
          <Seat
            key={s.seat}
            seat={s}
            point={seatPoint(display, view.maxSeats)}
            isHero={isHero}
            isActor={view.actorSeat === s.seat}
            isButton={view.buttonSeat === s.seat}
            isSB={view.sbSeat === s.seat}
            isBB={view.bbSeat === s.seat}
            deadline={view.actorSeat === s.seat ? view.deadline : null}
            clockTotal={view.clockTotal}
            appearance={appearance}
            hud={!isHero && hudFor ? hudFor(s) : undefined}
            madeHand={isHero ? madeHand : null}
            chipStyle={chipStyle}
          />
        );
      })}

      {view.banner && <div className="table-banner">{view.banner}</div>}
    </div>
  );
});

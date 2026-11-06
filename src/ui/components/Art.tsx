import { memo, type CSSProperties } from 'react';
import { type Card, RANK_CHARS, rankOf, suitOf } from '../../engine/cards';
import type { CardBack, CardFace, ChipStyle } from '../../persistence/settings';
import { cx, fmtShort } from '../format';

const SUIT_PATHS = [
  // clubs
  'M12 2.5a4.6 4.6 0 0 0-3.8 7.2A4.6 4.6 0 1 0 10.9 18c-.2 1.3-1 2.4-2.4 3.5h7c-1.400-1.100-2.200-2.200-2.400-3.500a4.600 4.600 0 1 0 2.700-8.300A4.600 4.600 0 0 0 12 2.500z',
  // diamonds
  'M12 1.800 20.200 12 12 22.200 3.800 12z',
  // hearts
  'M12 21.500s-8-5.200-10.200-9.900C.2 8.100 2.100 3.800 6.100 3.800c2.500 0 4.200 1.400 5.900 3.800 1.700-2.400 3.400-3.800 5.900-3.800 4 0 5.900 4.300 4.300 7.800C20 16.300 12 21.500 12 21.500z',
  // spades
  'M12 2s-9 6.700-9 12.200c0 3 2.300 5.100 5 5.100 1.400 0 2.500-.5 3.300-1.500-.2 1.700-1 3-2.600 4.200h6.600c-1.600-1.200-2.400-2.500-2.600-4.200.8 1 1.900 1.500 3.300 1.500 2.700 0 5-2.100 5-5.100C21 8.700 12 2 12 2z',
];

const SUIT_LABEL = ['clubs', 'diamonds', 'hearts', 'spades'];

export function SuitIcon({ suit, className }: { suit: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={SUIT_PATHS[suit]} fill="currentColor" />
    </svg>
  );
}

export interface PlayingCardProps {
  card: Card | null;
  face?: CardFace;
  back?: CardBack;
  className?: string;
  style?: CSSProperties;
}

/** One playing card. `card === null` draws the back: its identity is never in the DOM. */
export const PlayingCard = memo(function PlayingCard({ card, face = 'four_color', back = 'obsidian', className, style }: PlayingCardProps) {
  if (card === null) {
    return <div className={cx('card', 'card-back', `back-${back}`, className)} style={style} aria-label="Face-down card" role="img" />;
  }
  const rank = RANK_CHARS[rankOf(card)];
  const suit = suitOf(card);
  return (
    <div
      className={cx('card', `suit-${suit}`, face === 'four_color' ? 'faces-four' : 'faces-classic', className)}
      style={style}
      role="img"
      aria-label={`${rank === 'T' ? '10' : rank} of ${SUIT_LABEL[suit]}`}
    >
      <span className="card-rank">{rank === 'T' ? '10' : rank}</span>
      <SuitIcon suit={suit} className="card-suit-small" />
      <SuitIcon suit={suit} className="card-suit-large" />
    </div>
  );
});

const DENOMINATIONS = [100000, 25000, 5000, 1000, 500, 100, 25, 5, 1];

/** Breaks an amount into physical chips, like a dealer would. */
function chipBreakdown(amount: number): Array<{ value: number; count: number }> {
  const out: Array<{ value: number; count: number }> = [];
  let left = Math.max(0, Math.round(amount));
  for (const value of DENOMINATIONS) {
    const count = Math.floor(left / value);
    if (count > 0) {
      out.push({ value, count: Math.min(count, 6) });
      left -= count * value;
    }
    if (out.length === 3) break;
  }
  return out;
}

export const ChipStack = memo(function ChipStack({ amount, chipStyle = 'casino', showLabel = true }: { amount: number; chipStyle?: ChipStyle; showLabel?: boolean }) {
  const piles = chipBreakdown(amount);
  return (
    <div className={cx('chips', `chips-${chipStyle}`)}>
      <div className="chip-piles" aria-hidden="true">
        {piles.map(({ value, count }) => (
          <div key={value} className="chip-pile">
            {Array.from({ length: count }, (_, i) => (
              <span key={i} className={`chip chip-${value}`} style={{ '--i': i } as CSSProperties} />
            ))}
          </div>
        ))}
      </div>
      {showLabel && <span className="chip-label">{fmtShort(amount)}</span>}
    </div>
  );
});

const AVATAR_HUES = [205, 268, 340, 28, 152, 190, 305, 48, 12, 232, 118, 330, 170, 285, 60, 215];

/** A generated portrait: colour, silhouette and accessory all come from the index. */
export const Avatar = memo(function Avatar({ index, name, size }: { index: number; name: string; size?: number }) {
  const hue = AVATAR_HUES[index % AVATAR_HUES.length];
  const accessory = index % 5;
  const id = `av${index}`;
  return (
    <svg className="avatar" viewBox="0 0 48 48" role="img" aria-label={name} style={size ? { width: size, height: size } : undefined}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${hue} 55% 42%)`} />
          <stop offset="1" stopColor={`hsl(${(hue + 40) % 360} 60% 20%)`} />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="24" fill={`url(#${id})`} />
      <path d="M8 46c1.500-10 8-15 16-15s14.500 5 16 15a24 24 0 0 1-32 0z" fill={`hsl(${hue} 30% 12%)`} />
      <circle cx="24" cy="20" r="9.500" fill={`hsl(${(hue + 15) % 360} 28% 72%)`} />
      {accessory === 1 && <path d="M12.500 17.500c1-7 6-10 11.500-10s10.500 3 11.500 10c-7-2.500-16-2.500-23 0z" fill={`hsl(${hue} 40% 16%)`} />}
      {accessory === 2 && (
        <g fill="none" stroke={`hsl(${hue} 30% 12%)`} strokeWidth="1.800">
          <rect x="16" y="17.500" width="6.500" height="4.500" rx="2" />
          <rect x="25.500" y="17.500" width="6.500" height="4.500" rx="2" />
          <path d="M22.500 19.500h3" />
        </g>
      )}
      {accessory === 3 && (
        <g fill={`hsl(${hue} 40% 14%)`}>
          <rect x="15" y="15.500" width="18" height="3.500" rx="1.700" />
          <path d="M16 15.500c1-4 4.500-6 8-6s7 2 8 6z" />
        </g>
      )}
      {accessory === 4 && (
        <g fill="none" stroke={`hsl(${hue} 30% 12%)`} strokeWidth="2">
          <path d="M14 21c0-13 20-13 20 0" />
          <rect x="12" y="19.500" width="3.500" height="6" rx="1.700" fill={`hsl(${hue} 30% 12%)`} />
          <rect x="32.500" y="19.500" width="3.500" height="6" rx="1.700" fill={`hsl(${hue} 30% 12%)`} />
        </g>
      )}
    </svg>
  );
});

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="logoGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f3d68c" />
          <stop offset="1" stopColor="#b98a2f" />
        </linearGradient>
      </defs>
      <path d="M16 3s-10.500 7.900-10.500 14.300c0 3.500 2.700 6 5.800 6 1.700 0 3-.6 3.900-1.700-.2 2-1.200 3.600-3.100 4.900h7.800c-1.900-1.300-2.900-2.900-3.100-4.900.9 1.100 2.200 1.700 3.900 1.700 3.100 0 5.800-2.500 5.800-6C26.500 10.900 16 3 16 3z" fill="url(#logoGold)" />
    </svg>
  );
}

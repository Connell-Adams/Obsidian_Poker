/**
 * Cards are small integers (0..51) so that hand evaluation and equity
 * simulation stay allocation-free. rank = card >> 2 (0 = deuce .. 12 = ace),
 * suit = card & 3 (0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades).
 */
export type Card = number;
export type Suit = 0 | 1 | 2 | 3;

export const RANK_CHARS = '23456789TJQKA';
export const SUIT_CHARS = 'cdhs';
export const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'] as const;
export const SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'] as const;

export const RANK_ACE = 12;

export const makeCard = (rank: number, suit: number): Card => (rank << 2) | suit;
export const rankOf = (card: Card): number => card >> 2;
export const suitOf = (card: Card): Suit => (card & 3) as Suit;

export function cardToString(card: Card): string {
  if (!Number.isInteger(card) || card < 0 || card > 51) throw new Error(`Invalid card: ${card}`);
  return RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];
}

export function parseCard(text: string): Card {
  const rank = RANK_CHARS.indexOf(text[0]?.toUpperCase() ?? '');
  const suit = SUIT_CHARS.indexOf(text[1]?.toLowerCase() ?? '');
  if (rank < 0 || suit < 0 || text.length !== 2) throw new Error(`Invalid card text: "${text}"`);
  return makeCard(rank, suit);
}

/** Parses "AsKh" or "As Kh" into cards. */
export function parseCards(text: string): Card[] {
  const compact = text.replace(/[\s,]+/g, '');
  if (compact.length % 2 !== 0) throw new Error(`Invalid card list: "${text}"`);
  const out: Card[] = [];
  for (let i = 0; i < compact.length; i += 2) out.push(parseCard(compact.slice(i, i + 2)));
  return out;
}

export const cardsToString = (cards: readonly Card[]): string => cards.map(cardToString).join(' ');

export function fullDeck(): Card[] {
  const out: Card[] = [];
  for (let c = 0; c < 52; c++) out.push(c);
  return out;
}

/**
 * The 169 strategically distinct starting hands, e.g. "AKs", "T9o", "77".
 * The high rank is always written first.
 */
export function handClass(a: Card, b: Card): string {
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  if (hi === lo) return RANK_CHARS[hi] + RANK_CHARS[lo];
  return RANK_CHARS[hi] + RANK_CHARS[lo] + (suitOf(a) === suitOf(b) ? 's' : 'o');
}

/** Index of a starting hand in a 13x13 grid: pairs on the diagonal, suited below it (row > col). */
export function handClassIndex(a: Card, b: Card): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  return suitOf(a) === suitOf(b) && ra !== rb ? hi * 13 + lo : lo * 13 + hi;
}

export function handClassNameFromIndex(index: number): string {
  const row = Math.floor(index / 13);
  const col = index % 13;
  if (row === col) return RANK_CHARS[row] + RANK_CHARS[row];
  return row > col ? RANK_CHARS[row] + RANK_CHARS[col] + 's' : RANK_CHARS[col] + RANK_CHARS[row] + 'o';
}

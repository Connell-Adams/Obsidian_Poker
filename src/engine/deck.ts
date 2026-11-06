import { type Card, fullDeck } from './cards';
import type { Rng } from './rng';

/**
 * One physical deck. Each hand owns its own instance, cards leave the deck
 * exactly once, and burn cards are consumed without ever being exposed.
 */
export class Deck {
  private readonly cards: Card[];
  private position = 0;
  private burnCount = 0;

  private constructor(cards: Card[]) {
    this.cards = cards;
  }

  /** A fresh Fisher-Yates shuffled 52-card deck. */
  static shuffled(rng: Rng): Deck {
    const cards = fullDeck();
    for (let i = cards.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const tmp = cards[i];
      cards[i] = cards[j];
      cards[j] = tmp;
    }
    return new Deck(cards);
  }

  /**
   * Test helper: `top` is dealt first (in the given order, burns included),
   * the remaining cards follow in shuffled order. Duplicates are rejected.
   */
  static stacked(top: readonly Card[], rng: Rng): Deck {
    const seen = new Set<Card>(top);
    if (seen.size !== top.length) throw new Error('Stacked deck contains duplicates');
    const rest = fullDeck().filter((c) => !seen.has(c));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return new Deck([...top, ...rest]);
  }

  get remaining(): number {
    return this.cards.length - this.position;
  }

  get burned(): number {
    return this.burnCount;
  }

  draw(): Card {
    if (this.position >= this.cards.length) throw new Error('Deck exhausted');
    return this.cards[this.position++];
  }

  /** Discards the top card face down. Its identity is deliberately not returned. */
  burn(): void {
    if (this.position >= this.cards.length) throw new Error('Deck exhausted');
    this.position++;
    this.burnCount++;
  }
}

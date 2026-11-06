import { type Card, rankOf, suitOf } from '../engine/cards';
import { Category, categoryOf, scoreHand } from '../engine/evaluator';

export interface BoardTexture {
  paired: boolean;
  trips: boolean;
  monotone: boolean;
  twoTone: boolean;
  rainbow: boolean;
  /** Three or more of one suit: flushes are possible. */
  flushPossible: boolean;
  /** Three board cards fit in a five-rank window: straights are possible. */
  straightPossible: boolean;
  highRank: number;
  /** 0 (dry) .. 1 (very coordinated). */
  wetness: number;
  description: string;
}

export function analyzeBoard(board: readonly Card[]): BoardTexture {
  const empty = {
    paired: false,
    trips: false,
    monotone: false,
    twoTone: false,
    rainbow: true,
    flushPossible: false,
    straightPossible: false,
    highRank: -1,
    wetness: 0,
    description: 'no board yet',
  };
  if (board.length === 0) return empty;
  const ranks = board.map(rankOf);
  const suits = [0, 0, 0, 0];
  for (const c of board) suits[suitOf(c)]++;
  const maxSuit = Math.max(...suits);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  let mask = 0;
  for (const r of ranks) mask |= 1 << r;
  if (mask & (1 << 12)) mask |= 1 << 13; // the ace also plays low in windows

  let bestWindow = 0;
  for (let low = 0; low <= 9; low++) {
    let count = 0;
    for (let k = 0; k < 5; k++) if (mask & (1 << (low + k))) count++;
    bestWindow = Math.max(bestWindow, count);
  }

  const monotone = maxSuit >= 3 && board.length === 3;
  const twoTone = maxSuit === 2;
  const flushPossible = maxSuit >= 3;
  const straightPossible = bestWindow >= 3;
  const paired = maxCount >= 2;
  const highRank = Math.max(...ranks);

  let wetness = 0;
  wetness += maxSuit >= 4 ? 0.55 : maxSuit === 3 ? 0.42 : maxSuit === 2 ? 0.2 : 0;
  wetness += bestWindow >= 4 ? 0.45 : bestWindow === 3 ? 0.3 : bestWindow === 2 ? 0.1 : 0;
  if (paired) wetness -= 0.15;
  if (highRank <= 9 && !paired) wetness += 0.05;
  wetness = Math.max(0, Math.min(1, wetness));

  const parts: string[] = [];
  if (paired) parts.push(maxCount >= 3 ? 'trips on board' : 'paired');
  if (monotone || maxSuit >= 4) parts.push(maxSuit >= 4 ? 'four to a flush' : 'monotone');
  else if (flushPossible) parts.push('three to a flush');
  else if (twoTone) parts.push('two-tone');
  else parts.push('rainbow');
  if (bestWindow >= 4) parts.push('four to a straight');
  else if (bestWindow === 3) parts.push('connected');
  const label = wetness >= 0.6 ? 'wet' : wetness >= 0.3 ? 'semi-wet' : 'dry';

  return {
    paired,
    trips: maxCount >= 3,
    monotone,
    twoTone,
    rainbow: maxSuit === 1,
    flushPossible,
    straightPossible,
    highRank,
    wetness,
    description: `${label} (${parts.join(', ')})`,
  };
}

export interface HandFeatures {
  score: number;
  category: Category;
  pocketPair: boolean;
  overPair: boolean;
  topPair: boolean;
  /** Kicker of a top pair is a queen or better. */
  goodKicker: boolean;
  middlePair: boolean;
  bottomPair: boolean;
  /** At least one hole card improves on the board alone. */
  usesHole: boolean;
  flushDraw: boolean;
  nutFlushDraw: boolean;
  openEnded: boolean;
  gutshot: boolean;
  /** Outs to a likely best hand on the next card. */
  outs: number;
  overcards: number;
  /** Holds the ace of a suit that could make a flush, a key bluffing blocker. */
  flushBlocker: boolean;
  label: string;
}

/** Ranks whose addition would complete a straight using the given rank mask. */
function straightOuts(mask: number): number {
  const m = mask & (1 << 12) ? mask | (1 << 13) : mask;
  let outs = 0;
  for (let r = 0; r < 13; r++) {
    if (mask & (1 << r)) continue;
    let test = m | (1 << r);
    if (r === 12) test |= 1 << 13;
    for (let low = 0; low <= 9; low++) {
      const run = 0b11111 << low;
      if ((test & run) === run && !((m & run) === run)) {
        outs++;
        break;
      }
    }
  }
  return outs;
}

function hasStraight(mask: number): boolean {
  const m = mask & (1 << 12) ? mask | (1 << 13) : mask;
  for (let low = 0; low <= 9; low++) {
    const run = 0b11111 << low;
    if ((m & run) === run) return true;
  }
  return false;
}

export function analyzeHand(hole: readonly [Card, Card], board: readonly Card[]): HandFeatures {
  const [h1, h2] = hole;
  const r1 = rankOf(h1);
  const r2 = rankOf(h2);
  const pocketPair = r1 === r2;
  if (board.length === 0) {
    return {
      score: 0,
      category: pocketPair ? Category.OnePair : Category.HighCard,
      pocketPair,
      overPair: false,
      topPair: false,
      goodKicker: false,
      middlePair: false,
      bottomPair: false,
      usesHole: true,
      flushDraw: false,
      nutFlushDraw: false,
      openEnded: false,
      gutshot: false,
      outs: 0,
      overcards: 0,
      flushBlocker: false,
      label: pocketPair ? 'pocket pair' : 'unpaired hole cards',
    };
  }

  const cards = [h1, h2, ...board];
  const score = scoreHand(cards);
  const category = categoryOf(score);
  const boardScore = board.length >= 5 ? scoreHand(board) : -1;
  const usesHole = score !== boardScore;

  const boardRanks = [...new Set(board.map(rankOf))].sort((a, b) => b - a);
  const topBoard = boardRanks[0];
  const lowBoard = boardRanks[boardRanks.length - 1];
  const onePair = category === Category.OnePair;
  const pairedRank = onePair ? (score >> 16) & 15 : -1;
  const boardHasPair = new Set(board.map(rankOf)).size < board.length;
  const holePaired = onePair && !boardHasPair;
  const overPair = holePaired && pocketPair && r1 > topBoard;
  const topPair = holePaired && !pocketPair && pairedRank === topBoard;
  const kicker = topPair ? (r1 === pairedRank ? r2 : r1) : -1;
  const goodKicker = topPair && kicker >= 10;
  const middlePair = holePaired && !overPair && !topPair && pairedRank > lowBoard;
  const bottomPair = holePaired && !overPair && !topPair && pairedRank <= lowBoard;

  // Flush draws need at least one hole card in the suit.
  const suitCounts = [0, 0, 0, 0];
  for (const c of cards) suitCounts[suitOf(c)]++;
  let flushDraw = false;
  let nutFlushDraw = false;
  let flushBlocker = false;
  if (board.length < 5) {
    for (let s = 0; s < 4; s++) {
      if (suitCounts[s] !== 4) continue;
      const holeInSuit = [h1, h2].filter((c) => suitOf(c) === s);
      if (holeInSuit.length === 0) continue;
      flushDraw = true;
      const boardInSuit = new Set(board.filter((c) => suitOf(c) === s).map(rankOf));
      let nut = 12;
      while (boardInSuit.has(nut)) nut--;
      nutFlushDraw = holeInSuit.some((c) => rankOf(c) === nut);
    }
  }
  for (let s = 0; s < 4; s++) {
    const boardInSuit = board.filter((c) => suitOf(c) === s).length;
    if (boardInSuit >= 3 && [h1, h2].some((c) => suitOf(c) === s && rankOf(c) === 12)) flushBlocker = true;
  }

  // Straight draws must use a hole card to count: the board alone gives everyone those outs.
  let allMask = 0;
  for (const c of cards) allMask |= 1 << rankOf(c);
  let boardMask = 0;
  for (const c of board) boardMask |= 1 << rankOf(c);
  let openEnded = false;
  let gutshot = false;
  if (board.length < 5 && !hasStraight(allMask)) {
    const withHole = straightOuts(allMask);
    const boardAlone = straightOuts(boardMask);
    if (withHole >= 2 && withHole > boardAlone) openEnded = true;
    else if (withHole === 1 && withHole > boardAlone) gutshot = true;
  }

  const overcards = [r1, r2].filter((r) => r > topBoard).length;
  let outs = 0;
  if (category <= Category.TwoPair) {
    if (flushDraw) outs += 9;
    if (openEnded) outs += flushDraw ? 6 : 8;
    else if (gutshot) outs += flushDraw ? 3 : 4;
    if (category === Category.HighCard) outs += overcards * 3;
    else if (onePair && !topPair && !overPair) outs += 2;
  }

  let label: string;
  if (category >= Category.TwoPair) label = category === Category.TwoPair ? 'two pair' : category === Category.ThreeOfAKind ? 'three of a kind' : 'a very strong made hand';
  else if (overPair) label = 'an overpair';
  else if (topPair) label = goodKicker ? 'top pair, good kicker' : 'top pair, weak kicker';
  else if (middlePair) label = 'middle pair';
  else if (bottomPair) label = 'bottom pair';
  else if (onePair) label = pocketPair ? 'an underpair' : 'a pair on the board';
  else label = 'no pair';
  if (flushDraw && openEnded) label += ' + flush draw and straight draw';
  else if (flushDraw) label += nutFlushDraw ? ' + nut flush draw' : ' + flush draw';
  else if (openEnded) label += ' + open-ended straight draw';
  else if (gutshot) label += ' + gutshot';

  return {
    score,
    category,
    pocketPair,
    overPair,
    topPair,
    goodKicker,
    middlePair,
    bottomPair,
    usesHole,
    flushDraw,
    nutFlushDraw,
    openEnded,
    gutshot,
    outs,
    overcards,
    flushBlocker,
    label,
  };
}

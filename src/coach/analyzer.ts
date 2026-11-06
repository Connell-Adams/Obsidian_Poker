import { analyzeBoard, analyzeHand } from '../ai/features';
import { estimateRange, estimateShare, type RangeContext, toRange } from '../ai/rangeEstimate';
import { boardByStreetOf, type PublicAction } from '../ai/view';
import { type Card, cardsToString, handClass } from '../engine/cards';
import type { BettingStreet, HandEvent } from '../engine/hand';
import type { Rng } from '../engine/rng';
import { type EquityResult, handVsHandExact, handVsRangeExact, multiwayEquity } from '../equity/equity';
import { handPercentile } from '../equity/range';
import type { HandRecord, RecordedPlayer } from '../history/record';
import { buildRead, type StatCounters } from '../stats/counters';

export type Verdict = 'good' | 'fine' | 'close' | 'questionable' | 'mistake';

export interface DecisionReview {
  street: BettingStreet;
  action: string;
  verdict: Verdict;
  /** Plain-language explanation with the numbers behind it. */
  text: string;
  pot: number;
  toCall: number;
  /** Break-even equity for a call, null when no call was faced. */
  requiredEquity: number | null;
  /** Estimated equity against the opponent ranges below. Null when not computed. */
  equity: number | null;
  equityMargin: number | null;
  exact: boolean;
  /** Estimated EV given up against the better option, in big blinds. 0 when none. */
  evLossBB: number;
  /** Facts both players could see. */
  known: string[];
  /** Assumptions the estimate depends on. */
  estimated: string[];
}

export interface HandReview {
  handId: string;
  headline: string;
  heroCards: string;
  position: string;
  decisions: DecisionReview[];
  /** Spots where a different line was likely better, from recorded actions. */
  opportunities: string[];
  /** Filled only with cards actually shown at showdown. */
  showdownNotes: string[];
  riskNote: string | null;
  evLossBB: number;
  mistakes: number;
  questionable: number;
  good: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const bbs = (chips: number, bb: number) => `${(chips / bb).toFixed(1)} BB`;

export interface AnalysisOptions {
  iterations: number;
  rng: Rng;
  /** Public observations of each player at the time of the hand. */
  countersOf: (id: string) => StatCounters | undefined;
}

const OPEN_BY_BEHIND = [0.9, 0.42, 0.46, 0.29, 0.22, 0.18, 0.15, 0.13, 0.115];

interface HeroDecisionPoint {
  event: Extract<HandEvent, { t: 'action' }>;
  actionsBefore: PublicAction[];
  board: Card[];
  index: number;
}

function collectHeroDecisions(record: HandRecord): HeroDecisionPoint[] {
  const points: HeroDecisionPoint[] = [];
  const actions: PublicAction[] = [];
  let board: Card[] = [];
  record.events.forEach((e, index) => {
    if (e.t === 'board') board = e.board;
    if (e.t !== 'action') return;
    if (e.seat === record.heroSeat) points.push({ event: e, actionsBefore: [...actions], board: [...board], index });
    actions.push({ seat: e.seat, street: e.street, action: e.action, added: e.added, to: e.to, allIn: e.allIn, facing: e.facing, potBefore: e.potBefore });
  });
  return points;
}

function liveOpponents(record: HandRecord, actionsBefore: readonly PublicAction[]): RecordedPlayer[] {
  const folded = new Set(actionsBefore.filter((a) => a.action === 'fold').map((a) => a.seat));
  return record.players.filter((p) => p.seat !== record.heroSeat && !folded.has(p.seat));
}

function describeAction(e: Extract<HandEvent, { t: 'action' }>, bb: number): string {
  const allIn = e.allIn ? ' all-in' : '';
  switch (e.action) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return `Call ${e.added.toLocaleString()} (${bbs(e.added, bb)})${allIn}`;
    case 'bet':
      return `Bet ${e.to.toLocaleString()} (${bbs(e.to, bb)})${allIn}`;
    case 'raise':
      return `Raise to ${e.to.toLocaleString()} (${bbs(e.to, bb)})${allIn}`;
  }
}

/** Equity with exact enumeration wherever practical, and a stated margin otherwise. */
function estimateEquity(hero: readonly [Card, Card], ranges: ReadonlyArray<ReturnType<typeof toRange>>, board: readonly Card[], options: AnalysisOptions): EquityResult {
  if (ranges.length === 1 && board.length >= 4) return handVsRangeExact(hero, ranges[0], board);
  return multiwayEquity(hero, ranges, board, options.iterations, options.rng);
}

/** Reviews one completed hand from the player's perspective. Never reads hidden cards. */
export function analyzeHand_(record: HandRecord, options: AnalysisOptions): HandReview | null {
  if (record.heroSeat === null) return null;
  const hero = record.players.find((p) => p.seat === record.heroSeat)!;
  const bb = record.bb;
  const decisions: DecisionReview[] = [];
  const opportunities: string[] = [];
  const heroHole = hero.hole;
  const maxInvested = { chips: 0 };

  for (const point of collectHeroDecisions(record)) {
    const review = point.event.street === 'preflop'
      ? reviewPreflop(record, hero, point, options)
      : reviewPostflop(record, hero, point, options, opportunities);
    decisions.push(review);
    maxInvested.chips += point.event.added;
  }

  const showdownNotes = showdownNotesFor(record, hero);
  const riskFraction = hero.startStack > 0 ? (hero.startStack - hero.finalStack) / hero.startStack : 0;
  let riskNote: string | null = null;
  if (riskFraction >= 0.5 && hero.net < 0) {
    riskNote = `You lost ${pct(riskFraction)} of your stack in this hand (${bbs(-hero.net, bb)}). Check that the strength of your hand justified committing that much at each street.`;
  } else if (riskFraction > 0 && hero.net < 0 && hero.net / bb < -40) {
    riskNote = `A ${bbs(-hero.net, bb)} loss is large. The review above shows where most of those chips went in.`;
  }

  const evLossBB = decisions.reduce((sum, d) => sum + d.evLossBB, 0);
  const mistakes = decisions.filter((d) => d.verdict === 'mistake').length;
  const questionable = decisions.filter((d) => d.verdict === 'questionable').length;
  const good = decisions.filter((d) => d.verdict === 'good').length;
  let headline: string;
  if (decisions.length === 0) headline = 'You had no decision this hand.';
  else if (mistakes > 0) headline = `${mistakes} likely mistake${mistakes > 1 ? 's' : ''}, about ${evLossBB.toFixed(1)} BB of estimated value.`;
  else if (questionable > 0) headline = `Mostly solid, with ${questionable} questionable decision${questionable > 1 ? 's' : ''}.`;
  else headline = 'Your decisions look reasonable against the estimated ranges.';

  return {
    handId: record.id,
    headline,
    heroCards: cardsToString(heroHole),
    position: hero.position,
    decisions,
    opportunities,
    showdownNotes,
    riskNote,
    evLossBB,
    mistakes,
    questionable,
    good,
  };
}

function reviewPreflop(record: HandRecord, hero: RecordedPlayer, point: HeroDecisionPoint, options: AnalysisOptions): DecisionReview {
  const { event, actionsBefore } = point;
  const bb = record.bb;
  const cls = handClass(hero.hole[0], hero.hole[1]);
  const pctile = handPercentile(hero.hole[0], hero.hole[1]);
  const position = hero.position;
  const raises = actionsBefore.filter((a) => a.action === 'raise').length;
  const limpers = actionsBefore.filter((a) => a.action === 'call').length;
  const known = [`You held ${cls} in ${position}.`, `Pot before acting: ${bbs(event.potBefore, bb)}.`];
  const base = {
    street: 'preflop' as const,
    action: describeAction(event, bb),
    pot: event.potBefore,
    toCall: event.facing,
    known,
  };

  if (raises === 0) {
    // First-in: compare against a standard opening guideline by players left to act.
    const seatCount = record.players.length;
    const firstIndex = seatCount === 2 ? 1 : 2 % seatCount;
    const heroIndex = record.players.findIndex((p) => p.seat === hero.seat);
    const order = (heroIndex - firstIndex + seatCount) % seatCount;
    const behind = seatCount - 1 - order;
    const guideline = seatCount === 2 ? 0.82 : seatCount === 3 ? 0.55 : OPEN_BY_BEHIND[Math.min(behind, 8)];
    const estimated = [`Guideline: opening about the top ${pct(guideline)} of hands with ${behind} player${behind === 1 ? '' : 's'} left to act. This is a common baseline, not a solver result.`];
    const inside = pctile <= guideline;
    if (event.action === 'raise') {
      const size = event.to / bb;
      const sizing = size < 2 ? ' That open is smaller than usual, so it gives the blinds a good price.' : size > 4.5 + limpers ? ' That open is larger than usual: you risk more to win the same blinds.' : '';
      if (inside) return { ...base, verdict: sizing ? 'fine' : 'good', text: `${cls} sits in the top ${pct(pctile)} of hands, inside the opening guideline for ${position}.${sizing}`, requiredEquity: null, equity: null, equityMargin: null, exact: false, evLossBB: 0, estimated };
      const far = pctile > guideline * 1.6;
      return { ...base, verdict: far ? 'questionable' : 'close', text: `${cls} ranks around the top ${pct(pctile)} of hands, wider than the ${pct(guideline)} guideline for ${position}. Loose opens out of position to the players behind you are a common source of small, steady losses.${sizing}`, requiredEquity: null, equity: null, equityMargin: null, exact: false, evLossBB: 0, estimated };
    }
    if (event.action === 'call' && !event.allIn) {
      return { ...base, verdict: inside ? 'questionable' : 'close', text: inside ? `Limping ${cls} gives up the initiative with a hand strong enough to raise. A raise wins the blinds immediately more often and builds the pot when you have an edge.` : `Limping a hand this weak invites a raise you cannot continue against. Folding is usually better.`, requiredEquity: null, equity: null, equityMargin: null, exact: false, evLossBB: 0, estimated };
    }
    if (event.action === 'fold' && event.facing > 0) {
      const tooTight = pctile < guideline * 0.55;
      return { ...base, verdict: tooTight ? 'questionable' : 'good', text: tooTight ? `You folded ${cls} first-in. It sits in the top ${pct(pctile)} of hands, well inside the ${pct(guideline)} guideline for ${position}, so raising is normally profitable.` : `Folding ${cls} (top ${pct(pctile)}) is in line with the ${pct(guideline)} guideline for ${position}.`, requiredEquity: null, equity: null, equityMargin: null, exact: false, evLossBB: 0, estimated };
    }
    if (event.action === 'check') {
      return { ...base, verdict: 'fine', text: `A free look at the flop with ${cls} from the big blind.${pctile < 0.1 ? ' A hand this strong can usually raise for value.' : ''}`, requiredEquity: null, equity: null, equityMargin: null, exact: false, evLossBB: 0, estimated };
    }
    return { ...base, verdict: 'fine', text: `${cls} ranks in the top ${pct(pctile)} of hands.`, requiredEquity: null, equity: null, equityMargin: null, exact: false, evLossBB: 0, estimated };
  }

  // Facing a raise: compare equity against the estimated range with the price offered.
  const ctx: RangeContext = { players: record.players, actions: actionsBefore, boardByStreet: { preflop: [] }, dead: [...hero.hole], bigBlind: bb };
  const opponents = liveOpponents(record, actionsBefore).filter((p) => actionsBefore.some((a) => a.seat === p.seat));
  const opp = opponents.length ? opponents : liveOpponents(record, actionsBefore).slice(0, 1);
  const estimates = opp.map((p) => ({ p, est: estimateRange(ctx, p.seat, buildRead(options.countersOf(p.id))) }));
  const eq = estimateEquity(hero.hole, estimates.map((x) => toRange(x.est)), [], options);
  const required = event.facing > 0 ? event.facing / (event.potBefore + event.facing) : 0;
  const estimated = estimates.flatMap(({ p, est }) => {
    const n = options.countersOf(p.id)?.hands ?? 0;
    return [`${p.name} ${est.notes[est.notes.length - 1] ?? 'range estimated'} (based on ${n} observed hands).`];
  });
  const margin = eq.stderr * 2;
  const equityText = `Against the estimated range you had about ${pct(eq.equity)} equity`;
  const position_ = hero.position === 'BB' || hero.position === 'SB' ? 0.75 : 0.9;
  const realised = eq.equity * position_;
  const base2 = { ...base, requiredEquity: event.facing > 0 ? required : null, equity: eq.equity, equityMargin: margin, exact: eq.exact, estimated };

  if (event.action === 'fold') {
    if (realised > required + 0.1) return { ...base2, verdict: 'questionable', evLossBB: ((realised - required) * (event.potBefore + event.facing)) / bb, text: `${equityText}, and the call needed ${pct(required)}. Even allowing for playing the hand ${position_ < 0.9 ? 'out of position' : 'after the flop'}, folding looks too tight here.` };
    return { ...base2, verdict: 'good', evLossBB: 0, text: `${equityText}, and you needed ${pct(required)} plus enough to play the hand after the flop. Folding is reasonable.` };
  }
  if (event.action === 'call') {
    if (realised < required - 0.08) {
      const loss = ((required - realised) * (event.potBefore + event.facing)) / bb;
      return { ...base2, verdict: 'mistake', evLossBB: loss, text: `Calling needed ${pct(required)} equity to break even. ${equityText}, closer to ${pct(realised)} after allowing for ${position_ < 0.9 ? 'playing out of position' : 'future betting'}. This call is likely negative EV by about ${loss.toFixed(1)} BB.` };
    }
    if (realised < required) return { ...base2, verdict: 'close', evLossBB: 0, text: `A close call: you needed ${pct(required)} and had about ${pct(eq.equity)} before allowing for position. It relies on winning extra chips after the flop.` };
    return { ...base2, verdict: 'good', evLossBB: 0, text: `${equityText}, comfortably above the ${pct(required)} the price required.` };
  }
  // A re-raise.
  const strong = pctile < 0.08;
  const size = event.to / Math.max(1, actionsBefore.filter((a) => a.action === 'raise').at(-1)?.to ?? bb);
  const sizeNote = size < 2.2 ? ' That size is small, offering a good price to continue.' : size > 4.5 && !event.allIn ? ' That size is large for the hands you keep calling with.' : '';
  return {
    ...base2,
    verdict: strong ? 'good' : pctile < 0.25 ? 'fine' : 'close',
    evLossBB: 0,
    text: strong
      ? `${cls} (top ${pct(pctile)}) is a clear value re-raise.${sizeNote}`
      : `${cls} ranks in the top ${pct(pctile)}, so this re-raise is mainly a bluff or thin value play. ${equityText} if called. It needs enough folds to work.${sizeNote}`,
  };
}

function reviewPostflop(record: HandRecord, hero: RecordedPlayer, point: HeroDecisionPoint, options: AnalysisOptions, opportunities: string[]): DecisionReview {
  const { event, actionsBefore, board } = point;
  const bb = record.bb;
  const street = event.street;
  const features = analyzeHand(hero.hole, board);
  const texture = analyzeBoard(board);
  const opponents = liveOpponents(record, actionsBefore);
  const ctx: RangeContext = {
    players: record.players,
    actions: actionsBefore,
    boardByStreet: boardByStreetOf(board),
    dead: [...hero.hole, ...board],
    bigBlind: bb,
  };
  const estimates = opponents.map((p) => ({ p, read: buildRead(options.countersOf(p.id)), est: estimateRange(ctx, p.seat, buildRead(options.countersOf(p.id))) }));
  const ranges = estimates.map((x) => toRange(x.est));
  const eq = estimateEquity(hero.hole, ranges, board, options);
  const margin = eq.exact ? 0 : eq.stderr * 2;
  const pot = event.potBefore;
  const toCall = event.facing;
  const required = toCall > 0 ? toCall / (pot + toCall) : null;

  const estimated = estimates.map(({ p, est }) => {
    const n = options.countersOf(p.id)?.hands ?? 0;
    return `${p.name}'s range is modelled as about ${Math.round(estimateShare(est) * 100)}% of hands, from position, the betting so far and ${n} observed hands.`;
  });
  estimated.push(eq.exact ? 'Equity was enumerated exactly against that range.' : `Equity was simulated (${eq.samples.toLocaleString()} runouts, roughly ±${pct1(margin)}).`);
  const known = [
    `You held ${cardsToString(hero.hole)} on ${cardsToString(board)}: ${features.label}.`,
    `Board: ${texture.description}.`,
    `Pot ${bbs(pot, bb)}${toCall > 0 ? `, ${bbs(toCall, bb)} to call` : ''}.`,
  ];

  const outs = features.outs;
  const R = street === 'river' ? 1 : 0.92;
  const realised = eq.equity * R;
  const base = {
    street,
    action: describeAction(event, bb),
    pot,
    toCall,
    requiredEquity: required,
    equity: eq.equity,
    equityMargin: margin,
    exact: eq.exact,
    known,
    estimated,
  };
  const eqText = `Against the estimated range your hand had about ${pct(eq.equity)} equity`;
  const streetName = street === 'flop' ? 'flop' : street === 'turn' ? 'turn' : 'river';

  switch (event.action) {
    case 'call': {
      const req = required ?? 0;
      const potAfter = pot + toCall;
      if (realised >= req) {
        const edge = ((realised - req) * potAfter) / bb;
        return { ...base, verdict: realised - req > 0.1 ? 'good' : 'fine', evLossBB: 0, text: `Your ${streetName} call required about ${pct(req)} equity to break even. ${eqText}, so it is likely +EV by around ${edge.toFixed(1)} BB.` };
      }
      const drawNote = street !== 'river' && outs >= 4 ? ` You also have ${outs} outs, so stack depth may justify this through implied odds.` : '';
      const gap = req - realised;
      const lossBB = (gap * potAfter) / bb;
      if (gap <= (street === 'river' ? 0.03 : 0.07) || drawNote) {
        return { ...base, verdict: 'close', evLossBB: drawNote ? 0 : lossBB, text: `Your ${streetName} call required about ${pct(req)} equity. ${eqText}: a close decision.${drawNote}` };
      }
      return {
        ...base,
        verdict: gap > 0.12 ? 'mistake' : 'questionable',
        evLossBB: lossBB,
        text: `Your ${streetName} call required approximately ${pct(req)} equity to break even. ${eqText}. This decision is likely negative EV by about ${lossBB.toFixed(1)} BB.`,
      };
    }
    case 'fold': {
      if (toCall === 0) return { ...base, verdict: 'mistake', evLossBB: (eq.equity * pot) / bb, text: 'You folded when checking was free. Checking cannot cost anything here.' };
      const req = required ?? 0;
      if (realised > req + (street === 'river' ? 0.05 : 0.1)) {
        const lossBB = ((realised - req) * (pot + toCall)) / bb;
        return { ...base, verdict: realised > req + 0.18 ? 'mistake' : 'questionable', evLossBB: lossBB, text: `Folding gave up about ${lossBB.toFixed(1)} BB of estimated value. ${eqText}, and calling only needed ${pct(req)}. Check the estimate against what you know about this player, but you may be folding too much here.` };
      }
      return { ...base, verdict: 'good', evLossBB: 0, text: `A disciplined fold: you needed ${pct(req)} and had about ${pct(eq.equity)} against the estimated range.` };
    }
    case 'check': {
      if (eq.equity > 0.72 && street === 'river' && opponents.length === 1) {
        const thin = (eq.equity - 0.5) * pot * 0.5;
        opportunities.push(`River value: with about ${pct(eq.equity)} equity, a bet of half the pot would likely have been called by worse hands. Estimated gain around ${(thin / bb).toFixed(1)} BB.`);
        return { ...base, verdict: 'questionable', evLossBB: thin / bb, text: `You checked the river with about ${pct(eq.equity)} equity. That is usually strong enough to bet for value, since worse hands can call.` };
      }
      if (eq.equity > 0.78) {
        opportunities.push(`Slow-play on the ${streetName}: you checked with about ${pct(eq.equity)} equity on a ${texture.wetness >= 0.5 ? 'coordinated' : 'dry'} board. ${texture.wetness >= 0.5 ? 'Betting protects against the many draws.' : 'Trapping is reasonable on a dry board if your opponent bets often.'}`);
        return { ...base, verdict: texture.wetness >= 0.5 ? 'questionable' : 'fine', evLossBB: 0, text: `You checked with about ${pct(eq.equity)} equity. ${texture.wetness >= 0.5 ? 'On this coordinated board, betting usually does better: it gets value and denies free cards.' : 'Slow-playing is defensible on a dry board.'}` };
      }
      if (eq.equity < 0.3 && opponents.length === 1 && street !== 'river') {
        const v = estimates[0];
        const foldRate = street === 'flop' ? v.read.foldFlop : v.read.foldTurn;
        if (foldRate > 0.55 && (features.flushDraw || features.openEnded)) {
          opportunities.push(`Semi-bluff spot: ${v.p.name} folds about ${pct(foldRate)} on the ${streetName}, and you had a draw with ${outs} outs. A bet could win immediately or improve.`);
        }
      }
      if (eq.equity < 0.2 && street === 'river' && opponents.length === 1) {
        const v = estimates[0];
        const n = options.countersOf(v.p.id)?.facedBetRiver ?? 0;
        if (n >= 15 && v.read.foldRiver > 0.6) {
          opportunities.push(`River bluff: ${v.p.name} has folded about ${pct(v.read.foldRiver)} to river bets over ${n} observed. A half-pot bluff only needs to work 33% of the time.`);
        }
      }
      return { ...base, verdict: 'fine', evLossBB: 0, text: `Checking with about ${pct(eq.equity)} equity is reasonable: ${eq.equity > 0.5 ? 'you keep the pot manageable and may induce a bluff' : 'you have little to gain by betting and can see the next card or showdown for free'}.` };
    }
    case 'bet':
    case 'raise': {
      const raisePart = event.added - toCall;
      const base2 = pot + toCall;
      const ratio = base2 > 0 ? raisePart / base2 : 0;
      const breakEvenFolds = raisePart / (base2 + raisePart);
      let sizing = '';
      if (ratio < 0.25 && !event.allIn) sizing = ` At ${pct(ratio)} of the pot, this is small: it gives a very good price and folds out little.`;
      else if (ratio > 1.5 && !event.allIn) sizing = ` At ${pct(ratio)} of the pot, this is very large and works best with very strong hands or bluffs.`;
      else if (texture.wetness >= 0.6 && ratio < 0.4) sizing = ' On a board this coordinated, a bigger size usually charges draws better.';
      const verb = event.action === 'bet' ? 'bet' : 'raise';

      if (eq.equity >= 0.6) {
        return { ...base, verdict: sizing ? 'fine' : 'good', evLossBB: 0, text: `A value ${verb} with about ${pct(eq.equity)} equity against the estimated range: worse hands can call.${sizing}` };
      }
      if (outs >= 8 && street !== 'river') {
        return { ...base, verdict: sizing ? 'fine' : 'good', evLossBB: 0, text: `A semi-bluff with ${outs} outs and about ${pct(eq.equity)} equity. Folds win immediately, and you can still improve when called. It needs folds about ${pct(breakEvenFolds)} of the time to profit on the spot, less given your outs.${sizing}` };
      }
      const v = estimates[0];
      const foldRate = v ? (street === 'flop' ? v.read.foldFlop : street === 'turn' ? v.read.foldTurn : v.read.foldRiver) : 0.4;
      const multiNote = opponents.length > 1 ? ` With ${opponents.length} opponents, everyone must fold, which is much less likely.` : '';
      const foldTotal = Math.pow(foldRate, opponents.length);
      if (eq.equity >= 0.35) {
        return { ...base, verdict: 'close', evLossBB: 0, text: `A thin ${verb} with about ${pct(eq.equity)} equity: too weak for clear value, too strong for a pure bluff. It needs folds about ${pct(breakEvenFolds)} of the time.${sizing}${multiNote}` };
      }
      const profitable = foldTotal >= breakEvenFolds;
      if (!profitable) {
        const lossBB = ((breakEvenFolds - foldTotal) * (raisePart + base2)) / bb;
        return { ...base, verdict: breakEvenFolds - foldTotal > 0.2 ? 'mistake' : 'questionable', evLossBB: lossBB, text: `This bluff needs folds about ${pct(breakEvenFolds)} of the time to break even, but the estimate for this spot is about ${pct(foldTotal)}. With only ${pct(eq.equity)} equity when called, it is likely negative EV by about ${lossBB.toFixed(1)} BB.${sizing}${multiNote}` };
      }
      return { ...base, verdict: sizing ? 'close' : 'good', evLossBB: 0, text: `A bluff that needs folds about ${pct(breakEvenFolds)} of the time. The estimate for this spot is about ${pct(foldTotal)}, so it can show a profit.${sizing}` };
    }
  }
}

function showdownNotesFor(record: HandRecord, hero: RecordedPlayer): string[] {
  const notes: string[] = [];
  if (!record.wentToShowdown || !hero.shown) return notes;
  for (const p of record.players) {
    if (p.seat === hero.seat || !p.shown || p.folded) continue;
    notes.push(`${p.name} showed ${cardsToString(p.hole)}. This is known only because it reached showdown.`);
    // With both hands now known, compute the true equity on each earlier street.
    const seen: string[] = [];
    for (const street of ['flop', 'turn'] as const) {
      const boardAt = boardByStreetOf(record.board)[street];
      if (!boardAt) continue;
      const exact = handVsHandExact(hero.hole, p.hole, boardAt);
      seen.push(`${street} ${pct(exact.equity)}`);
    }
    if (seen.length) notes.push(`With both hands known, your actual equity was: ${seen.join(', ')}.`);
  }
  return notes;
}

export { analyzeHand_ as reviewHand };

import { rankOf, suitOf } from '../engine/cards';
import type { LegalActions, PlayerAction } from '../engine/hand';
import type { Rng } from '../engine/rng';
import { aggressiveAction, clampTo, multipleTo, potFractionTo } from '../engine/sizing';
import { multiwayEquity } from '../equity/equity';
import { handPercentile } from '../equity/range';
import { blendRead, buildRead, type PlayerRead, PRIOR_READ, type StatCounters } from '../stats/counters';
import { type EffectiveStyle, effectiveStyle, type EmotionalState } from './emotions';
import { analyzeBoard, analyzeHand, type BoardTexture, type HandFeatures } from './features';
import type { BotProfile } from './profiles';
import { type EstimatedRange, estimateRange, type RangeContext, toRange } from './rangeEstimate';
import type { PublicHandView, PublicPlayer } from './view';

export type DecisionBasis = 'range' | 'ev' | 'push_fold' | 'mistake';

export interface CandidateTrace {
  label: string;
  ev: number;
  utility: number;
}

export interface Decision {
  action: PlayerAction;
  /** Whether this came from opening ranges, EV estimates, push/fold, or a modelled human error. */
  basis: DecisionBasis;
  mistake?: string;
  equity: number | null;
  potOdds: number;
  /** 0 easy .. 1 close decision. Drives thinking time. */
  complexity: number;
  /** 0..1 the bot's own estimate of how strong it is. */
  strength: number;
  candidates: CandidateTrace[];
}

export interface DecisionInput {
  profile: BotProfile;
  mood: EmotionalState;
  view: PublicHandView;
  /** Public observations on other players. */
  countersOf: (id: string) => StatCounters | undefined;
  rng: Rng;
  /** Background tournament tables use cheaper estimates. */
  fast?: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Villain {
  player: PublicPlayer;
  read: PlayerRead;
  estimate: EstimatedRange;
}

/** Everything the EV estimate needs, assembled once per decision. */
interface Situation {
  input: DecisionInput;
  style: EffectiveStyle;
  view: PublicHandView;
  legal: LegalActions;
  rng: Rng;
  fast: boolean;
  me: PublicPlayer;
  villains: Villain[];
  main: Villain | null;
  iterations: number;
  equity: number;
  features: HandFeatures;
  texture: BoardTexture;
  inPosition: boolean;
  /** Players still to act behind us this round who have not folded. */
  playersBehind: number;
  effectiveStack: number;
  spr: number;
  premium: number;
  /** Number of streets on which we have been the aggressor: our story. */
  myAggression: number;
  isPreflopAggressor: boolean;
  eqCache: Map<number, number>;
  raisesThisStreet: number;
}

function readFor(input: DecisionInput, style: EffectiveStyle, id: string): PlayerRead {
  const counters = input.countersOf(id);
  if (!counters) return PRIOR_READ;
  // Only a meaningful sample moves the read, and only as far as the bot is able to adapt.
  const sampleGate = clamp((counters.hands - 12) / 60, 0, 1);
  const weight = style.adaptability * (0.2 + 0.8 * style.skill) * sampleGate;
  return blendRead(buildRead(counters), weight);
}

function makeRangeContext(view: PublicHandView): RangeContext {
  return {
    players: view.players,
    actions: view.actions,
    boardByStreet: view.boardByStreet,
    dead: [...view.hole, ...view.board],
    bigBlind: view.bigBlind,
  };
}

function playersBehindCount(view: PublicHandView): number {
  // Players are in deal order. Preflop the first actor follows the big blind.
  const n = view.players.length;
  const myIndex = view.players.findIndex((p) => p.seat === view.seat);
  const firstIndex = view.street === 'preflop' ? (n === 2 ? 1 : 2 % n) : 0;
  const myOrder = (myIndex - firstIndex + n) % n;
  let count = 0;
  for (let i = myOrder + 1; i < n; i++) {
    const p = view.players[(firstIndex + i) % n];
    if (!p.folded && !p.allIn) count++;
  }
  return count;
}

function buildSituation(input: DecisionInput, style: EffectiveStyle): Situation {
  const { view, rng } = input;
  const fast = input.fast ?? false;
  const me = view.players.find((p) => p.seat === view.seat)!;
  const ctx = makeRangeContext(view);
  const others = view.players.filter((p) => p.seat !== view.seat && !p.folded);

  // Preflop, players who have not acted yet are excluded: most of them will fold.
  const acted = new Set(view.actions.filter((a) => a.street === 'preflop').map((a) => a.seat));
  const relevant = view.street === 'preflop' ? others.filter((p) => acted.has(p.seat) && p.contributed > 0) : others;
  const opponents = relevant.length > 0 ? relevant : others.slice(0, 1);

  const villains: Villain[] = opponents.map((player) => {
    const read = readFor(input, style, player.id);
    return { player, read, estimate: estimateRange(ctx, player.seat, read) };
  });

  // The last player to bet or raise is who we must beat; otherwise the first opponent.
  let main: Villain | null = villains[0] ?? null;
  for (const a of view.actions) {
    if (a.action === 'bet' || a.action === 'raise') {
      const v = villains.find((x) => x.player.seat === a.seat);
      if (v) main = v;
    }
  }

  // Skill sharpens the estimate. Weak players judge their chances less precisely.
  const iterations = fast ? 90 : Math.round(lerp(120, 420, style.skill));
  const ranges = villains.map((v) => toRange(v.estimate));
  const raw = multiwayEquity(view.hole, ranges, view.board, iterations, rng).equity;
  const misjudge = (1 - style.skill) * 0.07 * (rng.next() + rng.next() - 1);
  const equity = clamp(raw + misjudge, 0, 1);

  const biggestOpponent = Math.max(0, ...others.map((p) => p.stack + p.streetBet));
  const effectiveStack = Math.min(me.stack + me.streetBet, biggestOpponent);
  const myStreets = new Set(view.actions.filter((a) => a.seat === view.seat && (a.action === 'bet' || a.action === 'raise')).map((a) => a.street));

  let preflopAggressor: number | null = null;
  for (const a of view.actions) if (a.street === 'preflop' && a.action === 'raise') preflopAggressor = a.seat;

  // We act last if no live opponent sits after us in deal order.
  const myIndex = view.players.findIndex((p) => p.seat === view.seat);
  const inPosition = view.street === 'preflop'
    ? playersBehindCount(view) === 0 && me.position !== 'SB' && me.position !== 'BB'
    : !view.players.slice(myIndex + 1).some((p) => !p.folded && !p.allIn);

  return {
    input,
    style,
    view,
    legal: view.legal,
    rng,
    fast,
    me,
    villains,
    main,
    iterations,
    equity,
    features: analyzeHand(view.hole, view.board),
    texture: analyzeBoard(view.board),
    inPosition,
    playersBehind: playersBehindCount(view),
    effectiveStack,
    spr: view.pot > 0 ? effectiveStack / view.pot : 99,
    premium: view.tournament?.riskPremium ?? 0,
    myAggression: myStreets.size,
    isPreflopAggressor: preflopAggressor === view.seat,
    eqCache: new Map(),
    raisesThisStreet: view.actions.filter((a) => a.street === view.street && a.action === 'raise').length,
  };
}

/** Equity against only the part of the main opponent's range that continues. */
function equityVsContinuing(sit: Situation, continuing: number): number {
  if (!sit.main || continuing >= 0.97) return sit.equity;
  const bucket = Math.round(clamp(continuing, 0.05, 1) * 5) / 5 || 0.2;
  const cached = sit.eqCache.get(bucket);
  if (cached !== undefined) return cached;
  const ranges = sit.villains.map((v) => toRange(v.estimate, v === sit.main ? Math.max(bucket, 0.08) : 1));
  const iterations = sit.fast ? 60 : Math.round(sit.iterations * 0.6);
  const value = multiwayEquity(sit.view.hole, ranges, sit.view.board, iterations, sit.rng).equity;
  // The estimate can never credibly exceed the equity against the whole range by much.
  const result = Math.min(value, sit.equity + 0.03);
  sit.eqCache.set(bucket, result);
  return result;
}

/** How often one opponent folds to a bet or raise of `ratio` times the pot. */
function foldChance(sit: Situation, villain: Villain, ratio: number): number {
  const { read } = villain;
  const street = sit.view.street;
  let base: number;
  if (street === 'preflop') base = sit.raisesThisStreet >= 1 ? read.foldTo3Bet : read.blindFold;
  else if (street === 'flop') base = sit.isPreflopAggressor ? read.foldToCbet : read.foldFlop;
  else if (street === 'turn') base = read.foldTurn;
  else base = read.foldRiver;

  let f = base * (0.55 + 0.45 * (ratio / (1 + ratio) / 0.4));
  const hasBetThisStreet = sit.view.actions.some((a) => a.seat === villain.player.seat && a.street === street && (a.action === 'bet' || a.action === 'raise'));
  if (hasBetThisStreet) f *= sit.raisesThisStreet >= 2 ? 0.55 : 0.72;
  f *= 1 + 0.08 * sit.myAggression;
  f *= 1 - 0.12 * sit.texture.wetness;
  // Someone who has already committed a big share of their stack rarely gives up.
  const committed = villain.player.contributed / Math.max(1, villain.player.startStack);
  if (committed > 0.35) f *= 1 - 0.5 * clamp((committed - 0.35) / 0.5, 0, 1);
  if (sit.view.tournament?.isBubble && villain.player.stack < sit.me.stack) f *= 1.2;
  return clamp(f, 0.01, 0.93);
}

function realization(sit: Situation): number {
  if (sit.view.street === 'river') return 1;
  if (sit.view.street === 'preflop') {
    // Preflop equity is badly overstated for weak hands, more so out of position.
    let r = lerp(0.8, sit.inPosition ? 0.9 : 0.7, sit.style.position);
    if (sit.equity > 0.5) r += (sit.equity - 0.5) * 0.7;
    r -= 0.02 * sit.playersBehind;
    if (sit.raisesThisStreet >= 2) r += 0.12;
    return r * (1 + (sit.style.skill - 0.5) * 0.08);
  }
  const position = lerp(0.97, sit.inPosition ? 1.04 : 0.9, sit.style.position);
  const multiway = sit.villains.length > 1 ? 0.96 : 1;
  const skill = 1 + (sit.style.skill - 0.5) * 0.06;
  return position * multiway * skill;
}

function impliedOdds(sit: Situation): number {
  const { view, features, effectiveStack } = sit;
  if (view.street === 'river') return 0;
  const toCall = sit.legal.callAmount;
  if (toCall <= 0) return 0;
  const behind = Math.max(0, effectiveStack - sit.me.streetBet - toCall);
  if (view.street === 'preflop') {
    const [a, b] = view.hole;
    const depth = clamp((behind / toCall - 8) / 14, 0, 1);
    if (rankOf(a) === rankOf(b)) return 0.118 * Math.min(behind, view.pot * 4) * 0.55 * depth;
    const connected = Math.abs(rankOf(a) - rankOf(b)) <= 2;
    const suited = suitOf(a) === suitOf(b);
    if (suited && connected) return 0.07 * Math.min(behind, view.pot * 3) * 0.5 * depth;
    if (suited && Math.max(rankOf(a), rankOf(b)) === 12) return 0.06 * Math.min(behind, view.pot * 3) * 0.5 * depth;
    return 0;
  }
  if (features.outs < 4) return 0;
  const hitChance = features.outs / (view.street === 'flop' ? 47 : 46);
  return hitChance * Math.min(behind, view.pot) * 0.45;
}

/**
 * Whether this hand belongs in the re-raising range at all. Real players choose
 * value hands plus a few well-suited bluffs; the EV estimate then only compares
 * sizes and alternatives. Tighter opponents shrink the value range, and opponents
 * seen folding too much to re-raises attract more bluffs.
 */
function allowPreflopReraise(sit: Situation): boolean {
  const { view, style, rng } = sit;
  const [a, b] = view.hole;
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  const pct = handPercentile(a, b);
  const suited = suitOf(a) === suitOf(b);
  const suitedAce = suited && hi === 12 && lo <= 3;
  const suitedConnector = suited && hi - lo <= 2 && lo >= 3 && hi <= 10;
  const read = sit.main?.read ?? PRIOR_READ;
  if (sit.raisesThisStreet === 1) {
    const width = clamp(Math.sqrt(read.pfr / PRIOR_READ.pfr), 0.7, 1.6);
    const value = (0.016 + 0.046 * style.aggression) * width;
    if (pct <= value) return true;
    const foldFactor = clamp(read.foldTo3Bet / PRIOR_READ.foldTo3Bet, 0.5, 1.6);
    const bluffable = suitedAce || suitedConnector;
    const chance = style.bluff * 0.24 * foldFactor * (bluffable ? 1 : (1 - style.skill) * 0.3);
    return rng.next() < chance;
  }
  const value = 0.008 + 0.018 * style.aggression;
  if (pct <= value) return true;
  return suitedAce && rng.next() < style.bluff * 0.06;
}

/** Bet or raise sizes worth considering here, as total street bets. */
function candidateSizes(sit: Situation, allowRaises = true): number[] {
  const { legal, view, style, texture, fast, spr } = sit;
  if (!legal.canBet && !legal.canRaise) return [];
  if (!allowRaises) return [];
  const sizes = new Set<number>();
  if (legal.shortAllInOnly) return [legal.maxTo];

  if (view.street === 'preflop') {
    const ip = sit.inPosition;
    if (sit.raisesThisStreet === 1) sizes.add(clampTo(legal, view.currentBet * (ip ? 3 : 3.8)));
    else if (sit.raisesThisStreet >= 2) sizes.add(clampTo(legal, view.currentBet * 2.3));
    else sizes.add(clampTo(legal, view.bigBlind * 3));
    if (spr < 3 || sit.effectiveStack < view.bigBlind * 30) sizes.add(legal.maxTo);
    return [...sizes];
  }

  let fractions: number[];
  if (sit.raisesThisStreet >= 1 || view.currentBet > 0) {
    fractions = fast ? [0.8] : [0.65, 1.0];
  } else if (texture.wetness >= 0.5) {
    fractions = fast ? [0.75] : [0.55, 0.8, 1.05];
  } else {
    fractions = fast ? [0.5] : [0.33, 0.55, 0.8];
  }
  // Skilled, aggressive players sometimes polarise with overbets.
  if (!fast && style.skill > 0.6 && style.aggression > 0.5) fractions.push(1.5);
  for (const f of fractions) {
    const to = potFractionTo(legal, f);
    if (to !== null) sizes.add(to);
  }
  if (spr < 1.6 || legal.maxTo <= (legal.pot + legal.callAmount) * 1.3 + legal.currentBet) sizes.add(legal.maxTo);
  return [...sizes];
}

interface Candidate {
  action: PlayerAction;
  label: string;
  ev: number;
  utility: number;
}

function buildCandidates(sit: Situation, perceivedEquity: number, implied: number, allowRaises: boolean): Candidate[] {
  const { legal, style, view, features } = sit;
  const pot = view.pot;
  const potRef = Math.max(pot, view.bigBlind * 2);
  const R = realization(sit);
  const out: Candidate[] = [];
  const eq = perceivedEquity;
  const stackBefore = Math.max(1, sit.me.startStack);
  const riskScale = (0.5 - style.risk) * 0.9;

  /** Chips at risk feel worse to cautious players and under tournament pressure. */
  const riskCost = (added: number): number =>
    (riskScale * (added / stackBefore) + sit.premium) * (1 - eq) * added;

  if (legal.canCheck) {
    const ev = eq * pot * R;
    let utility = ev;
    if (eq > 0.72) utility += (style.deception - 0.4) * 0.3 * potRef * (sit.view.street === 'river' ? 0.4 : 1);
    out.push({ action: { type: 'check' }, label: 'check', ev, utility });
  }

  if (legal.canCall) {
    const call = legal.callAmount;
    const ev = eq * (pot + call) * R - call + implied;
    let utility = ev + (style.calling - 0.3) * 0.3 * potRef - riskCost(call);
    if (eq > 0.72) utility += (style.deception - 0.4) * 0.2 * potRef;
    out.push({ action: { type: 'call' }, label: legal.callIsAllIn ? 'call all-in' : `call ${call}`, ev, utility });
  }

  if (legal.canCall) {
    out.push({ action: { type: 'fold' }, label: 'fold', ev: 0, utility: (0.35 - style.calling) * 0.06 * potRef });
  }

  const hasEquityWhenCalled = features.flushDraw || features.openEnded || features.gutshot;
  const hasBlocker = features.flushBlocker || (view.street === 'preflop' && Math.max(rankOf(view.hole[0]), rankOf(view.hole[1])) === 12);
  for (const to of candidateSizes(sit, allowRaises)) {
    const action = aggressiveAction(legal, to);
    if (!action) continue;
    const raisePart = Math.max(0, to - legal.currentBet);
    const ratio = raisePart / Math.max(1, pot + legal.callAmount);

    let everyoneFolds = 1;
    for (const v of sit.villains) everyoneFolds *= foldChance(sit, v, ratio);
    if (view.street === 'preflop') everyoneFolds *= Math.pow(0.86, sit.playersBehind);
    else everyoneFolds *= Math.pow(0.8, Math.max(0, sit.playersBehind - sit.villains.length));

    // If called, we are up against the stronger part of the main opponent's range.
    const mainFold = sit.main ? foldChance(sit, sit.main, ratio) : 0;
    const eqCalled = equityVsContinuing(sit, 1 - mainFold) + (eq - sit.equity);

    // Chips above what the opponent can match come straight back.
    const villainMax = sit.main ? sit.main.player.stack + sit.main.player.streetBet : to;
    const effectiveTo = Math.min(to, villainMax);
    const effectiveAdded = Math.max(0, effectiveTo - legal.streetBet);
    const villainCall = sit.main ? Math.max(0, effectiveTo - sit.main.player.streetBet) : raisePart;
    const finalPot = pot + effectiveAdded + villainCall;
    const allInLike = to >= legal.maxTo;
    const showdownValue = clamp(eqCalled, 0, 1) * finalPot * (allInLike ? 1 : R) - effectiveAdded;
    // Non-premium hands usually give up when re-raised, losing what they just put in.
    const reRaiseRisk = allInLike || eq >= 0.62 ? 0 : view.street === 'preflop' ? 0.28 : view.street === 'river' ? 0.08 : 0.13;
    const whenContinued = (1 - reRaiseRisk) * showdownValue + reRaiseRisk * -effectiveAdded;
    const ev = everyoneFolds * pot + (1 - everyoneFolds) * whenContinued;

    let utility = ev + (style.aggression - 0.5) * 0.3 * potRef - riskCost(effectiveAdded);

    if (eq < 0.42) {
      // Bluff selection: better players bluff with draws and blockers rather than at random.
      const quality = hasEquityWhenCalled ? 1.1 : hasBlocker ? 0.9 : lerp(0.75, 0.25, style.skill);
      utility += (style.bluff - 0.3) * 0.45 * potRef * quality;
    } else if (eq > 0.68) {
      utility -= (style.deception - 0.5) * 0.12 * potRef;
    }

    const verb = action.type === 'bet' ? 'bet' : 'raise to';
    out.push({ action, label: `${verb} ${to}`, ev, utility });
  }
  return out;
}

/** Softmax choice: good players nearly always take the best option, weak ones wander. */
function chooseCandidate(sit: Situation, candidates: Candidate[]): { pick: Candidate; complexity: number } {
  const potRef = Math.max(sit.view.pot, sit.view.bigBlind * 2);
  const temperature = potRef * (0.012 + (1 - sit.style.skill) ** 1.5 * 0.17) + 0.01;
  const best = Math.max(...candidates.map((c) => c.utility));
  const weights = candidates.map((c) => Math.exp((c.utility - best) / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = sit.rng.next() * total;
  let pick = candidates[candidates.length - 1];
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      pick = candidates[i];
      break;
    }
  }
  const sorted = [...candidates].sort((a, b) => b.utility - a.utility);
  const gap = sorted.length > 1 ? sorted[0].utility - sorted[1].utility : potRef;
  return { pick, complexity: clamp(1 - gap / (potRef * 0.35), 0, 1) };
}

/** Modelled human errors, separate from the EV estimate so they are identifiable and testable. */
function maybeMistake(sit: Situation): { equityShift: number; impliedExtra: number; name?: string } {
  const { style, features, texture, rng, legal, view } = sit;
  const rec = sit.input.profile.recreational ? 1 : 0.45;
  const rate = (1 - style.skill) ** 1.6 * rec * 0.75;
  if (rng.next() >= rate || view.street === 'preflop') return { equityShift: 0, impliedExtra: 0 };
  const madePair = features.category >= 1;
  const options: Array<{ name: string; equityShift: number; impliedExtra: number }> = [];
  if (madePair) options.push({ name: 'overvalued a pair', equityShift: 0.16, impliedExtra: 0 });
  if (features.outs >= 4 && legal.canCall) options.push({ name: 'chased a draw ignoring the price', equityShift: 0.04, impliedExtra: view.pot * 0.7 });
  if (!madePair && features.outs < 4 && legal.canCall) options.push({ name: 'gave up after missing the flop', equityShift: -0.14, impliedExtra: 0 });
  if (texture.flushPossible && madePair) options.push({ name: 'got scared of the board', equityShift: -0.14, impliedExtra: 0 });
  if (view.street === 'river' && legal.canCall) options.push({ name: 'made a curiosity call', equityShift: 0.15, impliedExtra: 0 });
  if (options.length === 0) return { equityShift: 0, impliedExtra: 0 };
  return options[rng.int(options.length)];
}

function evDecision(sit: Situation, allowRaises = true): Decision {
  const mistake = maybeMistake(sit);
  const eq = clamp(sit.equity + mistake.equityShift, 0, 1);
  const implied = impliedOdds(sit) + mistake.impliedExtra;
  const candidates = buildCandidates(sit, eq, implied, allowRaises);
  const { pick, complexity } = chooseCandidate(sit, candidates);
  return {
    action: pick.action,
    basis: mistake.name ? 'mistake' : 'ev',
    mistake: mistake.name,
    equity: sit.equity,
    potOdds: sit.legal.callAmount > 0 ? sit.legal.callAmount / (sit.legal.pot + sit.legal.callAmount) : 0,
    complexity,
    strength: sit.equity,
    candidates: candidates.map((c) => ({ label: c.label, ev: c.ev, utility: c.utility })),
  };
}

/** Rough open-raising share by the number of players yet to act. */
const OPEN_BY_BEHIND = [0.9, 0.42, 0.46, 0.29, 0.22, 0.18, 0.15, 0.13, 0.115];

/** Rough shoving share at 10 big blinds by the number of players yet to act. */
const PUSH_BY_BEHIND = [0.9, 0.58, 0.42, 0.3, 0.22, 0.17, 0.13, 0.11, 0.1];

function firstInDecision(sit: Situation): Decision {
  const { view, style, legal, rng, me } = sit;
  const bb = view.bigBlind;
  const pct = handPercentile(view.hole[0], view.hole[1]);
  const behind = Math.min(sit.playersBehind, 8);
  const limpers = view.actions.filter((a) => a.street === 'preflop' && a.action === 'call').length;
  const effBB = sit.effectiveStack / bb;
  const soft = 0.012 + (1 - style.skill) * 0.05;
  const inRange = (limit: number) => rng.next() < clamp((limit - pct) / soft + 0.5, 0, 1);
  const trace = (action: PlayerAction, basis: DecisionBasis, complexity: number): Decision => ({
    action,
    basis,
    equity: null,
    potOdds: legal.callAmount > 0 ? legal.callAmount / (legal.pot + legal.callAmount) : 0,
    complexity,
    strength: 1 - pct,
    candidates: [],
  });
  const closeness = (limit: number) => clamp(1 - Math.abs(limit - pct) / 0.12, 0, 1);

  const blindRead = (() => {
    const blinds = view.players.filter((p) => (p.position === 'SB' || p.position === 'BB') && p.seat !== view.seat && !p.folded);
    if (blinds.length === 0) return PRIOR_READ.blindFold;
    return blinds.reduce((sum, p) => sum + readFor(sit.input, style, p.id).blindFold, 0) / blinds.length;
  })();

  // Short stacks play push or fold. Specialists and skilled players do this best.
  if (effBB <= 13 && limpers === 0 && legal.canRaise) {
    const depth = Math.pow(10 / Math.max(effBB, 2), 0.85);
    let shove = PUSH_BY_BEHIND[behind] * depth * lerp(0.75, 1.2, style.aggression) * (1 - sit.premium * 0.9);
    if (me.position === 'BB' && legal.canCheck) shove *= 0.5;
    shove = clamp(shove * (1 + (blindRead - PRIOR_READ.blindFold) * 0.8), 0.02, 0.95);
    if (inRange(shove)) return trace({ type: 'allin' }, 'push_fold', closeness(shove));
    if (legal.canCheck) return trace({ type: 'check' }, 'push_fold', 0.1);
    return trace({ type: 'fold' }, 'push_fold', closeness(shove));
  }

  const headsUp = view.players.length === 2;
  const threeHanded = view.players.length === 3;
  const base = headsUp ? 0.82 : threeHanded ? 0.55 : OPEN_BY_BEHIND[behind];
  let open = lerp(0.24, base, style.position);
  open *= lerp(2.1, 0.62, style.patience);
  open *= 1 + (style.aggression - 0.5) * 0.45;
  if (behind <= 2) open *= 1 + (blindRead - PRIOR_READ.blindFold) * 1.2 * style.adaptability;
  open *= 1 - sit.premium * 0.7;
  open = clamp(open, 0.03, 0.97);

  // Big blind option after limps or a walk-through.
  if (legal.canCheck) {
    const raiseShare = clamp(0.05 + 0.14 * style.aggression, 0.03, 0.25);
    if (legal.canRaise && inRange(raiseShare) && rng.next() < lerp(0.45, 1, style.aggression)) {
      const to = clampTo(legal, bb * (3 + limpers));
      return trace(aggressiveAction(legal, to)!, 'range', closeness(raiseShare));
    }
    return trace({ type: 'check' }, 'range', 0.05);
  }

  const raiseLimit = limpers > 0 ? open * 0.72 : open;
  const passiveLimp = lerp(0.7, 0.03, style.aggression) * lerp(1, 0.25, style.skill);
  const callLimit = limpers > 0 ? open * 1.25 : open;
  const cheapBlind = me.position === 'SB' && legal.callAmount <= bb * 0.5;

  if (legal.canRaise && inRange(raiseLimit) && rng.next() >= passiveLimp) {
    let openSize: number;
    if (sit.input.profile.recreational && style.skill < 0.5) {
      // Recreational sizing is erratic and loosely tied to hand strength.
      openSize = bb * (pct < 0.05 ? 4 + rng.int(3) : 2 + rng.int(3));
    } else {
      const positional = behind >= 4 ? 2.6 : behind >= 2 ? 2.4 : 2.2;
      openSize = bb * (positional + (me.position === 'SB' ? 0.8 : 0) + (effBB > 150 ? 0.4 : 0));
    }
    openSize += limpers * bb;
    const to = clampTo(legal, Math.round(openSize));
    return trace(aggressiveAction(legal, to)!, 'range', closeness(raiseLimit));
  }

  if (legal.canCall && (inRange(callLimit) || (cheapBlind && inRange(open * 1.6)))) {
    return trace({ type: 'call' }, 'range', closeness(callLimit));
  }
  return trace({ type: 'fold' }, 'range', closeness(open));
}

function preflopDecision(sit: Situation): Decision {
  const facingRaise = sit.view.actions.some((a) => a.street === 'preflop' && a.action === 'raise');
  if (!facingRaise) return firstInDecision(sit);
  const { legal, view, style, rng } = sit;
  const canReraise = legal.canRaise && !legal.shortAllInOnly;
  if (canReraise && allowPreflopReraise(sit)) {
    const pct = handPercentile(view.hole[0], view.hole[1]);
    // Deceptive players sometimes flat their very best hands to trap.
    const traps = pct < 0.025 && rng.next() < (style.deception - 0.3) * 0.35;
    if (!traps) {
      const sizes = candidateSizes(sit, true);
      const deep = sit.effectiveStack >= view.bigBlind * 25;
      const to = deep ? sizes[0] : legal.maxTo;
      const action = aggressiveAction(legal, to);
      if (action) {
        return {
          action,
          basis: 'range',
          equity: sit.equity,
          potOdds: legal.callAmount / (legal.pot + legal.callAmount),
          complexity: clamp(1 - Math.abs(0.05 - pct) / 0.1, 0.2, 1),
          strength: sit.equity,
          candidates: [],
        };
      }
    }
  }
  return evDecision(sit, false);
}

/**
 * The structured decision: perceive the situation, estimate opponents' ranges and
 * our equity, estimate EV for each legal action, then choose with the bot's style.
 * The result is always legal because candidates come from `legalActions`.
 */
export function decide(input: DecisionInput): Decision {
  const style = effectiveStyle(input.profile, input.mood);
  const sit = buildSituation(input, style);
  const decision = input.view.street === 'preflop' ? preflopDecision(sit) : evDecision(sit);
  return { ...decision, action: enforceLegal(decision.action, input.view.legal) };
}

/** A last line of defence: anything not legal here degrades to the safest legal action. */
export function enforceLegal(action: PlayerAction, legal: LegalActions): PlayerAction {
  switch (action.type) {
    case 'fold':
      return legal.canCheck ? { type: 'check' } : action;
    case 'check':
      return legal.canCheck ? action : { type: 'fold' };
    case 'call':
      return legal.canCall ? action : { type: 'check' };
    case 'allin':
      if (legal.canAllIn) return action;
      return legal.canCall ? { type: 'call' } : { type: 'check' };
    case 'bet':
    case 'raise': {
      if (legal.canBet) return { type: 'bet', to: clampTo(legal, action.to) };
      if (legal.canRaise) return { type: 'raise', to: clampTo(legal, action.to) };
      return legal.canCall ? { type: 'call' } : { type: 'check' };
    }
  }
}

export { multipleTo };

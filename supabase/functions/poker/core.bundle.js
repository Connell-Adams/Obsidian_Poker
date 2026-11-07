// src/engine/cards.ts
var rankOf = (card) => card >> 2;
var suitOf = (card) => card & 3;
function fullDeck() {
	const out = [];
	for (let c = 0; c < 52; c++) out.push(c);
	return out;
}
// src/engine/deck.ts
/**
* One physical deck. Each hand owns its own instance, cards leave the deck
* exactly once, and burn cards are consumed without ever being exposed.
*/
var Deck = class Deck {
	cards;
	position = 0;
	burnCount = 0;
	constructor(cards) {
		this.cards = cards;
	}
	/** A fresh Fisher-Yates shuffled 52-card deck. */
	static shuffled(rng) {
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
	static stacked(top, rng) {
		const seen = new Set(top);
		if (seen.size !== top.length) throw new Error("Stacked deck contains duplicates");
		const rest = fullDeck().filter((c) => !seen.has(c));
		for (let i = rest.length - 1; i > 0; i--) {
			const j = rng.int(i + 1);
			[rest[i], rest[j]] = [rest[j], rest[i]];
		}
		return new Deck([...top, ...rest]);
	}
	get remaining() {
		return this.cards.length - this.position;
	}
	get burned() {
		return this.burnCount;
	}
	draw() {
		if (this.position >= this.cards.length) throw new Error("Deck exhausted");
		return this.cards[this.position++];
	}
	/** Discards the top card face down. Its identity is deliberately not returned. */
	burn() {
		if (this.position >= this.cards.length) throw new Error("Deck exhausted");
		this.position++;
		this.burnCount++;
	}
};
// src/engine/evaluator.ts
/**
* Hand evaluator. `scoreHand` is allocation-free and handles 5..7 cards (it is
* called millions of times by the equity simulator). Scores are directly
* comparable: a higher integer always means a stronger hand, equal integers
* always mean a tie.
*
* Layout: category << 20 | five 4-bit rank nibbles (most significant first).
*/
var Category = {
	HighCard: 0,
	OnePair: 1,
	TwoPair: 2,
	ThreeOfAKind: 3,
	Straight: 4,
	Flush: 5,
	FullHouse: 6,
	FourOfAKind: 7,
	StraightFlush: 8,
	RoyalFlush: 9
};
var CATEGORY_NAMES = [
	"High Card",
	"One Pair",
	"Two Pair",
	"Three of a Kind",
	"Straight",
	"Flush",
	"Full House",
	"Four of a Kind",
	"Straight Flush",
	"Royal Flush"
];
var WHEEL_MASK = 4111;
/** STRAIGHT_HIGH[rankMask] = rank of the straight's top card, or -1. The five-high wheel returns 3. */
var STRAIGHT_HIGH = /* @__PURE__ */ new Int8Array(8192);
var POPCOUNT = /* @__PURE__ */ new Uint8Array(8192);
for (let mask = 0; mask < 8192; mask++) {
	POPCOUNT[mask] = (mask & 1) + POPCOUNT[mask >> 1];
	let high = -1;
	for (let top = 12; top >= 4; top--) {
		const run = 31 << top - 4;
		if ((mask & run) === run) {
			high = top;
			break;
		}
	}
	if (high < 0 && (mask & WHEEL_MASK) === WHEEL_MASK) high = 3;
	STRAIGHT_HIGH[mask] = high;
}
var highBit = (mask) => 31 - Math.clz32(mask);
/** Packs the `count` highest ranks in `mask` into nibbles starting at `shift` going down. */
function packTop(mask, count, shift) {
	let out = 0;
	let m = mask;
	let s = shift;
	for (let i = 0; i < count && m !== 0; i++) {
		const r = highBit(m);
		out |= r << s;
		m &= ~(1 << r);
		s -= 4;
	}
	return out;
}
function scoreHand(cards, length = cards.length) {
	let s0 = 0;
	let s1 = 0;
	let s2 = 0;
	let s3 = 0;
	let one = 0;
	let two = 0;
	let three = 0;
	let four = 0;
	for (let i = 0; i < length; i++) {
		const card = cards[i];
		const bit = 1 << (card >> 2);
		switch (card & 3) {
			case 0:
				s0 |= bit;
				break;
			case 1:
				s1 |= bit;
				break;
			case 2:
				s2 |= bit;
				break;
			default: s3 |= bit;
		}
		four |= three & bit;
		three |= two & bit;
		two |= one & bit;
		one |= bit;
	}
	let flushMask = 0;
	if (POPCOUNT[s0] >= 5) flushMask = s0;
	else if (POPCOUNT[s1] >= 5) flushMask = s1;
	else if (POPCOUNT[s2] >= 5) flushMask = s2;
	else if (POPCOUNT[s3] >= 5) flushMask = s3;
	if (flushMask !== 0) {
		const sf = STRAIGHT_HIGH[flushMask];
		if (sf >= 0) return (sf === 12 ? Category.RoyalFlush : Category.StraightFlush) << 20 | sf << 16;
	}
	if (four !== 0) {
		const q = highBit(four);
		return Category.FourOfAKind << 20 | q << 16 | highBit(one & ~(1 << q)) << 12;
	}
	if (three !== 0) {
		const t = highBit(three);
		const rest = two & ~(1 << t);
		if (rest !== 0) return Category.FullHouse << 20 | t << 16 | highBit(rest) << 12;
	}
	if (flushMask !== 0) return Category.Flush << 20 | packTop(flushMask, 5, 16);
	const straight = STRAIGHT_HIGH[one];
	if (straight >= 0) return Category.Straight << 20 | straight << 16;
	if (three !== 0) {
		const t = highBit(three);
		return Category.ThreeOfAKind << 20 | t << 16 | packTop(one & ~(1 << t), 2, 12);
	}
	if (two !== 0) {
		const p1 = highBit(two);
		const rest = two & ~(1 << p1);
		if (rest !== 0) {
			const p2 = highBit(rest);
			return Category.TwoPair << 20 | p1 << 16 | p2 << 12 | packTop(one & ~(1 << p1) & ~(1 << p2), 1, 8);
		}
		return Category.OnePair << 20 | p1 << 16 | packTop(one & ~(1 << p1), 3, 12);
	}
	return Category.HighCard << 20 | packTop(one, 5, 16);
}
var categoryOf = (score) => score >> 20;
var RANK_SINGULAR = [
	"Two",
	"Three",
	"Four",
	"Five",
	"Six",
	"Seven",
	"Eight",
	"Nine",
	"Ten",
	"Jack",
	"Queen",
	"King",
	"Ace"
];
var RANK_PLURAL = [
	"Twos",
	"Threes",
	"Fours",
	"Fives",
	"Sixes",
	"Sevens",
	"Eights",
	"Nines",
	"Tens",
	"Jacks",
	"Queens",
	"Kings",
	"Aces"
];
function describe(score) {
	const nib = (i) => score >> 16 - i * 4 & 15;
	switch (categoryOf(score)) {
		case Category.RoyalFlush: return "Royal Flush";
		case Category.StraightFlush: return `Straight Flush, ${RANK_SINGULAR[nib(0)]} high`;
		case Category.FourOfAKind: return `Four of a Kind, ${RANK_PLURAL[nib(0)]}`;
		case Category.FullHouse: return `Full House, ${RANK_PLURAL[nib(0)]} over ${RANK_PLURAL[nib(1)]}`;
		case Category.Flush: return `Flush, ${RANK_SINGULAR[nib(0)]} high`;
		case Category.Straight: return `Straight, ${RANK_SINGULAR[nib(0)]} high`;
		case Category.ThreeOfAKind: return `Three of a Kind, ${RANK_PLURAL[nib(0)]}`;
		case Category.TwoPair: return `Two Pair, ${RANK_PLURAL[nib(0)]} and ${RANK_PLURAL[nib(1)]}`;
		case Category.OnePair: return `Pair of ${RANK_PLURAL[nib(0)]}`;
		default: return `${RANK_SINGULAR[nib(0)]} High`;
	}
}
/** Orders five cards the way a dealer would read them: groups first, wheel with the ace last. */
function displayOrder(five, score) {
	const counts = /* @__PURE__ */ new Map();
	for (const c of five) counts.set(rankOf(c), (counts.get(rankOf(c)) ?? 0) + 1);
	const cat = categoryOf(score);
	const isWheel = (cat === Category.Straight || cat === Category.StraightFlush) && (score >> 16 & 15) === 3;
	const value = (c) => isWheel && rankOf(c) === 12 ? -1 : rankOf(c);
	return [...five].sort((a, b) => counts.get(rankOf(b)) - counts.get(rankOf(a)) || value(b) - value(a) || suitOf(b) - suitOf(a));
}
/** Full evaluation including the exact winning five cards. Rejects duplicate cards. */
function evaluateHand(cards) {
	if (cards.length < 5 || cards.length > 7) throw new Error(`Hand evaluation needs 5-7 cards, got ${cards.length}`);
	if (new Set(cards).size !== cards.length) throw new Error("Hand contains duplicate cards");
	for (const c of cards) if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error(`Invalid card ${c}`);
	const score = scoreHand(cards);
	const n = cards.length;
	let bestFive = null;
	outer: for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
		const five = [
			cards[a],
			cards[b],
			cards[c],
			cards[d],
			cards[e]
		];
		if (scoreHand(five) === score) {
			bestFive = five;
			break outer;
		}
	}
	if (!bestFive) throw new Error("Evaluator invariant violated: no five-card subset reaches the score");
	const category = categoryOf(score);
	return {
		score,
		category,
		categoryName: CATEGORY_NAMES[category],
		description: describe(score),
		bestFive: displayOrder(bestFive, score)
	};
}
// src/engine/pots.ts
/**
* Splits total contributions into a main pot and side pots.
*
* Each distinct contribution level of a live player closes a layer. A layer
* takes min(contribution, level) - min(contribution, previousLevel) from every
* player, including folded ones, whose chips stay in as dead money.
*/
function computePots(contributions) {
	const live = contributions.filter((c) => !c.folded && c.amount > 0);
	const levels = [...new Set(live.map((c) => c.amount))].sort((a, b) => a - b);
	const pots = [];
	let previous = 0;
	for (const level of levels) {
		let amount = 0;
		for (const c of contributions) amount += Math.min(c.amount, level) - Math.min(c.amount, previous);
		const eligible = live.filter((c) => c.amount >= level).map((c) => c.seat);
		const last = pots[pots.length - 1];
		if (last && sameSeats(last.eligible, eligible)) last.amount += amount;
		else if (amount > 0) pots.push({
			amount,
			eligible
		});
		previous = level;
	}
	let dead = 0;
	for (const c of contributions) dead += Math.max(0, c.amount - previous);
	if (dead > 0) {
		if (pots.length === 0) throw new Error("Chips in the pot but nobody eligible to win them");
		pots[pots.length - 1].amount += dead;
	}
	return pots;
}
function sameSeats(a, b) {
	return a.length === b.length && a.every((seat) => b.includes(seat));
}
/**
* Splits one pot between winners. Odd chips go one at a time to the winners
* closest to the left of the button; `seatOrder` lists seats clockwise starting
* with the first seat left of the button.
*/
function splitPot(amount, winners, seatOrder) {
	if (winners.length === 0) throw new Error("A pot needs at least one winner");
	const ordered = seatOrder.filter((seat) => winners.includes(seat));
	if (ordered.length !== winners.length) throw new Error("Winner missing from the seat order");
	const share = Math.floor(amount / ordered.length);
	const oddChips = amount - share * ordered.length;
	return ordered.map((seat, i) => ({
		seat,
		amount: share + (i < oddChips ? 1 : 0)
	}));
}
// src/engine/hand.ts
var POSITION_TABLES = {
	2: ["BB", "BTN"],
	3: [
		"SB",
		"BB",
		"BTN"
	],
	4: [
		"SB",
		"BB",
		"UTG",
		"BTN"
	],
	5: [
		"SB",
		"BB",
		"UTG",
		"CO",
		"BTN"
	],
	6: [
		"SB",
		"BB",
		"UTG",
		"MP",
		"CO",
		"BTN"
	],
	7: [
		"SB",
		"BB",
		"UTG",
		"UTG+1",
		"MP",
		"CO",
		"BTN"
	],
	8: [
		"SB",
		"BB",
		"UTG",
		"UTG+1",
		"MP",
		"HJ",
		"CO",
		"BTN"
	],
	9: [
		"SB",
		"BB",
		"UTG",
		"UTG+1",
		"UTG+2",
		"MP",
		"HJ",
		"CO",
		"BTN"
	]
};
/** Position names in deal order: index 0 sits directly left of the button. */
function positionLabels(playerCount) {
	const labels = POSITION_TABLES[playerCount];
	if (!labels) throw new Error(`Unsupported player count: ${playerCount}`);
	return labels;
}
/**
* The state machine for one hand of no-limit hold'em. It owns the deck, posts
* blinds, deals, validates every action and pays out. It has no knowledge of
* timers, rendering or bots, and it never mutates state on an illegal action.
*/
var Hand = class {
	handNumber;
	buttonSeat;
	smallBlind;
	bigBlind;
	ante;
	/** Deal order: index 0 is directly left of the button, the last index is the button. */
	players;
	sbSeat;
	bbSeat;
	events = [];
	board = [];
	street = "preflop";
	/** Chips already collected from previous betting rounds. */
	pot = 0;
	currentBet = 0;
	lastRaiseSize;
	/** Seat of the last player to bet or raise on the current street. */
	lastAggressorSeat = null;
	/** Seat of the last aggressor on the preceding streets, used for showdown order. */
	showdownLeadSeat = null;
	result = null;
	actorIndex = null;
	deck;
	startTotal;
	revealedRunout = false;
	constructor(config) {
		const { players, buttonSeat, smallBlind, bigBlind, deck } = config;
		const ante = config.ante ?? 0;
		if (players.length < 2) throw new Error("A hand needs at least two players");
		if (players.length > 9) throw new Error("A hand supports at most nine players");
		if (!Number.isInteger(smallBlind) || !Number.isInteger(bigBlind) || smallBlind <= 0 || bigBlind < smallBlind) throw new Error("Invalid blinds");
		if (!Number.isInteger(ante) || ante < 0) throw new Error("Invalid ante");
		const seats = new Set(players.map((p) => p.seat));
		if (seats.size !== players.length) throw new Error("Duplicate seat");
		for (const p of players) if (!Number.isInteger(p.stack) || p.stack <= 0) throw new Error(`Invalid stack for seat ${p.seat}: ${p.stack}`);
		if (!seats.has(buttonSeat)) throw new Error("The button must sit on a dealt-in player");
		this.handNumber = config.handNumber;
		this.buttonSeat = buttonSeat;
		this.smallBlind = smallBlind;
		this.bigBlind = bigBlind;
		this.ante = ante;
		this.deck = deck;
		this.lastRaiseSize = bigBlind;
		const sorted = [...players].sort((a, b) => a.seat - b.seat);
		const buttonIndex = sorted.findIndex((p) => p.seat === buttonSeat);
		const inDealOrder = [];
		for (let i = 1; i <= sorted.length; i++) inDealOrder.push(sorted[(buttonIndex + i) % sorted.length]);
		const labels = positionLabels(inDealOrder.length);
		this.players = inDealOrder.map((p, i) => ({
			seat: p.seat,
			id: p.id,
			name: p.name,
			position: labels[i],
			startStack: p.stack,
			stack: p.stack,
			hole: [-1, -1],
			streetBet: 0,
			contributed: 0,
			folded: false,
			allIn: false,
			hasActed: false,
			matchedLevel: 0
		}));
		this.startTotal = this.players.reduce((sum, p) => sum + p.stack, 0);
		const headsUp = this.players.length === 2;
		const sbIndex = headsUp ? 1 : 0;
		const bbIndex = headsUp ? 0 : 1;
		this.sbSeat = this.players[sbIndex].seat;
		this.bbSeat = this.players[bbIndex].seat;
		this.events.push({
			t: "hand_start",
			handNumber: this.handNumber,
			buttonSeat,
			sbSeat: this.sbSeat,
			bbSeat: this.bbSeat,
			smallBlind,
			bigBlind,
			ante
		});
		if (ante > 0) for (const p of this.players) {
			const paid = Math.min(ante, p.stack);
			p.stack -= paid;
			p.contributed += paid;
			this.pot += paid;
			p.allIn = p.stack === 0;
			this.events.push({
				t: "post",
				seat: p.seat,
				kind: "ante",
				amount: paid,
				allIn: p.allIn
			});
		}
		this.postBlind(this.players[sbIndex], smallBlind, "sb");
		this.postBlind(this.players[bbIndex], bigBlind, "bb");
		this.currentBet = bigBlind;
		for (const round of [0, 1]) for (const p of this.players) {
			p.hole[round] = deck.draw();
			this.events.push({
				t: "deal_hole",
				seat: p.seat,
				cardIndex: round
			});
		}
		const firstIndex = headsUp ? sbIndex : (bbIndex + 1) % this.players.length;
		this.actorIndex = null;
		const next = this.needsAction(this.players[firstIndex]) ? firstIndex : this.findNextActor(firstIndex);
		if (next !== null) this.actorIndex = next;
		else this.endBettingRound();
	}
	postBlind(p, amount, kind) {
		const paid = Math.min(amount, p.stack);
		p.stack -= paid;
		p.streetBet = paid;
		p.contributed += paid;
		p.allIn = p.stack === 0;
		this.events.push({
			t: "post",
			seat: p.seat,
			kind,
			amount: paid,
			allIn: p.allIn
		});
	}
	get isComplete() {
		return this.result !== null;
	}
	/** The seat that must act now, or null when the hand has finished. */
	get actorSeat() {
		return this.actorIndex === null ? null : this.players[this.actorIndex].seat;
	}
	playerAt(seat) {
		return this.players.find((p) => p.seat === seat);
	}
	/** Collected pot plus all bets currently in front of the players. */
	get totalPot() {
		return this.pot + this.players.reduce((sum, p) => sum + p.streetBet, 0);
	}
	/** Clockwise seats starting directly left of the button. */
	get seatOrder() {
		return this.players.map((p) => p.seat);
	}
	otherCanAct(p) {
		return this.players.some((o) => o !== p && !o.folded && !o.allIn);
	}
	/** What `p` must reach to stay in. Never more than what an opponent can actually match. */
	callTarget(p) {
		if (this.otherCanAct(p)) return this.currentBet;
		let highest = 0;
		for (const o of this.players) if (o !== p && !o.folded) highest = Math.max(highest, o.streetBet);
		return Math.min(this.currentBet, highest);
	}
	needsAction(p) {
		if (p.folded || p.allIn) return false;
		if (!this.otherCanAct(p)) return p.streetBet < this.callTarget(p);
		return !p.hasActed || p.streetBet < this.currentBet;
	}
	findNextActor(fromIndex) {
		const n = this.players.length;
		for (let i = 1; i <= n; i++) {
			const index = (fromIndex + i) % n;
			if (this.needsAction(this.players[index])) return index;
		}
		return null;
	}
	/** The full set of legal options for the player to act. Null for anyone else. */
	legalActions(seat) {
		if (this.actorSeat !== seat) return null;
		const p = this.players[this.actorIndex];
		const target = this.callTarget(p);
		const toCall = Math.max(0, target - p.streetBet);
		const callAmount = Math.min(toCall, p.stack);
		const maxTo = p.streetBet + p.stack;
		const canAggress = (!p.hasActed || this.currentBet - p.matchedLevel >= this.lastRaiseSize) && this.otherCanAct(p) && maxTo > this.currentBet;
		const normalMin = this.currentBet + this.lastRaiseSize;
		const opening = this.currentBet === 0;
		return {
			seat,
			canFold: true,
			canCheck: toCall === 0,
			canCall: toCall > 0,
			callAmount,
			callIsAllIn: toCall > 0 && callAmount === p.stack,
			canBet: canAggress && opening,
			canRaise: canAggress && !opening,
			minTo: canAggress ? Math.min(normalMin, maxTo) : 0,
			maxTo: canAggress ? maxTo : 0,
			shortAllInOnly: canAggress && maxTo < normalMin,
			canAllIn: canAggress || toCall > 0 && callAmount === p.stack,
			pot: this.totalPot,
			currentBet: this.currentBet,
			streetBet: p.streetBet,
			stack: p.stack,
			bigBlind: this.bigBlind,
			lastRaiseSize: this.lastRaiseSize
		};
	}
	/** Applies an action for `seat`. Illegal actions are rejected without changing any state. */
	act(seat, action) {
		if (this.isComplete) return {
			ok: false,
			error: "The hand is over"
		};
		const legal = this.legalActions(seat);
		if (!legal) return {
			ok: false,
			error: `Seat ${seat} is not the player to act`
		};
		const p = this.players[this.actorIndex];
		const potBefore = this.totalPot;
		const facing = legal.callAmount;
		let resolved = action;
		if (resolved.type === "allin") {
			if (!legal.canAllIn) return {
				ok: false,
				error: "Moving all-in is not legal: the betting was not reopened"
			};
			if (legal.canBet) resolved = {
				type: "bet",
				to: legal.maxTo
			};
			else if (legal.canRaise) resolved = {
				type: "raise",
				to: legal.maxTo
			};
			else resolved = { type: "call" };
		}
		switch (resolved.type) {
			case "fold":
				p.folded = true;
				this.record(p, "fold", 0, facing, potBefore);
				break;
			case "check":
				if (!legal.canCheck) return {
					ok: false,
					error: "Cannot check when facing a bet"
				};
				this.record(p, "check", 0, facing, potBefore);
				break;
			case "call":
				if (!legal.canCall) return {
					ok: false,
					error: "Nothing to call"
				};
				this.commit(p, legal.callAmount);
				this.record(p, "call", legal.callAmount, facing, potBefore);
				break;
			case "bet":
			case "raise": {
				if (!(resolved.type === "bet" ? legal.canBet : legal.canRaise)) return {
					ok: false,
					error: `A ${resolved.type} is not legal here`
				};
				const to = resolved.to;
				if (!Number.isInteger(to)) return {
					ok: false,
					error: "Bet sizes must be whole chips"
				};
				if (to < legal.minTo) return {
					ok: false,
					error: `The minimum ${resolved.type} is to ${legal.minTo}`
				};
				if (to > legal.maxTo) return {
					ok: false,
					error: `You only have enough chips to reach ${legal.maxTo}`
				};
				const raiseSize = to - this.currentBet;
				const added = to - p.streetBet;
				this.commit(p, added);
				if (raiseSize >= this.lastRaiseSize) this.lastRaiseSize = raiseSize;
				this.currentBet = to;
				this.lastAggressorSeat = p.seat;
				this.record(p, resolved.type, added, facing, potBefore);
				break;
			}
		}
		p.hasActed = true;
		p.matchedLevel = this.currentBet;
		const fromIndex = this.actorIndex;
		this.actorIndex = null;
		if (this.players.filter((o) => !o.folded).length === 1) this.endBettingRound();
		else {
			const next = this.findNextActor(fromIndex);
			if (next !== null) this.actorIndex = next;
			else this.endBettingRound();
		}
		this.assertChipsConserved();
		return { ok: true };
	}
	commit(p, chips) {
		p.stack -= chips;
		p.streetBet += chips;
		p.contributed += chips;
		p.allIn = p.stack === 0;
	}
	record(p, action, added, facing, potBefore) {
		this.events.push({
			t: "action",
			seat: p.seat,
			street: this.street,
			action,
			added,
			to: p.streetBet,
			allIn: p.allIn,
			pot: this.totalPot,
			facing,
			potBefore
		});
	}
	/** Returns the part of the top bet nobody matched. Folded chips count as matched. */
	returnUncalled() {
		let top = null;
		let second = 0;
		for (const p of this.players) if (!top || p.streetBet > top.streetBet) {
			if (top) second = Math.max(second, top.streetBet);
			top = p;
		} else second = Math.max(second, p.streetBet);
		if (!top || top.folded || top.streetBet <= second) return;
		const refund = top.streetBet - second;
		top.streetBet -= refund;
		top.contributed -= refund;
		top.stack += refund;
		top.allIn = top.stack === 0;
		this.events.push({
			t: "uncalled",
			seat: top.seat,
			amount: refund
		});
	}
	endBettingRound() {
		this.returnUncalled();
		const collected = this.players.reduce((sum, p) => sum + p.streetBet, 0);
		if (collected > 0) {
			for (const p of this.players) p.streetBet = 0;
			this.pot += collected;
			this.events.push({
				t: "collect",
				pot: this.pot
			});
		}
		if (this.lastAggressorSeat !== null) this.showdownLeadSeat = this.lastAggressorSeat;
		const live = this.players.filter((p) => !p.folded);
		if (live.length === 1) {
			this.finishWithoutShowdown(live[0]);
			return;
		}
		for (;;) {
			if (this.street === "river") {
				this.finishAtShowdown();
				return;
			}
			for (const p of this.players) {
				p.hasActed = false;
				p.matchedLevel = 0;
			}
			this.currentBet = 0;
			this.lastRaiseSize = this.bigBlind;
			this.lastAggressorSeat = null;
			const canAct = live.filter((p) => !p.allIn);
			if (canAct.length <= 1 && !this.revealedRunout) {
				this.revealedRunout = true;
				this.events.push({
					t: "allin_reveal",
					hands: live.map((p) => ({
						seat: p.seat,
						cards: [p.hole[0], p.hole[1]]
					}))
				});
			}
			this.dealNextStreet();
			if (canAct.length >= 2) {
				const first = this.players.findIndex((p) => !p.folded && !p.allIn);
				this.actorIndex = first;
				return;
			}
		}
	}
	dealNextStreet() {
		const street = this.street === "preflop" ? "flop" : this.street === "flop" ? "turn" : "river";
		this.street = street;
		this.deck.burn();
		this.events.push({
			t: "burn",
			street
		});
		const count = street === "flop" ? 3 : 1;
		const cards = [];
		for (let i = 0; i < count; i++) cards.push(this.deck.draw());
		this.board.push(...cards);
		this.events.push({
			t: "board",
			street,
			cards,
			board: [...this.board]
		});
	}
	finishWithoutShowdown(winner) {
		const pots = [{
			amount: this.pot,
			eligible: [winner.seat],
			winners: [{
				seat: winner.seat,
				amount: this.pot
			}]
		}];
		winner.stack += this.pot;
		this.events.push({
			t: "award",
			potIndex: 0,
			potCount: 1,
			potAmount: this.pot,
			seat: winner.seat,
			amount: this.pot,
			description: null,
			bestFive: null
		});
		this.finalize(pots, {}, [], false);
	}
	finishAtShowdown() {
		this.street = "showdown";
		const live = this.players.filter((p) => !p.folded);
		const evaluations = {};
		for (const p of live) evaluations[p.seat] = evaluateHand([
			p.hole[0],
			p.hole[1],
			...this.board
		]);
		const pots = computePots(this.players.map((p) => ({
			seat: p.seat,
			amount: p.contributed,
			folded: p.folded
		})));
		const potted = pots.reduce((sum, pot) => sum + pot.amount, 0);
		if (potted !== this.pot) throw new Error(`Pot mismatch: layers ${potted} vs pot ${this.pot}`);
		const results = pots.map((pot) => {
			let best = -1;
			for (const seat of pot.eligible) best = Math.max(best, evaluations[seat].score);
			const winners = pot.eligible.filter((seat) => evaluations[seat].score === best);
			return {
				...pot,
				winners: splitPot(pot.amount, winners, this.seatOrder)
			};
		});
		const winnerSeats = new Set(results.flatMap((r) => r.winners.map((w) => w.seat)));
		const shown = [];
		const order = this.showdownOrder(live);
		let bestShown = -1;
		for (const p of order) {
			const score = evaluations[p.seat].score;
			if (this.revealedRunout || score >= bestShown || winnerSeats.has(p.seat)) {
				bestShown = Math.max(bestShown, score);
				shown.push(p.seat);
				this.events.push({
					t: "show",
					seat: p.seat,
					cards: [p.hole[0], p.hole[1]],
					description: evaluations[p.seat].description,
					bestFive: evaluations[p.seat].bestFive
				});
			} else this.events.push({
				t: "muck",
				seat: p.seat
			});
		}
		results.forEach((pot, potIndex) => {
			for (const w of pot.winners) {
				this.playerAt(w.seat).stack += w.amount;
				const showingDown = pot.eligible.length > 1;
				this.events.push({
					t: "award",
					potIndex,
					potCount: results.length,
					potAmount: pot.amount,
					seat: w.seat,
					amount: w.amount,
					description: showingDown ? evaluations[w.seat].description : null,
					bestFive: showingDown ? evaluations[w.seat].bestFive : null
				});
			}
		});
		this.finalize(results, evaluations, shown, true);
	}
	showdownOrder(live) {
		const startIndex = this.showdownLeadSeat === null ? -1 : live.findIndex((p) => p.seat === this.showdownLeadSeat);
		if (startIndex < 0) return live;
		return [...live.slice(startIndex), ...live.slice(0, startIndex)];
	}
	finalize(pots, evaluations, shownSeats, wentToShowdown) {
		this.actorIndex = null;
		const net = {};
		const finalStacks = {};
		for (const p of this.players) {
			net[p.seat] = p.stack - p.startStack;
			finalStacks[p.seat] = p.stack;
			p.allIn = false;
		}
		this.pot = 0;
		this.result = {
			pots,
			net,
			finalStacks,
			wentToShowdown,
			shownSeats,
			evaluations,
			liveSeats: this.players.filter((p) => !p.folded).map((p) => p.seat),
			allInRunout: this.revealedRunout
		};
		this.events.push({ t: "hand_end" });
		this.assertChipsConserved();
	}
	/** Every chip is always either in a stack, in a bet or in the pot. */
	assertChipsConserved() {
		const total = this.players.reduce((sum, p) => sum + p.stack + p.streetBet, this.pot);
		if (total !== this.startTotal) throw new Error(`Chip conservation violated on hand ${this.handNumber}: ${total} vs ${this.startTotal}`);
	}
};
// src/engine/rng.ts
function unbiasedInt(u32, maxExclusive) {
	if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 4294967296) throw new Error(`Invalid random bound: ${maxExclusive}`);
	const limit = 4294967296 - 4294967296 % maxExclusive;
	let value = u32();
	while (value >= limit) value = u32();
	return value % maxExclusive;
}
function hashSeed(seed) {
	const text = String(seed);
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
/**
* sfc32: small, fast and statistically solid. Used for reproducible tests,
* bug reports (the seed is logged) and for AI decisions.
*/
var SeededRng = class {
	a;
	b;
	c;
	d = 1;
	constructor(seed) {
		const h = hashSeed(seed);
		this.a = h;
		this.b = Math.imul(h ^ 2654435769, 2246822507) >>> 0;
		this.c = Math.imul(h ^ 608135816, 3266489909) >>> 0;
		for (let i = 0; i < 16; i++) this.u32();
	}
	u32() {
		const t = (this.a + this.b | 0) + this.d | 0;
		this.d = this.d + 1 | 0;
		this.a = this.b ^ this.b >>> 9;
		this.b = this.c + (this.c << 3) | 0;
		this.c = this.c << 21 | this.c >>> 11;
		this.c = this.c + t | 0;
		return t >>> 0;
	}
	next() {
		return this.u32() / 4294967296;
	}
	int(maxExclusive) {
		return unbiasedInt(() => this.u32(), maxExclusive);
	}
};
/** Cryptographically strong source used to shuffle real gameplay decks. */
var CryptoRng = class {
	buffer = /* @__PURE__ */ new Uint32Array(256);
	index = 256;
	u32() {
		if (this.index >= this.buffer.length) {
			globalThis.crypto.getRandomValues(this.buffer);
			this.index = 0;
		}
		return this.buffer[this.index++];
	}
	next() {
		return this.u32() / 4294967296;
	}
	int(maxExclusive) {
		return unbiasedInt(() => this.u32(), maxExclusive);
	}
};
// src/history/record.ts
/**
* Objective bad-beat test: the loser put in at least a quarter of their stack,
* was ahead of the eventual winner on the turn and the river turned it around.
*/
function findBadBeats(hand) {
	const result = hand.result;
	if (!result || !result.wentToShowdown || hand.board.length !== 5) return [];
	const winnerSeat = result.pots[0].winners[0]?.seat;
	const winner = hand.playerAt(winnerSeat);
	if (!winner) return [];
	const turnBoard = hand.board.slice(0, 4);
	const winnerOnTurn = scoreHand([
		winner.hole[0],
		winner.hole[1],
		...turnBoard
	]);
	const beats = [];
	for (const p of hand.players) {
		if (p.folded || p.seat === winnerSeat || result.net[p.seat] >= 0) continue;
		if (p.contributed < p.startStack * .25) continue;
		const onTurn = scoreHand([
			p.hole[0],
			p.hole[1],
			...turnBoard
		]);
		if (categoryOf(onTurn) >= 1 && onTurn > winnerOnTurn) beats.push(p.seat);
	}
	return beats;
}
/** Freezes a completed hand into a plain, serialisable record. */
function buildHandRecord(hand, meta) {
	const result = hand.result;
	if (!result) throw new Error("Cannot record an unfinished hand");
	const shown = new Set(result.shownSeats);
	const heroPlayer = meta.heroId ? hand.players.find((p) => p.id === meta.heroId) : void 0;
	const players = hand.players.map((p) => ({
		seat: p.seat,
		id: p.id,
		name: p.name,
		isHuman: p.id === meta.heroId,
		position: p.position,
		startStack: p.startStack,
		finalStack: result.finalStacks[p.seat],
		hole: [p.hole[0], p.hole[1]],
		shown: shown.has(p.seat),
		folded: p.folded,
		net: result.net[p.seat]
	}));
	return {
		schema: 1,
		id: meta.id,
		sessionId: meta.sessionId,
		tableId: meta.tableId,
		tableName: meta.tableName,
		mode: meta.mode,
		tournamentId: meta.tournamentId,
		level: meta.level,
		handNumber: hand.handNumber,
		ts: meta.now,
		sb: hand.smallBlind,
		bb: hand.bigBlind,
		ante: hand.ante,
		maxSeats: meta.maxSeats,
		buttonSeat: hand.buttonSeat,
		sbSeat: hand.sbSeat,
		bbSeat: hand.bbSeat,
		players,
		heroSeat: heroPlayer ? heroPlayer.seat : null,
		events: hand.events.map((e) => e),
		board: [...hand.board],
		pots: result.pots,
		totalPot: result.pots.reduce((sum, pot) => sum + pot.amount, 0),
		wentToShowdown: result.wentToShowdown,
		allInRunout: result.allInRunout,
		badBeatSeats: findBadBeats(hand),
		heroNet: heroPlayer ? result.net[heroPlayer.seat] : 0
	};
}
// src/stats/counters.ts
var emptyCounters = () => ({
	hands: 0,
	decisions: 0,
	vpip: 0,
	pfr: 0,
	threeBetOpp: 0,
	threeBet: 0,
	faced3Bet: 0,
	foldTo3Bet: 0,
	fourBet: 0,
	cbetOpp: 0,
	cbet: 0,
	facedCbet: 0,
	foldToCbet: 0,
	sawFlop: 0,
	wtsd: 0,
	wsd: 0,
	postBets: 0,
	postRaises: 0,
	postCalls: 0,
	postFolds: 0,
	postChecks: 0,
	facedBetFlop: 0,
	foldBetFlop: 0,
	facedBetTurn: 0,
	foldBetTurn: 0,
	facedBetRiver: 0,
	foldBetRiver: 0,
	callBetRiver: 0,
	raiseBetRiver: 0,
	facedRiverRaise: 0,
	calledRiverRaise: 0,
	wonRiverCalls: 0,
	riverCallsToShowdown: 0,
	bbFacedSteal: 0,
	bbDefend: 0,
	stealOpp: 0,
	steal: 0,
	blindFacedSteal: 0,
	blindFoldSteal: 0,
	betCount: 0,
	betPotRatioSum: 0,
	tinyBets: 0,
	hugeBets: 0,
	riverBets: 0,
	riverBetsLostAtShowdown: 0,
	handsWon: 0,
	allInShowdowns: 0,
	allInEquitySum: 0,
	allInEvDiff: 0,
	net: 0,
	bbNet: 0,
	biggestPotWon: 0,
	biggestPotLost: 0,
	byPosition: {}
});
/** Derives the counters for every player in one hand from its public action log. */
function extractHandStats(record) {
	const out = /* @__PURE__ */ new Map();
	const walks = /* @__PURE__ */ new Map();
	const bySeat = /* @__PURE__ */ new Map();
	const bb = record.bb;
	for (const p of record.players) {
		const c = emptyCounters();
		c.hands = 1;
		out.set(p.id, c);
		bySeat.set(p.seat, p);
		walks.set(p.seat, {
			acted: false,
			vpip: false,
			pfr: false,
			firstRaiser: false,
			facedThreeBetPending: false,
			isPreflopAggressor: false,
			cbetDecisionDone: false
		});
		const pos = c.byPosition[p.position] = {
			hands: 1,
			decisions: 0,
			vpip: 0,
			pfr: 0,
			net: p.net,
			bbNet: p.net / bb
		};
		pos.hands = 1;
	}
	let preflopRaises = 0;
	let preflopAggressorSeat = null;
	let flopBetBySeat = null;
	let flopRaised = false;
	let riverLastAggressiveKind = null;
	const riverCallers = /* @__PURE__ */ new Set();
	const riverBettors = /* @__PURE__ */ new Set();
	let sawFlopSeats = /* @__PURE__ */ new Set();
	let flopReached = false;
	const folded = /* @__PURE__ */ new Set();
	for (const e of record.events) {
		if (e.t === "board" && e.street === "flop") {
			flopReached = true;
			sawFlopSeats = new Set(record.players.filter((p) => !folded.has(p.seat)).map((p) => p.seat));
		}
		if (e.t !== "action") continue;
		const p = bySeat.get(e.seat);
		const c = out.get(p.id);
		const w = walks.get(e.seat);
		const pos = c.byPosition[p.position];
		const aggressive = e.action === "bet" || e.action === "raise";
		if (e.action === "fold") folded.add(e.seat);
		if (e.street === "preflop") {
			if (!w.acted) {
				w.acted = true;
				c.decisions = 1;
				pos.decisions = 1;
				if (preflopRaises === 0 && (p.position === "CO" || p.position === "BTN" || p.position === "SB")) {
					c.stealOpp = 1;
					if (e.action === "raise") c.steal = 1;
				}
			}
			const stealer = preflopAggressorSeat !== null ? bySeat.get(preflopAggressorSeat).position : null;
			if (preflopRaises === 1 && (stealer === "CO" || stealer === "BTN" || stealer === "SB") && (p.position === "BB" || p.position === "SB") && !w.pfr) {
				c.blindFacedSteal = 1;
				if (e.action === "fold") c.blindFoldSteal = 1;
				if (p.position === "BB") {
					c.bbFacedSteal = 1;
					if (e.action !== "fold") c.bbDefend = 1;
				}
			}
			if (preflopRaises === 1 && !w.firstRaiser) {
				c.threeBetOpp = 1;
				if (e.action === "raise") c.threeBet = 1;
			}
			if (w.firstRaiser && preflopRaises === 2 && !w.facedThreeBetPending) {
				w.facedThreeBetPending = true;
				c.faced3Bet = 1;
				if (e.action === "fold") c.foldTo3Bet = 1;
				if (e.action === "raise") c.fourBet = 1;
			}
			if (e.action === "call" || e.action === "raise") {
				if (!w.vpip) {
					w.vpip = true;
					c.vpip = 1;
					pos.vpip = 1;
				}
			}
			if (e.action === "raise") {
				if (!w.pfr) {
					w.pfr = true;
					c.pfr = 1;
					pos.pfr = 1;
				}
				if (preflopRaises === 0) w.firstRaiser = true;
				preflopRaises++;
				preflopAggressorSeat = e.seat;
			}
		} else {
			if (aggressive) {
				const base = e.potBefore + e.facing;
				const raisePart = e.added - e.facing;
				if (base > 0 && raisePart > 0) {
					const ratio = raisePart / base;
					c.betCount++;
					c.betPotRatioSum += ratio;
					if (ratio < .25 && !e.allIn) c.tinyBets++;
					if (ratio > 1.5) c.hugeBets++;
				}
			}
			if (e.action === "bet") c.postBets++;
			else if (e.action === "raise") c.postRaises++;
			else if (e.action === "call") c.postCalls++;
			else if (e.action === "fold") c.postFolds++;
			else c.postChecks++;
			if (e.facing > 0) {
				if (e.street === "flop") {
					c.facedBetFlop++;
					if (e.action === "fold") c.foldBetFlop++;
				} else if (e.street === "turn") {
					c.facedBetTurn++;
					if (e.action === "fold") c.foldBetTurn++;
				} else {
					c.facedBetRiver++;
					if (e.action === "fold") c.foldBetRiver++;
					if (e.action === "call") {
						c.callBetRiver++;
						riverCallers.add(e.seat);
					}
					if (e.action === "raise") c.raiseBetRiver++;
					if (riverLastAggressiveKind === "raise") {
						c.facedRiverRaise++;
						if (e.action === "call") c.calledRiverRaise++;
					}
				}
			}
			if (e.street === "flop") {
				if (preflopAggressorSeat === e.seat && !w.cbetDecisionDone && flopBetBySeat === null) {
					w.cbetDecisionDone = true;
					c.cbetOpp = 1;
					if (e.action === "bet") c.cbet = 1;
				}
				if (flopBetBySeat !== null && flopBetBySeat === preflopAggressorSeat && !flopRaised && e.seat !== flopBetBySeat) {
					c.facedCbet = 1;
					if (e.action === "fold") c.foldToCbet = 1;
				}
				if (e.action === "bet") flopBetBySeat = e.seat;
				if (e.action === "raise") flopRaised = true;
			}
			if (e.street === "river") {
				if (aggressive) {
					riverLastAggressiveKind = e.action;
					riverBettors.add(e.seat);
					c.riverBets++;
				}
			}
		}
	}
	const showdownWinners = /* @__PURE__ */ new Set();
	if (record.wentToShowdown) {
		for (const pot of record.pots) if (pot.eligible.length > 1) for (const w of pot.winners) showdownWinners.add(w.seat);
	}
	for (const p of record.players) {
		const c = out.get(p.id);
		c.net = p.net;
		c.bbNet = p.net / bb;
		if (p.net > 0) {
			c.handsWon = 1;
			c.biggestPotWon = record.totalPot;
		} else if (p.net < 0) c.biggestPotLost = -p.net;
		if (flopReached && sawFlopSeats.has(p.seat)) {
			c.sawFlop = 1;
			if (record.wentToShowdown && !p.folded) {
				c.wtsd = 1;
				if (showdownWinners.has(p.seat)) c.wsd = 1;
			}
		}
		if (riverBettors.has(p.seat) && record.wentToShowdown && !p.folded && !showdownWinners.has(p.seat)) c.riverBetsLostAtShowdown = 1;
		if (riverCallers.has(p.seat) && record.wentToShowdown && !p.folded) {
			c.riverCallsToShowdown = 1;
			if (showdownWinners.has(p.seat)) c.wonRiverCalls = 1;
		}
	}
	if (record.allInEquity) for (const entry of record.allInEquity) {
		const p = bySeat.get(entry.seat);
		if (!p) continue;
		const c = out.get(p.id);
		c.allInShowdowns = 1;
		c.allInEquitySum = entry.equity;
		c.allInEvDiff = entry.evDiff / bb;
	}
	return out;
}
/** Population priors the AI assumes before it has seen a player. */
var PRIOR = {
	vpip: .28,
	pfr: .16,
	threeBet: .07,
	foldTo3Bet: .55,
	cbet: .6,
	foldToCbet: .42,
	foldFlop: .38,
	foldTurn: .38,
	foldRiver: .4,
	afq: .35,
	wtsd: .3,
	steal: .3,
	blindFold: .6
};
PRIOR.vpip, PRIOR.pfr, PRIOR.threeBet, PRIOR.foldTo3Bet, PRIOR.cbet, PRIOR.foldToCbet, PRIOR.foldFlop, PRIOR.foldTurn, PRIOR.foldRiver, PRIOR.afq, PRIOR.wtsd, PRIOR.blindFold;
// src/online/protocol.ts
var ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// src/online/statsCodec.ts
/**
* Online statistics are stored as one flat JSON object of numbers so the database
* can add a hand's counters to the totals in a single statement.
*/
function flattenCounters(c) {
	const out = {};
	for (const [key, value] of Object.entries(c)) {
		if (key === "byPosition") continue;
		if (typeof value === "number" && value !== 0) out[key] = value;
	}
	for (const [pos, counters] of Object.entries(c.byPosition)) for (const [field, value] of Object.entries(counters)) if (value !== 0) out[`pos.${pos}.${field}`] = value;
	return out;
}
// src/online/server/core.ts
/**
* The trusted online game server. It runs inside the Supabase Edge Function and is
* the only code that deals cards or decides who wins chips. It reuses the same
* engine as offline play.
*
* It is stateless: each request loads the room, rebuilds the current hand by
* replaying the stored deck order and action list through the engine, applies the
* new action, and writes the result back with `room_commit`. That write only lands
* if nobody changed the room in between, so concurrent requests can never both apply.
*/
var GameError = class extends Error {
	code;
	status;
	constructor(code, status = 400) {
		super(code);
		this.code = code;
		this.status = status;
	}
};
var SHOWDOWN_PAUSE_MS = 4500;
var HAND_PAUSE_MS = 2500;
/** A seat that times out this many times in a row is sat out until it returns. */
var MISSES_BEFORE_SIT_OUT = 2;
var TIMEOUT_GRACE_MS = 800;
var isInt = (v, lo, hi) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
var isRef = (v) => typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);
var isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** Translates a database exception into a client-facing error code. */
function asGameError(error) {
	if (error instanceof GameError) return error;
	const known = (error instanceof Error ? error.message : String(error)).match(/\b(insufficient_chips|duplicate_request|room_not_found|already_seated|room_full|buyin_out_of_range|buyin_too_small|not_seated|in_hand|version_conflict|not_bankrupt|chip_conservation_failed|seat_changed_during_hand)\b/);
	if (known) return new GameError(known[1], known[1] === "version_conflict" ? 409 : 400);
	return new GameError("server_error", 500);
}
async function call(deps, name, args) {
	try {
		return await deps.rpc(name, args);
	} catch (error) {
		throw asGameError(error);
	}
}
async function load(deps, roomId) {
	const data = await call(deps, "room_load", { p_room: roomId });
	if (!data?.room) throw new GameError("room_not_found", 404);
	data.secret.actions ??= [];
	data.room.small_blind = Number(data.room.small_blind);
	data.room.big_blind = Number(data.room.big_blind);
	data.state.version = Number(data.state.version);
	for (const s of data.seats) {
		s.stack = Number(s.stack);
		s.invested = Number(s.invested);
	}
	return data;
}
/** Rebuilds the hand exactly as it stands by replaying its stored deck and actions. */
function rebuild(data) {
	const { secret, state, room } = data;
	if (!secret.deck || !secret.start_seats || state.button_seat === null) throw new GameError("hand_not_active");
	const hand = new Hand({
		handNumber: secret.hand_no,
		players: secret.start_seats.map((s) => ({
			seat: s.seat,
			id: s.id,
			name: s.name,
			stack: s.stack
		})),
		buttonSeat: state.button_seat,
		smallBlind: room.small_blind,
		bigBlind: room.big_blind,
		deck: Deck.stacked(secret.deck.map(Number), new SeededRng(0))
	});
	for (const a of secret.actions) if (!hand.act(a.seat, a.move).ok) throw new GameError("server_error", 500);
	return hand;
}
function publicTable(data, hand, startSeats, now, nextHandAt) {
	const actorSeat = hand && !hand.isComplete ? hand.actorSeat : null;
	const actor = actorSeat === null ? void 0 : hand.playerAt(actorSeat);
	let summary = null;
	if (hand?.result) {
		const names = new Map(startSeats.map((s) => [s.seat, s.name]));
		summary = hand.result.pots.flatMap((p) => p.winners.map((w) => `${names.get(w.seat)} wins ${w.amount.toLocaleString("en-US")}`)).join(", ");
	}
	return {
		handNo: data.secret.hand_no,
		handActive: Boolean(hand && !hand.isComplete),
		buttonSeat: hand ? hand.buttonSeat : data.state.button_seat,
		smallBlind: data.room.small_blind,
		bigBlind: data.room.big_blind,
		startSeats: startSeats.map((s) => ({
			seat: s.seat,
			userId: s.id,
			name: s.name,
			avatar: s.avatar,
			stack: s.stack
		})),
		events: hand ? hand.events.map((e) => e) : [],
		actorSeat,
		actorUserId: actor ? actor.id : null,
		deadline: actorSeat === null ? null : now + data.room.action_seconds * 1e3,
		actionSeconds: data.room.action_seconds,
		legal: actorSeat === null ? null : hand.legalActions(actorSeat),
		nextHandAt,
		summary
	};
}
/** Removes every hole card that was not shown before a hand is stored for its players. */
function redactedRecord(hand, data, now) {
	const record = buildHandRecord(hand, {
		id: `${data.room.id}:${hand.handNumber}`,
		sessionId: data.room.id,
		tableId: data.room.id,
		tableName: data.room.name,
		mode: "cash",
		maxSeats: data.room.max_seats,
		heroId: null,
		now
	});
	for (const p of record.players) if (!p.shown) p.hole = [-1, -1];
	return record;
}
/**
* After a real action, seats that asked to leave fold or check automatically
* whenever it is their turn, so the hand never waits on someone who has gone.
*/
function playOutLeavers(hand, data, log) {
	const leaving = new Set(data.seats.filter((s) => s.status === "leaving").map((s) => s.seat));
	for (let guard = 0; guard < 50 && !hand.isComplete; guard++) {
		const seat = hand.actorSeat;
		if (seat === null || !leaving.has(seat)) return;
		const move = hand.legalActions(seat).canCheck ? { type: "check" } : { type: "fold" };
		hand.act(seat, move);
		log.push({
			seat,
			move,
			auto: "leaving"
		});
	}
}
/** Writes the hand's new position, settling chips if it has ended. */
async function commitHand(deps, data, hand, actions, seatUpdates) {
	const now = deps.now();
	const startSeats = data.secret.start_seats;
	let settle = null;
	let nextHandAt = null;
	if (hand.isComplete) {
		const result = hand.result;
		nextHandAt = now + (result.wentToShowdown ? SHOWDOWN_PAUSE_MS : HAND_PAUSE_MS);
		const record = redactedRecord(hand, data, now);
		const stats = [...extractHandStats(record)].map(([userId, delta]) => ({
			user_id: userId,
			delta: flattenCounters(delta)
		}));
		settle = {
			stacks: startSeats.map((s) => ({
				seat: s.seat,
				user_id: s.id,
				stack: result.finalStacks[s.seat]
			})),
			record,
			stats
		};
	}
	const version = await call(deps, "room_commit", {
		p_room: data.room.id,
		p_version: data.state.version,
		p_public: publicTable(data, hand, startSeats, now, nextHandAt),
		p_hand_active: !hand.isComplete,
		p_hand_no: data.secret.hand_no,
		p_button: hand.buttonSeat,
		p_next_hand_at: nextHandAt === null ? null : new Date(nextHandAt).toISOString(),
		p_secret: { actions },
		p_private: null,
		p_seat_updates: seatUpdates,
		p_settle: settle
	});
	return { version: Number(version) };
}
function nextButton(previous, eligible, maxSeats) {
	if (previous === null) return eligible[0];
	for (let i = 1; i <= maxSeats; i++) {
		const seat = (previous + i) % maxSeats;
		if (eligible.includes(seat)) return seat;
	}
	return eligible[0];
}
async function startHand(deps, userId, roomId) {
	const data = await load(deps, roomId);
	if (!data.seats.some((s) => s.user_id === userId)) throw new GameError("not_seated", 403);
	if (data.state.hand_active) throw new GameError("hand_already_active", 409);
	const now = deps.now();
	if (data.state.next_hand_at && now < Date.parse(data.state.next_hand_at)) throw new GameError("too_early", 409);
	const eligible = data.seats.filter((s) => s.status === "active" && s.stack > 0);
	if (eligible.length < 2) throw new GameError("not_enough_players", 409);
	const rng = deps.rng ?? new CryptoRng();
	const order = Array.from({ length: 52 }, (_, i) => i);
	for (let i = 51; i > 0; i--) {
		const j = rng.int(i + 1);
		[order[i], order[j]] = [order[j], order[i]];
	}
	const button = nextButton(data.state.button_seat, eligible.map((s) => s.seat).sort((a, b) => a - b), data.room.max_seats);
	const handNo = data.state.hand_no + 1;
	const startSeats = eligible.map((s) => ({
		seat: s.seat,
		id: s.user_id,
		name: s.display_name || s.username,
		avatar: s.avatar,
		stack: s.stack
	}));
	data.secret = {
		hand_no: handNo,
		deck: order,
		start_seats: startSeats,
		actions: []
	};
	data.state.button_seat = button;
	const hand = rebuild(data);
	const log = [];
	playOutLeavers(hand, data, log);
	const settleNow = hand.isComplete;
	const nextHandAt = settleNow ? now + SHOWDOWN_PAUSE_MS : null;
	let settle = null;
	if (settleNow) {
		const result = hand.result;
		const record = redactedRecord(hand, data, now);
		settle = {
			stacks: startSeats.map((s) => ({
				seat: s.seat,
				user_id: s.id,
				stack: result.finalStacks[s.seat]
			})),
			record,
			stats: [...extractHandStats(record)].map(([id, delta]) => ({
				user_id: id,
				delta: flattenCounters(delta)
			}))
		};
	}
	const version = await call(deps, "room_commit", {
		p_room: roomId,
		p_version: data.state.version,
		p_public: publicTable(data, hand, startSeats, now, nextHandAt),
		p_hand_active: !settleNow,
		p_hand_no: handNo,
		p_button: button,
		p_next_hand_at: nextHandAt === null ? null : new Date(nextHandAt).toISOString(),
		p_secret: {
			hand_no: handNo,
			deck: order,
			start_seats: startSeats,
			actions: log
		},
		p_private: hand.players.map((p) => ({
			user_id: p.id,
			cards: [p.hole[0], p.hole[1]]
		})),
		p_seat_updates: null,
		p_settle: settle
	});
	return {
		handNo,
		version: Number(version)
	};
}
async function act(deps, userId, roomId, handNo, move) {
	const data = await load(deps, roomId);
	if (!data.state.hand_active) throw new GameError("hand_not_active", 409);
	if (data.secret.hand_no !== handNo) throw new GameError("stale_hand", 409);
	const hand = rebuild(data);
	const seat = hand.actorSeat;
	if (seat === null || hand.playerAt(seat).id !== userId) throw new GameError("not_your_turn", 409);
	if (!hand.act(seat, move).ok) throw new GameError("illegal_action");
	const log = [...data.secret.actions, {
		seat,
		move
	}];
	playOutLeavers(hand, data, log);
	return commitHand(deps, data, hand, log, data.seats.find((s) => s.seat === seat).missed_turns > 0 ? [{
		seat,
		missed_turns: 0
	}] : null);
}
async function timeout(deps, userId, roomId, handNo) {
	const data = await load(deps, roomId);
	if (!data.seats.some((s) => s.user_id === userId)) throw new GameError("not_seated", 403);
	if (!data.state.hand_active) throw new GameError("hand_not_active", 409);
	if (data.secret.hand_no !== handNo) throw new GameError("stale_hand", 409);
	const deadline = data.state.public.deadline;
	if (deadline === null || deps.now() < deadline + TIMEOUT_GRACE_MS) throw new GameError("too_early", 409);
	const hand = rebuild(data);
	const seat = hand.actorSeat;
	const move = hand.legalActions(seat).canCheck ? { type: "check" } : { type: "fold" };
	hand.act(seat, move);
	const log = [...data.secret.actions, {
		seat,
		move,
		auto: "timeout"
	}];
	playOutLeavers(hand, data, log);
	const misses = data.seats.find((s) => s.seat === seat).missed_turns + 1;
	const update = {
		seat,
		missed_turns: misses
	};
	if (misses >= MISSES_BEFORE_SIT_OUT) update.status = "sitting_out";
	return commitHand(deps, data, hand, log, [update]);
}
/** After someone leaves mid-hand, fold them out at once if it is their turn. */
async function settleLeaverTurn(deps, roomId) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const data = await load(deps, roomId);
		if (!data.state.hand_active) return;
		const hand = rebuild(data);
		const log = [...data.secret.actions];
		const before = log.length;
		playOutLeavers(hand, data, log);
		if (log.length === before) return;
		try {
			await commitHand(deps, data, hand, log, null);
			return;
		} catch (error) {
			if (!(error instanceof GameError && error.code === "version_conflict")) throw error;
		}
	}
}
function newCode(rng) {
	let code = "";
	for (let i = 0; i < 6; i++) code += ROOM_CODE_ALPHABET[rng.int(ROOM_CODE_ALPHABET.length)];
	return code;
}
/** Entry point for every request from a signed-in player. */
async function handleRequest(userId, body, deps) {
	if (!isUuid(userId)) throw new GameError("not_signed_in", 401);
	if (typeof body !== "object" || body === null) throw new GameError("bad_request");
	const req = body;
	switch (req.action) {
		case "create_room": {
			const { smallBlind: sb, bigBlind: bb, minBuyIn: min, maxBuyIn: max, maxSeats, actionSeconds, buyIn, ref } = req;
			const name = typeof req.name === "string" ? req.name.trim().slice(0, 40) : "";
			if (!name || !isInt(sb, 1, 1e6) || !isInt(bb, sb, 2e6) || !isInt(min, Math.max(400, bb * 10), 0xe8d4a51000) || !isInt(max, min, bb * 1e3)) throw new GameError("bad_request");
			if (!isInt(maxSeats, 2, 9) || !isInt(actionSeconds, 10, 120) || !isInt(buyIn, min, max) || !isRef(ref)) throw new GameError("bad_request");
			const rng = deps.rng ?? new CryptoRng();
			let roomId = null;
			let code = "";
			for (let attempt = 0; attempt < 6 && !roomId; attempt++) {
				code = newCode(rng);
				try {
					roomId = await deps.rpc("room_create", {
						p_host: userId,
						p_code: code,
						p_name: name,
						p_sb: sb,
						p_bb: bb,
						p_min: min,
						p_max: max,
						p_seats: maxSeats,
						p_action_seconds: actionSeconds
					});
				} catch (error) {
					if (!/unique|duplicate/i.test(String(error instanceof Error ? error.message : error))) throw asGameError(error);
				}
			}
			if (!roomId) throw new GameError("server_error", 500);
			const seat = await call(deps, "room_join", {
				p_room: roomId,
				p_user: userId,
				p_amount: buyIn,
				p_ref: `buyin-${ref}`
			});
			return {
				roomId,
				code,
				seat
			};
		}
		case "join_room": {
			if (typeof req.code !== "string" || !/^[A-Za-z2-9]{6}$/.test(req.code) || !isInt(req.buyIn, 1, 0xe8d4a51000) || !isRef(req.ref)) throw new GameError("bad_request");
			const roomId = await call(deps, "room_find", { p_code: req.code.toUpperCase() });
			if (!roomId) throw new GameError("room_not_found", 404);
			return {
				roomId,
				seat: await call(deps, "room_join", {
					p_room: roomId,
					p_user: userId,
					p_amount: req.buyIn,
					p_ref: `buyin-${req.ref}`
				})
			};
		}
		case "leave_room": {
			if (!isUuid(req.roomId) || !isRef(req.ref)) throw new GameError("bad_request");
			const status = await call(deps, "room_leave", {
				p_room: req.roomId,
				p_user: userId,
				p_ref: `cashout-${req.ref}`
			});
			if (status === "leaving") await settleLeaverTurn(deps, req.roomId);
			return { status };
		}
		case "top_up": {
			if (!isUuid(req.roomId) || !isInt(req.amount, 1, 0xe8d4a51000) || !isRef(req.ref)) throw new GameError("bad_request");
			const stack = await call(deps, "room_topup", {
				p_room: req.roomId,
				p_user: userId,
				p_amount: req.amount,
				p_ref: `topup-${req.ref}`
			});
			return { stack: Number(stack) };
		}
		case "sit_out":
		case "sit_in":
			if (!isUuid(req.roomId)) throw new GameError("bad_request");
			await call(deps, "room_set_status", {
				p_room: req.roomId,
				p_user: userId,
				p_status: req.action === "sit_out" ? "sitting_out" : "active"
			});
			return { ok: true };
		case "start_hand":
			if (!isUuid(req.roomId)) throw new GameError("bad_request");
			return startHand(deps, userId, req.roomId);
		case "act":
			if (!isUuid(req.roomId) || !isInt(req.handNo, 1, 1e9) || !isMove(req.move)) throw new GameError("bad_request");
			return act(deps, userId, req.roomId, req.handNo, req.move);
		case "timeout":
			if (!isUuid(req.roomId) || !isInt(req.handNo, 1, 1e9)) throw new GameError("bad_request");
			return timeout(deps, userId, req.roomId, req.handNo);
		default: throw new GameError("bad_request");
	}
}
function isMove(m) {
	if (typeof m !== "object" || m === null) return false;
	const move = m;
	switch (move.type) {
		case "fold":
		case "check":
		case "call":
		case "allin": return Object.keys(move).length === 1;
		case "bet":
		case "raise": return isInt(move.to, 1, 0xe8d4a51000) && Object.keys(move).length === 2;
		default: return false;
	}
}
export { GameError, handleRequest };

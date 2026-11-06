# Architecture

## Principles

1. **The engine is authoritative and knows nothing about the screen.** `src/engine` has no timers, DOM or randomness of its own. Every chip movement happens there, and `Hand` asserts chip conservation after every action.
2. **The interface is a function of state.** `TableSurface` draws a `TableView` and cannot change anything. Animations are CSS driven by keys derived from engine events, so they can never affect a result.
3. **Bots only see what a player could see.** They receive a `PublicHandView` containing public information plus their own two cards, never the `Hand` object. A test asserts this.
4. **Every table is isolated.** A `TableController` owns its own `PokerTable`, RNG, timers and view. React subscribes per table, so one table's update never re-renders another.
5. **Money has one door.** Only `Career.apply` can change the bankroll. It rejects non-integers, overdrafts and repeated references, and writes the ledger entry and profile in one atomic transaction.

## Data flow

```
                 ┌────────────── PublicHandView ──────────────┐
                 ▼                                            │
             BotBrain ── Decision ──▶ TableController ──▶ Hand (engine)
                                        │   ▲   │              │
      Player clicks ─ heroAct / pre-action  │   │              │ events
                                            │   ▼              ▼
                     useSyncExternalStore ◀ TableView ◀ applyEvent (reducer)
                                                               ▲
                                  HandRecord ── replay frames ─┘
                                      │
              ┌───────────────┬───────┴────────┬───────────────┐
              ▼               ▼                ▼               ▼
         ObservedStats    Career ledger    Coach worker    IndexedDB
         (HUD, AI reads)  and counters     (reviews)       (history)
```

The same `applyEvent` reducer powers live play and replays, which is why a replay always matches what happened.

## The engine

- **Cards** are integers from 0 to 51, so evaluation allocates nothing.
- **`scoreHand`** returns an integer where higher is stronger and equal means a tie: category in the top bits, then five rank nibbles. It evaluates about 9 million seven-card hands per second.
- **`Hand`** is the betting state machine. The rules that are easy to get wrong:
  - A short all-in does not change the minimum raise increment.
  - A player who has already acted may re-raise only if facing at least one full raise since acting. Several short all-ins can add up to that, following the TDA rule.
  - The bet to match stays the nominal big blind even when the big blind is short.
  - Uncalled chips are returned before pots are built.
  - Heads-up, the button posts the small blind, acts first preflop and last on later streets.
- **`computePots`** builds a layer per distinct live contribution level. Folded chips stay in as dead money, and folded players are never eligible.
- **`PokerTable`** moves the button one active seat clockwise. This is a simplified moving button, not a full dead-button rule, so a player can occasionally post the big blind twice when the table shrinks to heads-up.

## The AI

A decision goes through a fixed pipeline in `src/ai/decision.ts`:

1. **Style:** base attributes (1-100) plus mood give an `EffectiveStyle`. Tilt moves play in the archetype's own direction and lowers skill.
2. **Perception:** position, players behind, effective stack, SPR, pot odds, board texture and tournament pressure.
3. **Ranges:** `estimateRange` builds a belief over all 1326 combos from position, action history and observed tendencies, re-ranking the range on each street and discounting it after each action.
4. **Equity:** Monte Carlo against those ranges, with more samples at higher skill.
5. **Choice:**
   - First-in preflop uses position-based opening ranges, or push/fold when short.
   - Re-raising hands come from a value range plus selected bluffs.
   - Everything else compares estimated EV for fold, check, call and several bet sizes, including fold equity, equity when called, realisation, implied odds and re-raise risk.
   - Personality biases are added, then a softmax picks: high skill nearly always takes the best option, low skill wanders.
6. **Modelled mistakes** are separate from EV reasoning and tagged `basis: 'mistake'`, so recreational errors are identifiable and testable.

Difficulty sets skill and the mix of archetypes. It never touches the deck. "GTO-inspired" is only a style label: no solver is used.

Reads come from public counters and are shrunk toward population averages, with a sample gate, so a handful of hands cannot move a bot's beliefs much.

## Tournaments

`TournamentDirector` runs every table through the real engine and AI. Hands are synchronised: when the hero's table finishes a hand, every other table plays one, then eliminations, level changes and balancing happen between hands. Chips and seats are therefore always consistent.

- Simultaneous eliminations are ranked by stack at the start of the hand.
- `planBalance` is a pure function: it closes tables when the field fits on fewer, then moves the upcoming big blind from the largest table to the smallest.
- A player who leaves stays dealt in and folds until blinded out, as in a live event, and keeps any prize that earns.

## Persistence

| Store | Holds |
|---|---|
| IndexedDB `ledger` | One row per bankroll change: the source of truth |
| IndexedDB `meta` | Profile, open session, recommendations, 25-hand windows, leaderboard |
| IndexedDB `hands` | Hand records, trimmed to the newest 20,000 |
| IndexedDB `reviews` | Coach reviews, keyed by hand |
| IndexedDB `sessions`, `tournaments` | Finished results |
| localStorage | Settings, validated field by field on load |

**Writes that must agree are one transaction.** A hand record, its effect on the stacks and the career totals commit together. So do a buy-in, top-up or cash-out and the session snapshot, and a prize and the removal of the saved game. All writes go through one ordered queue in `Career`. A crash can therefore lose at most the last transaction, never half of one.

**After a refresh:** the player can resume or settle at the last completed hand. A hand in progress was never recorded, so it is void. Settling uses a unique ledger reference, so it cannot pay twice. A tournament that had not started is refunded.

**On load:** the bankroll must equal the ledger sum. If a stored profile disagrees, the ledger wins and the player is told. A damaged saved session is discarded rather than trusted.

**Future online features:** client storage is not secure. A global leaderboard or multiplayer needs a server-authoritative backend. `career/leaderboard.ts` is the module to replace.

## The coach

Reviews run in a Web Worker (with a lighter main-thread fallback) and read only what the player could see. Each decision compares required equity with estimated equity against modelled ranges, and separates what was **known** from what was **estimated**. Opponent cards appear only when actually shown. All-in equity comes from revealed cards, using exact enumeration when practical.

The leak finder compares measured frequencies with broad healthy ranges. It says nothing below a minimum sample, and it calls a result `supported` only when the Wilson interval sits clear of the range; otherwise it is a `tendency`. Difficulty advice needs a win rate clear of its uncertainty, so a lucky run does not move it.

## Testing

| Suite | Covers |
|---|---|
| `evaluator` | All categories, kickers, ties, all 2,598,960 five-card hands, cross-check against an independent ranker |
| `slow/evaluator7` | All 133,784,560 seven-card hands against published counts |
| `hand`, `pots`, `deck` | Betting rules, side pots, rotation, shuffling uniformity, a 20,000-hand fuzz |
| `equity` | Exact and Monte Carlo agreement, range parsing, card removal |
| `ai` | Legality, personalities, position, stack depth, tilt, adaptation, timing |
| `stats`, `coach` | Denominators, review logic, leak detection, training rules |
| `tableController`, `preActions` | Timers, time bank, every pre-action rule, four-table independence |
| `tournament`, `career` | Full events, payouts, balancing, ledger integrity, restarts, corruption |
| `gameService` | End-to-end accounting, refresh, resume, forfeits |
| `ui` | Controls, hotkeys, HUD, charts, replay, hidden-card checks |

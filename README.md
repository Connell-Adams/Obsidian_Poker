# Obsidian Room

A Texas Hold'em simulator, career emulator, multi-table client and strategy trainer. It runs entirely in your browser, with **simulated chips only**: there are no deposits, withdrawals or real-money features of any kind.

- A complete no-limit hold'em engine: side pots, odd chips, short all-ins, reopening rules and heads-up blinds.
- Twelve AI personalities with individual attributes, range-based decisions, tilt, adaptation and human-like timing.
- Up to four simultaneous tables with independent state, timers and pre-actions.
- Cash games and multi-table tournaments with real blind schedules, balancing, re-entries and payouts.
- A persistent career: bankroll ledger, achievements, trophies and a local simulated leaderboard.
- A training platform: HUD, hand replays, a hand-by-hand coach, an equity calculator and a leak finder.

## Play it

**[Play in your browser](https://connell-adams.github.io/Obsidian_Poker/)**: nothing to install. Your career saves in your own browser.

## Run it locally

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

Then open the address it prints, usually <http://localhost:5173>.

**No Node installed?** On Windows, double-click `play.cmd`. It looks for Node on your PATH, then for the copy bundled with LM Studio, and otherwise falls back to serving the production build with Python.

### Other commands

| Command | What it does |
|---|---|
| `npm test` | Runs the test suite (about a minute) |
| `npm run test:slow` | Checks the evaluator against all 133,784,560 seven-card hands (about 15 seconds) |
| `npm run typecheck` | Type-checks without building |
| `npm run build` | Type-checks and creates the production build in `dist/` |

## How to play

1. Choose **Play**, then a **Cash Game** or **Tournament**.
2. When it is your turn, the table glows and its controls appear below it. Each table has its own controls, so a click cannot land on the wrong one.
3. When it is not your turn, tick a pre-action under the table: Check/Fold, Fold to Any, Check, Call Any or a preset raise.

### Keyboard shortcuts

Shortcuts only ever act on the highlighted table, and they ignore keys pressed in the first moments after the highlight moves.

| Key | Action |
|---|---|
| `F` | Fold |
| `C` | Check or call |
| `R` | Bet or raise the amount selected |
| `Shift` + `A` | All-in |
| `T` | Use time bank |

## Project layout

| Folder | Purpose |
|---|---|
| `src/engine` | Cards, deck, evaluator, betting state machine, side pots. No UI or timers. |
| `src/equity` | Exact and Monte Carlo equity, range parsing, generated preflop tables |
| `src/ai` | Personalities, emotions, range estimation, the decision engine, timing, chat |
| `src/session` | Runs one table: hand loop, pacing, timers, pre-actions, view reducer |
| `src/tournament` | Blind schedule, payouts, balancing, the tournament director |
| `src/career` | Bankroll ledger, achievements, leaderboard |
| `src/stats` | Counters with explicit denominators, and player reads for the AI |
| `src/history` | Hand records and replay frames |
| `src/coach` | Hand review, all-in equity, leak finder, training, and the Web Worker |
| `src/persistence` | IndexedDB and in-memory storage, validated settings |
| `src/audio` | Synthesised sound effects and ambience |
| `src/app` | `GameService`, which connects everything the interface uses |
| `src/ui` | React components and screens |
| `tests` | Automated tests |
| `tools` | Table generator and AI calibration scripts |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/CHECKLIST.md](docs/CHECKLIST.md) for feature status, test results and known limitations.

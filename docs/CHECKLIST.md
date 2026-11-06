# Development checklist

Status of every part of the specification, and what was actually verified. "Tested" means an automated test exists and passes. "Browser" means it was exercised in a real browser against real IndexedDB.

## Phase reports

### Phase 1: core poker engine
- **Implemented:** cards, seeded and crypto RNG, Fisher-Yates deck, seven-card evaluator, betting state machine, side pots, odd chips, table rotation.
- **Tested:** evaluator against all 2,598,960 five-card hands and all 133,784,560 seven-card hands (published frequencies match exactly), a cross-check against an independent ranker on 40,000 matchups, and a 20,000-hand fuzz that also probes illegal actions.
- **Failed and fixed:** one test expected the wrong first actor. The engine was right and the test was corrected.

### Phase 2: application and interface
- **Implemented:** all 11 screens, original card, chip and avatar artwork, four table themes, responsive shell.
- **Browser:** rendered at 1600x900, 1180x760 and phone size with no console errors.
- **Measured:** the player's hole cards were compared with every other table element, sampling every 120 ms during live hands. Final result: no overlap at 1366x768 (938 samples), 1920x1080 (2,005 samples) or 375x812 (236 samples, on 6-seat tables). All four tables fit at 1366x768 with no scrolling. No horizontal overflow at phone width.
- **Failed and fixed:**
  - A duplicate React key on the board (slot index collided with a card value).
  - A CSS class collision on `.grid-2`, and chip-flight timers cancelled by re-renders.
  - Hole cards too small in 4-table view (50x70, now 80x113 at 1920x1080).
  - The player's own bet overlapped their cards by up to 26 px on laptops: it now sits beside them by layout.
  - Lower side seats overlapped the player's cards by up to 29 px on phones.
  - The preset raise control overflowed its frame at 1366x768, and four tables needed scrolling at that size.
  - The player's own cards disappeared after losing a showdown.

### Phase 3: AI
- **Implemented:** 12 archetypes, nine per-bot attributes, range estimation, EV-based decisions, modelled mistakes, tilt, adaptation, timing tells, chat.
- **Tested:** legality across all archetypes and stack depths, personality separation, position and stack effects, tilt activation and recovery, adaptation with sample gating, imperfect timing tells.
- **Calibrated:** by simulation. First pass had 3-bets far too high (17% for TAGs). The cause was an EV model ignoring 4-bets. Preflop re-raises now come from structured value and bluff ranges.
- **Measured:** typical results at mid difficulty over tens of thousands of hands: TAG about 28/16/6 (VPIP/PFR/3-bet), nit 18/8/4, maniac 49/29/11, station 48/11/3. Difficulty head-to-head with mirrored styles: 10 beats 1 by 37 BB/100, 3 by 44, 5 by 12, 7 by 4.

### Phase 4: multi-table and pre-actions
- **Implemented:** one to four tables in any format mix, focus queue, per-table timers, per-table bet buttons, all pre-actions including custom raise sizes, keyboard shortcuts with a focus grace period.
- **Tested:** independence of four tables, simultaneous prompts, every pre-action rule, stale pre-action rejection, hotkeys only on the focused table.
- **Browser:** four mixed-format tables driven by clicking the real buttons for several hundred hands.

### Phase 5: cash, tournaments, career
- **Implemented:** full lobbies, blind schedules by hands or minutes, antes, payouts, re-entries, balancing, final table, ledger-backed bankroll, achievements, trophies, levels, local leaderboard, refresh recovery.
- **Tested:** complete events to a single winner with chips conserved after every round, prizes summing exactly to the pool, balancing invariants over 500 random fields, ledger integrity, tampering and corruption handling.
- **Failed and fixed:**
  - After resuming a saved session, replacement bot IDs could collide with a seated bot, which would have frozen that table.
  - **A refresh could undo a hand's chips.** The hand record was saved when the hand ended, but the session snapshot only after the pause before the next hand. A refresh in that gap kept the hand in the history while reverting its result, so a loss could be undone. Found by reconciling stored hands against the bankroll in the browser. Each hand, its effect on the stacks and the totals are now one atomic transaction.
  - The same audit found three more non-atomic pairs, all now one transaction: buy-in and snapshot (a crash could lose chips), cash-out and snapshot (a crash could pay twice), and top-up and snapshot. A tournament entry was also lost if the page closed during the countdown: it is now refunded on the next load.
- **Browser:** after a wipe, refreshes were triggered at the exact moment a hand ended, and each returned to the recovery prompt with the hand kept. Stored hands, session hands and career hands all matched, and chips on the table minus chips invested equalled the sum of hand results.

### Phase 6: HUD, history, coach
- **Implemented:** configurable HUD, replay with timeline, filters, hand-by-hand review, equity calculator (hand and range, exact and Monte Carlo), leak finder, training recommendations.
- **Tested:** every statistic's denominator, null rather than 0 on empty samples, hidden cards stay hidden in replay and coach, leak confidence rules, difficulty advice ignoring short lucky runs.

### Phase 7: audio, animation, customisation
- **Implemented:** synthesised sound with five volume controls, generated ambience, four animation speeds, felt, card, chip and avatar options.
- **Verified:** animations are pure CSS driven by engine events, and turning them off changes no results. Reduced-motion and forced-colours preferences are respected.
- **Not verified by ear:** a real click in the production build unlocked the audio context (state `running`) and sound nodes started with no errors, but no one has listened to it. Levels and character may want tuning.

### Phase 8: quality
- **Final run:** see "Final test run" below.
- **Palette:** the validator rejected the first profit and loss colours (green and red, deuteranopia separation 5.5 against a floor of 8). They are now blue and orange, and passed.

## Requirement status

| Part | Requirement | Status |
|---|---|---|
| 1 | Modular architecture, engine independent of UI | Done |
| 2 | Premium dark casino look, card dominance, betting controls | Done |
| 2.5 | Desktop, laptop, tablet and adapted mobile layouts | Done |
| 3 | Complete engine, evaluator, betting, blinds, side pots | Done, tested |
| 3.6 | Dealer animations reflecting engine events | Done |
| 4 | Four tables, per-table format and settings, active highlighting | Done, tested |
| 5 | Pre-actions with all rules | Done, tested |
| 6 | AI engine: archetypes, attributes, decisions, timing, tilt, adaptation, chat | Done, tested |
| 7 | Timers, urgent warning, safe default, time bank | Done, tested |
| 8 | Cash and tournament infrastructure, balancing, final table | Done, tested |
| 9 | Persistent career, ledger, milestones, local leaderboard | Done, tested |
| 10 | Configurable HUD from observed hands | Done, tested |
| 11 | Hand history, replay, filters | Done, tested |
| 12 | Coach, equity, statistics, leak finder, training | Done, tested |
| 13 | Difficulty 1-10 with no card manipulation | Done, measured |
| 14 | Audio and animations with controls | Done; audio not checked by ear |
| 15 | Navigation, settings, session dashboard | Done |
| 16 | Testing | See below |
| 17 | Performance, worker for equity | Done; see limitations |
| 18 | Data validation, no real money | Done, tested |

## Known limitations

- **Moving button:** the button always moves one active seat clockwise. This is simpler than a full dead-button rule, so blinds can repeat for a player when a table shrinks to heads-up.
- **Tournaments are single-entry for the hero's table:** you play one table per tournament while the rest of the field plays through the real engine. Playing several tournaments at once is not supported. Four simultaneous tables are a cash-game feature.
- **Hand pacing in tournaments:** other tables play one hand per hand at your table, not on independent clocks.
- **Refresh during a hand:** the hand is void and stacks return to the last completed hand. This protects the ledger, but it does mean a refresh can undo a hand in progress. That is acceptable for a single-player simulator with no real money.
- **AI is not a solver:** decisions are estimates with heuristics. "GTO-inspired" is a style label only.
- **Coach ranges are estimates:** a verdict can be wrong when the modelled range is wrong. The review says what was estimated.
- **Leak thresholds are guidelines:** the "typical winner" ranges are broad rules of thumb, not measured from a population.
- **Local storage only:** clearing browser data erases the career. The leaderboard is simulated and local.
- **Accessibility:** cards, controls and charts carry labels and there is keyboard play, but it has not been audited with a screen reader.

## Not verified

- **Audio by ear:** see Phase 7.
- **`play.cmd`:** not run, because it opens your default browser. The server it starts (`tools/serve-dist.mjs`) was used for all production-build testing.
- **Screen reader use:** labels are in place and tested, but no screen reader audit was done.
- **Real touch devices:** phone layouts were tested in an emulated 375x812 viewport, not on a physical phone.
- **Full-ring tables at phone size:** the card overlap check was re-run on 6-seat tables after the fix. Nine-seat tables move by the same rule but were not re-sampled.
- **Long-run calibration:** AI statistics come from simulated bot-only play. Nobody has played thousands of hands against them yet.

## What is next

- Listen to the audio and tune the levels.
- Multi-tournament play, if wanted.
- An online leaderboard would need a real backend with server-authoritative state.

## Final test run

Run on 2026-11-06, on the code as delivered:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | No errors |
| `npm test` | 260 tests in 14 files, all passing |
| `npm run test:slow` | All 133,784,560 seven-card hands match the published counts |
| `npm run build` | Succeeds: 500 kB JavaScript (155 kB gzipped), with the coach in its own worker chunk |
| Browser console | No errors in the final production-build sessions |

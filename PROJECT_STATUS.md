# Project status: online accounts and separate bankrolls

Deployed to https://connell-adams.github.io/Obsidian_Poker/ on 2026-11-07 (merged to `main`). Supabase project `tiejpuwqwuaankwofcez`: database migration applied, `poker` Edge Function deployed.

## Architecture

| Piece | Runs on | Job |
|---|---|---|
| Game frontend | GitHub Pages | Everything you see, plus all offline play against bots |
| Accounts | Supabase Auth | Sign-up, sign-in, password reset. Passwords never touch this code |
| Online data | Supabase PostgreSQL | Profiles, online wallets, ledgers, statistics, rooms, hands |
| Live updates | Supabase Realtime | Table changes and who is connected |
| Game server | Supabase Edge Function `poker` | Shuffles, deals, validates every action, settles pots |

**Why it is safe:**
- The browser only holds the public (publishable) key. Row Level Security lets each player read only their own wallet, ledger and cards, and they cannot write any online chip value.
- Every online chip movement happens inside database functions that only the Edge Function may call. Each one locks the wallet, refuses overdrafts and refuses a reused request reference, all in one transaction.
- Game progress is written with a version check, so two simultaneous actions can never both apply.
- A hand is settled only if the chips before and after match exactly.
- Decks live in a table no client role can read. Hole cards are readable only by their owner, and stored hand histories have unshown cards removed.
- If the backend is unreachable, the online sections say so and offline play carries on unaffected.

## Stages

| # | Stage | Status |
|---|---|---|
| 1 | Inspect existing bankroll and multiplayer | Done. There was **no** existing multiplayer or room system, so it was built new |
| 2 | Design separate online and offline bankrolls | Done |
| 3 | Offline chip controls | Done and tested |
| 4 | Online bankroll and bankruptcy reset rules | Done and tested against real PostgreSQL |
| 5 | Separate lifetime P/L for each mode | Done and tested |
| 6 | Authentication and cloud persistence | Done and tested live: two real accounts signed up, confirmed by email and signed in; the same balance and history load on a second browser |
| 7 | Online multiplayer with accounts | Done and tested live: two real accounts played each other on the deployed site |
| 8 | Server-authoritative chip transactions | Done and tested against real PostgreSQL |
| 9 | GitHub Pages deployment | Done: the public URL loads, connects to Supabase, no console errors |
| 10 | Test on the deployed site | Done, including a live bankruptcy reset |

**The game is online.** On 2026-11-07 two separate real accounts (test2 and test3) joined rooms by code on the deployed site and played each other, including an all-in showdown, and cashed out with correct balances.

## Rules as built

**Online chips**
- New accounts start with exactly 25,000, recorded as the first ledger entry.
- They change only through buy-ins, top-ups and cash-outs in rooms against real players.
- **Bankrupt** means the balance is below the 400-chip minimum online buy-in *and* no chips are sitting at any table. Only then does the server allow **RESET TO 25,000 CHIPS**. It sets the balance to exactly 25,000, is logged as `bankruptcy_reset`, and never changes lifetime P/L. A second reset is refused because the balance is no longer bankrupt.
- Lifetime P/L counts completed sessions: cash-out minus everything bought in at that table.

**Offline chips**
- Add, remove or reset freely: presets of 1,000 to 1,000,000, or any custom amount up to 100,000,000 at a time.
- None of these count toward P/L. Removing cannot go below zero.
- Lifetime P/L counts completed sessions only: cash-out minus buy-ins, or prize minus entries.
- Profiles saved by the previous version are upgraded with an estimate: bankroll change minus old free reloads.
- When signed in, a copy of the offline balance is saved to the account. Another device can choose to use it, and that is recorded as an adjustment, never as profit.

**Rooms**
- Create a private room, then share its 6-character code or invite link.
- Join with online chips only. Offline chips can never be used.
- The player list shows who is connected. Reconnecting just reopens the room: state lives on the server.
- Every player gets the same turn clock. A player who runs out is checked or folded, and two misses in a row sits them out.
- Leaving mid-hand folds the seat when its turn comes and cashes it out when the hand ends.
- Online tournaments are not implemented: rooms are cash games. The results table for them exists.

## Tests

| Suite | What it proves | Result |
|---|---|---|
| `tests/online/database.test.ts` | Runs the real migration on PostgreSQL 18 (PGlite) with Supabase's roles. Players cannot write chips or call server-only functions. They see only their own wallet, ledger and cards, and no one can read a deck. Plus reused references, overdrafts, version conflicts, chip conservation and reset eligibility | 17 passing |
| `tests/online/server.test.ts` | The real game server against that database. Two accounts play 25 hands with total chips checked after every action. Two simultaneous identical actions let exactly one through. Also out-of-turn and illegal moves, timeouts, leaving mid-hand, and hidden cards stripped from stored hands | 11 passing |
| `tests/career.test.ts` | Offline add, remove and reset, P/L from completed sessions only, and the profile upgrade | passing |
| Everything else | The existing engine, AI, tournaments, persistence and UI | passing |
| **Total** | | **294 passing** |

**Browser check, without a backend:** add, remove and reset offline chips, with P/L unchanged and all three in the transaction list. The online sections show "not connected", and offline play is unaffected.

**Live test on the deployed site, 2026-11-07**, with two real accounts in two browsers:
- Sign-up with email confirmation and sign-in work. Each account started with 25,000 online chips and a "Starting chips" ledger entry.
- Three rooms were played across the two accounts: create, join by code, automatic dealing, realtime updates, presence dots, folds, an all-in showdown and run-out, and cash-out.
- Chips were conserved after every hand, and the two wallets together still total exactly 50,000.
- test2's wallet, ledger and P/L match by hand: 25,000 − 2,000 + 4,000 − 2,000 + 1,830 − 2,000 = 24,830, and lifetime P/L is −170 over 3 sessions (1 won, 2 lost).
- Offline chips stayed at 25,000 throughout, so online play never touches them.
- Private cards: from test2's browser, every `hand_private` row readable belongs to test2, `room_secrets` is refused, public table events carry no card values, and the stored hand won by a fold hides both hands while the showdown hand shows them.
- The second browser (the in-app browser pane) loaded the same account with the same balance and history, which covers cross-device sync.

**Live bankruptcy test, 2026-11-07**, in a 100/200 room:
- test2 bought in for 24,500, leaving 330 in the wallet. Calling the reset directly while those chips were seated was refused with `not_bankrupt`.
- test3 lost its whole stack in all-in hands, leaving 0 seated and 0 in the wallet. The Bankroll page showed YOU'RE BROKE!, and RESET TO 25,000 CHIPS worked once.
- test3's ledger shows "Bankruptcy reset +25,000". Its lifetime P/L stayed at −24,800, exactly the opposite of test2's +24,800, so the reset was not counted as winnings.
- Balances: test2 has 49,800 (25,000 + 24,800) and test3 has 25,200 (25,000 − 24,800 + 25,000 reset). Together that's 75,000: the original 50,000 plus one reset, with no chips created or lost.
- A player who left mid-hand was folded out and lost only the blind already posted, as designed.

**Bugs found and fixed live:**
- A host who had left their own room stayed stuck on that table, with no seat and no buttons, even after a reload, because a host can still read the room. The room screen now returns to the lobby whenever you have no seat (commit e6c1fc7).
- After a player left, the others still saw them seated from the last hand. Between hands, players who have left are now cleared from the table (commit f6f8bfb).

**Not tested live yet:**
- Password reset by email.
- GitHub sign-in, which is off until an OAuth app is created.

## Files added

- `supabase/migrations/20261107000000_online.sql`: schema, Row Level Security policies and chip functions.
- `supabase/functions/poker/`: the Edge Function. `core.bundle.js` is generated with `npm run build:edge`.
- `src/online/`: client service, room connection, protocol, and the server core.
- `src/ui/screens/`: `BankrollScreen`, `AccountScreen`, `OnlineScreen` and `CloudSync`.
- `tests/online/`: the PGlite harness, database tests and server tests.

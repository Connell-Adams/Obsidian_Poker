# Project status: online accounts and separate bankrolls

Branch: `online-accounts` (not yet merged or deployed; the live site still runs the previous version).

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
| 6 | Authentication and cloud persistence | Code done. **Waiting for your Supabase project** |
| 7 | Online multiplayer with accounts | Code done, server tested with two accounts. **Not yet run live** |
| 8 | Server-authoritative chip transactions | Done and tested against real PostgreSQL |
| 9 | GitHub Pages deployment | Workflow exists. Needs the Supabase URL and key, then a merge to `main` |
| 10 | Test on the deployed site | **Not started** |

**The game is not fully online yet.** That needs two real accounts to connect and play each other on the deployed site.

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
| **Total** | | **292 passing** |

**Browser check, without a backend:** add, remove and reset offline chips, with P/L unchanged and all three in the transaction list. The online sections show "not connected", and offline play is unaffected.

**Not tested yet**, because it needs your Supabase project:
- Sign-up, email confirmation, sign-in, sign-out and password reset against real Supabase Auth.
- The Edge Function wrapper `supabase/functions/poker/index.ts`. The game logic it calls is tested, but the wrapper itself has never run.
- Realtime updates, presence and reconnecting.
- Two real accounts playing on the deployed site.

## What you need to do

See the setup steps at the end of the latest chat message. In short:
1. Create a Supabase project.
2. Run the SQL file.
3. Set the redirect URLs.
4. Send the project URL and publishable key.
5. Run `npx supabase login` so the game server can be deployed.

## Files added

- `supabase/migrations/20261107000000_online.sql`: schema, Row Level Security policies and chip functions.
- `supabase/functions/poker/`: the Edge Function. `core.bundle.js` is generated with `npm run build:edge`.
- `src/online/`: client service, room connection, protocol, and the server core.
- `src/ui/screens/`: `BankrollScreen`, `AccountScreen`, `OnlineScreen` and `CloudSync`.
- `tests/online/`: the PGlite harness, database tests and server tests.

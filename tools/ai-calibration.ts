/**
 * Plays many bot-only hands and prints per-archetype statistics. Used to check that
 * personalities behave as intended and that higher skill actually wins chips.
 * Run: node tools/run-ts.mjs tools/ai-calibration.ts
 */
import { BotBrain } from '../src/ai/brain';
import { ARCHETYPES, type Archetype, createBotProfile } from '../src/ai/profiles';
import { buildPublicView } from '../src/ai/view';
import { SeededRng } from '../src/engine/rng';
import { PokerTable } from '../src/engine/table';
import { buildHandRecord } from '../src/history/record';
import { addCounters, emptyCounters, ObservedStats, publishStats, type StatCounters } from '../src/stats/counters';

const pct = (r: { value: number | null }) => (r.value === null ? '  - ' : (r.value * 100).toFixed(0).padStart(3) + '%');

function playSession(seed: string, archetypes: Archetype[], difficulties: number[], hands: number, totals: Map<string, StatCounters>, keyOf: (i: number) => string) {
  const rng = new SeededRng(seed);
  const table = new PokerTable({ maxSeats: archetypes.length, smallBlind: 5, bigBlind: 10, rng });
  const observed = new ObservedStats();
  const brains = archetypes.map((archetype, i) => {
    const profile = createBotProfile({ id: `b${i}`, difficulty: difficulties[i], rng, archetype, name: `Bot${i}` });
    table.sit(i, { id: profile.id, name: profile.name, stack: 1000 });
    return new BotBrain(profile, new SeededRng(`${seed}-${i}`));
  });
  for (let h = 0; h < hands; h++) {
    for (let i = 0; i < archetypes.length; i++) {
      const seat = table.seats[i]!;
      if (seat.stack < 400) seat.stack = 1000; // the top-up is not counted in net, which comes from each hand
      if (seat.stack > 2500) seat.stack = 1000;
    }
    const hand = table.startHand();
    let guard = 0;
    while (!hand.isComplete) {
      if (++guard > 200) throw new Error('Runaway hand');
      const seat = hand.actorSeat!;
      const brain = brains[seat];
      const view = buildPublicView(hand, seat);
      const d = brain.decide(view, (id) => observed.get(id));
      const r = hand.act(seat, d.action);
      if (!r.ok) throw new Error(`Illegal bot action ${JSON.stringify(d.action)}: ${r.error}`);
    }
    const record = buildHandRecord(hand, { id: `${seed}-${h}`, sessionId: seed, tableId: 't', tableName: 't', mode: 'cash', maxSeats: archetypes.length, heroId: null, now: 0 });
    observed.addRecord(record);
    for (const p of record.players) {
      brains[p.seat].observeHand({ netBB: p.net / record.bb, stackFraction: p.net / p.startStack, badBeat: record.badBeatSeats.includes(p.seat), wonShowdown: record.wentToShowdown && p.net > 0 });
    }
    table.settleHand();
  }
  for (let i = 0; i < archetypes.length; i++) {
    const c = observed.get(`b${i}`);
    if (!c) continue;
    const key = keyOf(i);
    const total = totals.get(key) ?? emptyCounters();
    addCounters(total, c);
    totals.set(key, total);
  }
}

const header = 'name                 hands  VPIP  PFR  3B  F3B  CB  FCB  AFq WTSD W$SD  bb/100';
function print(totals: Map<string, StatCounters>) {
  console.log(header);
  const rows = [...totals.entries()].sort((a, b) => (publishStats(b[1]).bb100.value ?? 0) - (publishStats(a[1]).bb100.value ?? 0));
  for (const [key, c] of rows) {
    const s = publishStats(c);
    console.log(
      `${key.padEnd(20)} ${String(s.hands).padStart(5)} ${pct(s.vpip)} ${pct(s.pfr)} ${pct(s.threeBet)} ${pct(s.foldTo3Bet)} ${pct(s.cbet)} ${pct(s.foldToCbet)} ${pct(s.afq)} ${pct(s.wtsd)} ${pct(s.wsd)} ${(s.bb100.value ?? 0).toFixed(1).padStart(7)}`,
    );
  }
}

const started = Date.now();
console.log('--- All archetypes, mid difficulty, 6-max rotation ---');
const byArchetype = new Map<string, StatCounters>();
const master = new SeededRng('rotation');
for (let session = 0; session < 24; session++) {
  const line: Archetype[] = [];
  for (let i = 0; i < 6; i++) line.push(ARCHETYPES[master.int(ARCHETYPES.length)]);
  playSession(`arch-${session}`, line, line.map(() => 5), 400, byArchetype, (i) => line[i]);
}
print(byArchetype);

console.log('\n--- Difficulty ladder: same style (ABC/TAG), mixed difficulty 6-max ---');
const byDifficulty = new Map<string, StatCounters>();
for (let session = 0; session < 18; session++) {
  const diffs = [1, 3, 5, 7, 9, 10];
  const offset = session % 6;
  const rotated = diffs.map((_, i) => diffs[(i + offset) % 6]);
  const line = rotated.map(() => 'tag' as Archetype);
  playSession(`diff-${session}`, line, rotated, 400, byDifficulty, (i) => `difficulty ${rotated[i]}`);
}
print(byDifficulty);
console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);

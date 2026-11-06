/**
 * Head-to-head check that difficulty means something: low versus high difficulty
 * with mirrored styles, so only decision quality differs.
 * Run: node tools/run-ts.mjs tools/ai-ladder.ts
 */
import { BotBrain } from '../src/ai/brain';
import { type Archetype, createBotProfile } from '../src/ai/profiles';
import { buildPublicView } from '../src/ai/view';
import { SeededRng } from '../src/engine/rng';
import { PokerTable } from '../src/engine/table';
import { buildHandRecord } from '../src/history/record';
import { ObservedStats } from '../src/stats/counters';

function match(seed: string, archetype: Archetype, low: number, high: number, hands: number): { high: number; low: number } {
  const rng = new SeededRng(seed);
  const table = new PokerTable({ maxSeats: 6, smallBlind: 5, bigBlind: 10, rng });
  const observed = new ObservedStats();
  const diffs = [low, high, low, high, low, high];
  const brains = diffs.map((difficulty, i) => {
    const profile = createBotProfile({ id: `b${i}`, difficulty, rng, archetype, name: `B${i}` });
    table.sit(i, { id: profile.id, name: profile.name, stack: 1000 });
    return new BotBrain(profile, new SeededRng(`${seed}-${i}`));
  });
  const nets = [0, 0, 0, 0, 0, 0];
  for (let h = 0; h < hands; h++) {
    for (let i = 0; i < 6; i++) table.seats[i]!.stack = 1000;
    const hand = table.startHand();
    while (!hand.isComplete) {
      const seat = hand.actorSeat!;
      const d = brains[seat].decide(buildPublicView(hand, seat), (id) => observed.get(id));
      const r = hand.act(seat, d.action);
      if (!r.ok) throw new Error(r.error);
    }
    const record = buildHandRecord(hand, { id: `${h}`, sessionId: seed, tableId: 't', tableName: 't', mode: 'cash', maxSeats: 6, heroId: null, now: 0 });
    observed.addRecord(record);
    for (const p of record.players) {
      nets[p.seat] += p.net;
      brains[p.seat].observeHand({ netBB: p.net / 10, stackFraction: p.net / p.startStack, badBeat: record.badBeatSeats.includes(p.seat), wonShowdown: false });
    }
    table.settleHand();
  }
  return { low: (nets[0] + nets[2] + nets[4]) / 10, high: (nets[1] + nets[3] + nets[5]) / 10 };
}

const pairs: Array<[number, number]> = [[1, 10], [3, 10], [5, 10], [3, 7], [7, 10]];
for (const [low, high] of pairs) {
  let lowBB = 0;
  let total = 0;
  for (const arch of ['tag', 'abc', 'lag', 'gto_reg'] as Archetype[]) {
    for (let s = 0; s < 6; s++) {
      const r = match(`${low}-${high}-${arch}-${s}`, arch, low, high, 400);
      lowBB += r.low;
      total += 400 * 3;
    }
  }
  console.log(`difficulty ${high} vs ${low}: high side wins ${(((-lowBB) / total) * 100).toFixed(1)} bb/100 per seat over ${total} seat-hands`);
}

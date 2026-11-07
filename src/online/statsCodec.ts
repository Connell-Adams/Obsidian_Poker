import { emptyCounters, type PositionCounters, type StatCounters } from '../stats/counters';

/**
 * Online statistics are stored as one flat JSON object of numbers so the database
 * can add a hand's counters to the totals in a single statement.
 */
export function flattenCounters(c: StatCounters): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(c)) {
    if (key === 'byPosition') continue;
    if (typeof value === 'number' && value !== 0) out[key] = value;
  }
  for (const [pos, counters] of Object.entries(c.byPosition)) {
    for (const [field, value] of Object.entries(counters)) {
      if (value !== 0) out[`pos.${pos}.${field}`] = value;
    }
  }
  return out;
}

export function unflattenCounters(flat: Record<string, unknown> | null | undefined): StatCounters {
  const c = emptyCounters();
  if (!flat) return c;
  for (const [key, raw] of Object.entries(flat)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (key.startsWith('pos.')) {
      const [, pos, field] = key.split('.');
      const target = (c.byPosition[pos] ??= { hands: 0, decisions: 0, vpip: 0, pfr: 0, net: 0, bbNet: 0 });
      if (field in target) target[field as keyof PositionCounters] = value;
    } else if (key in c && key !== 'byPosition') {
      (c as unknown as Record<string, number>)[key] = value;
    }
  }
  return c;
}

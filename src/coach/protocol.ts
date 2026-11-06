import type { AllInEquity, HandRecord } from '../history/record';
import type { StatCounters } from '../stats/counters';
import type { HandReview } from './analyzer';
import type { EquityQuery, EquityQueryResult } from './equityQuery';

export type CoachRequest =
  | { kind: 'review'; requestId: number; record: HandRecord; counters: Array<[string, StatCounters]>; iterations: number }
  | { kind: 'equity'; requestId: number; query: EquityQuery };

export type CoachResponse =
  | { kind: 'review'; requestId: number; review: HandReview | null; allInEquity?: AllInEquity[] }
  | { kind: 'equity'; requestId: number; result: EquityQueryResult }
  | { kind: 'error'; requestId: number; error: string };

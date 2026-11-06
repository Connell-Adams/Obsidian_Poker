/// <reference lib="webworker" />
import { SeededRng } from '../engine/rng';
import { computeAllInEquity } from './allIn';
import { reviewHand } from './analyzer';
import { runEquityQuery } from './equityQuery';
import type { CoachRequest, CoachResponse } from './protocol';

const rng = new SeededRng(Date.now());

self.onmessage = (event: MessageEvent<CoachRequest>) => {
  const message = event.data;
  let response: CoachResponse;
  try {
    if (message.kind === 'review') {
      const counters = new Map(message.counters);
      const review = reviewHand(message.record, { iterations: message.iterations, rng, countersOf: (id) => counters.get(id) });
      const allInEquity = computeAllInEquity(message.record, rng);
      response = { kind: 'review', requestId: message.requestId, review, allInEquity };
    } else {
      response = { kind: 'equity', requestId: message.requestId, result: runEquityQuery(message.query, rng) };
    }
  } catch (error) {
    response = { kind: 'error', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
};

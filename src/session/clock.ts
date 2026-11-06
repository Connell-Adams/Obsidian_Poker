/** Time abstraction so controllers can be driven deterministically in tests. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/** Virtual clock for tests: `advance` fires due timers in order. */
export class FakeClock implements Clock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  get pending(): number {
    return this.timers.size;
  }

  /** Advances time, firing each due timer. Timers scheduled meanwhile also fire if due. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= end && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId < 0) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.time = Math.max(this.time, timer.at);
      timer.fn();
    }
    this.time = end;
  }

  /** Runs until `done` returns true, stepping time. Throws if it never does. */
  runUntil(done: () => boolean, stepMs = 100, maxMs = 3_600_000): void {
    let elapsed = 0;
    while (!done()) {
      if (elapsed >= maxMs) throw new Error('FakeClock.runUntil timed out');
      this.advance(stepMs);
      elapsed += stepMs;
    }
  }
}

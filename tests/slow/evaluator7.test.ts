import { expect, it } from 'vitest';
import { categoryOf, scoreHand } from '../../src/engine/evaluator';

/** Walks all 133,784,560 seven-card hands and checks the published frequencies. */
it('produces the known category counts for every seven-card hand', () => {
  const counts = new Array(10).fill(0);
  const h = new Int32Array(7);
  for (h[0] = 0; h[0] < 46; h[0]++)
    for (h[1] = h[0] + 1; h[1] < 47; h[1]++)
      for (h[2] = h[1] + 1; h[2] < 48; h[2]++)
        for (h[3] = h[2] + 1; h[3] < 49; h[3]++)
          for (h[4] = h[3] + 1; h[4] < 50; h[4]++)
            for (h[5] = h[4] + 1; h[5] < 51; h[5]++)
              for (h[6] = h[5] + 1; h[6] < 52; h[6]++) counts[categoryOf(scoreHand(h, 7))]++;
  expect(counts).toEqual([23294460, 58627800, 31433400, 6461620, 6180020, 4047644, 3473184, 224848, 37260, 4324]);
});

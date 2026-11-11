/**
 * @fileoverview Pins `expectLinearCost` (`tests/helpers.ts`), the ladder every
 * linear-time test is built on: it fails a scan whose cost grows with the
 * square of its input and passes a linear one, and it samples each size only
 * as often as that size's checks need.
 * @module tests/helpers.test
 */

import { describe, expect, it } from 'vitest';
import { expectLinearCost } from './helpers.js';

const build = (size: number) => 'x'.repeat(size);

/** Spends `ms` of this thread's CPU. */
function burn(ms: number): void {
  const start = process.threadCpuUsage();
  let used: NodeJS.CpuUsage;
  do used = process.threadCpuUsage(start);
  while ((used.user + used.system) / 1000 < ms);
}

describe('expectLinearCost', () => {
  it('fails a scan whose cost grows with the square of its input, on the ratio', async () => {
    // (size / 100)² steps: ~2,500 at 5k, ~10M at 320k, so every size stays inside the budget.
    const quadratic = (input: string) => {
      let sum = 0;
      for (let i = 0; i < input.length; i += 100) {
        for (let j = 0; j < input.length; j += 100) sum += input.charCodeAt(j);
      }
      return sum;
    };
    await expect(expectLinearCost(build, quadratic)).rejects.toThrow(
      /ms at 320000 characters, [\d.]+ ms at 5000: expected [\d.]+ to be less than 256/,
    );
  });

  it('passes a scan whose cost grows with its input', async () => {
    const linear = (input: string) => {
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input.charCodeAt(i);
      return sum;
    };
    await expect(expectLinearCost(build, linear)).resolves.toBeUndefined();
  });

  it('takes three samples at the smallest size and stops above it at the first that passes', async () => {
    // Each call spends the 5 ms floor, so every sample is one call.
    const calls = new Map<number, number>();
    await expectLinearCost(build, (input) => {
      calls.set(input.length, (calls.get(input.length) ?? 0) + 1);
      burn(5);
    });
    expect([...calls]).toEqual([
      [5_000, 3],
      [10_000, 1],
      [20_000, 1],
      [40_000, 1],
      [80_000, 1],
      [160_000, 1],
      [320_000, 1],
    ]);
  });

  it('keeps sampling a size whose first sample overruns the budget', async () => {
    // At 10k the first call spends 1,050 ms, past the 1,000 ms budget, and every later call 0.1 ms.
    const calls = new Map<number, number>();
    await expect(
      expectLinearCost(build, (input) => {
        const call = (calls.get(input.length) ?? 0) + 1;
        calls.set(input.length, call);
        burn(input.length === 10_000 && call === 1 ? 1_050 : 0.1);
      }),
    ).resolves.toBeUndefined();
    expect(calls.get(10_000)).toBeGreaterThan(1);
  });

  it('keeps sampling the largest size while its ratio fails', async () => {
    /**
     * At 320k the first call spends 60 ms, ~600× the 5k cost, and every later
     * call 1 ms: the first sample fails the ratio, the second (five calls at
     * the 5 ms floor) passes it, and sampling stops there.
     */
    const calls = new Map<number, number>();
    await expectLinearCost(build, (input) => {
      const call = (calls.get(input.length) ?? 0) + 1;
      calls.set(input.length, call);
      burn(input.length === 5_000 ? 0.1 : input.length === 320_000 && call === 1 ? 60 : 1);
    });
    expect(calls.get(320_000)).toBe(6);
  });
});

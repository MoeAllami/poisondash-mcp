import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mapLimit, DEFAULT_CONCURRENCY } from "../../src/concurrency.js";

describe("mapLimit", () => {
  test("preserves input order regardless of completion order", async () => {
    const result = await mapLimit([5, 1, 3], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    assert.deepEqual(result, ["0:5", "1:1", "2:3"]);
  });

  test("never exceeds the requested concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    assert.ok(peak <= 4, `peak concurrency was ${peak}, expected <= 4`);
  });

  test("processes every item even when the list far exceeds the limit", async () => {
    const seen: number[] = [];
    await mapLimit(Array.from({ length: 200 }, (_, i) => i), DEFAULT_CONCURRENCY, async (n) => {
      seen.push(n);
    });
    assert.equal(seen.length, 200);
    assert.equal(new Set(seen).size, 200);
  });

  test("an empty list resolves to an empty array without spawning workers", async () => {
    assert.deepEqual(await mapLimit([], 8, async () => "never"), []);
  });

  test("a rejection propagates to the caller", async () => {
    await assert.rejects(
      () => mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
      /boom/
    );
  });
});

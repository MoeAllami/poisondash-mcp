/**
 * Bounded-concurrency map.
 *
 * Several tools fan out one request per row of a listing -- uploader lookups
 * in list_pending_datasets (up to 500) and per-experiment fetches in
 * compare_experiments (up to 40). An unbounded Promise.all opens all of them
 * at once, which is enough to saturate a single-worker dev backend and turn a
 * listing into a self-inflicted outage. Results stay in input order.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/** Default ceiling for per-row fan-out against a local single-process backend. */
export const DEFAULT_CONCURRENCY = 8;

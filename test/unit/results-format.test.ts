import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseResults, formatResultsSummary } from "../../src/tools/results-format.js";
import { formatThreshold } from "../../src/json.js";

describe("parseResults", () => {
  test("parses a well-formed results_json string", () => {
    const parsed = parseResults(JSON.stringify({ summary: { status: "completed" } }));
    assert.equal(parsed.summary?.status, "completed");
  });

  test("returns {} for null/undefined/empty input", () => {
    assert.deepEqual(parseResults(null), {});
    assert.deepEqual(parseResults(undefined), {});
    assert.deepEqual(parseResults(""), {});
  });

  test("returns {} rather than throwing on malformed JSON", () => {
    assert.deepEqual(parseResults("{not valid json"), {});
  });
});

describe("formatResultsSummary", () => {
  test("full shape renders status, counts, detection rate, threshold, features, runtime", () => {
    const lines = formatResultsSummary({
      summary: {
        status: "completed",
        total_samples: 35,
        clean_count: 15,
        suspect_count: 20,
        poisoned_count: 4,
        avg_score: 0.31,
        score_distribution: [1, 2, 3, 4, 5, 3, 1, 0, 1, 0],
        threshold: 0.5,
      },
      important_features: { count: 12, indices: [0, 1, 2] },
      total_scored_samples: 20,
      metadata: {
        runtime_seconds: 42.7,
        device: "cpu",
        threshold_method: "kmeans",
      },
    });
    const text = lines.join("\n");
    assert.match(text, /Status: completed/);
    assert.match(text, /Scored suspect samples: 20 \(clean reference set: 15\)/);
    assert.match(text, /Predicted poisoned.*4 \/ 20 \(detection rate 20\.0%\)/);
    assert.match(text, /Avg poisoning score: 0\.310/);
    assert.match(text, /Threshold method: kmeans \| Threshold: 0\.5/);
    assert.match(text, /Important features: 12 identified/);
    assert.match(text, /Runtime: 42\.7s on cpu/);
  });

  test("stub shape (failed run) surfaces status + log tail without crashing on missing fields", () => {
    const lines = formatResultsSummary({
      summary: { status: "failed" },
      metadata: { log_tail: ["starting", "RuntimeError: oom"] },
    });
    const text = lines.join("\n");
    assert.match(text, /Status: failed/);
    assert.match(text, /Log tail:/);
    assert.match(text, /RuntimeError: oom/);
    // No crash even though poisoned_count/avg_score/etc are absent.
    assert.doesNotMatch(text, /Predicted poisoned/);
  });

  test("completely empty results object reports no summary available", () => {
    const lines = formatResultsSummary({});
    assert.match(lines.join("\n"), /No results summary available yet/);
  });

  test("does not divide by zero when scored count is 0", () => {
    const lines = formatResultsSummary({
      summary: { status: "completed", suspect_count: 0, poisoned_count: 0 },
      total_scored_samples: 0,
    });
    assert.doesNotMatch(lines.join("\n"), /NaN/);
  });
});

describe("threshold formatting", () => {
  test("a derived threshold is rounded to a readable precision", () => {
    // kmeans and gaussian derive the threshold from the data, so it arrives at
    // full float precision -- a real run produced 0.5090393198284318.
    const lines = formatResultsSummary({
      summary: { status: "completed", suspect_count: 200, poisoned_count: 105, threshold: 0.5090393198284318 },
      metadata: { threshold_method: "kmeans" },
    });
    const line = lines.find((l) => l.includes("Threshold:"))!;
    assert.match(line, /Threshold: 0\.509$/);
    assert.doesNotMatch(line, /0\.5090393198284318/);
  });

  test("a manual threshold keeps its plain form", () => {
    const lines = formatResultsSummary({
      summary: { status: "completed", suspect_count: 10, poisoned_count: 1, threshold: 0.5 },
      metadata: { threshold_method: "manual" },
    });
    assert.match(lines.find((l) => l.includes("Threshold:"))!, /Threshold: 0\.5$/);
  });
});

describe("threshold formatting never collapses to an endpoint", () => {
  test("a tiny threshold keeps its magnitude", () => {
    // The schema allows any value in [0, 1]. Rounding 0.00001 to "0" would
    // label a line whose counts were computed against the real value.
    assert.equal(formatThreshold(0.00001), "0.00001");
  });

  test("a near-one threshold does not read as 1", () => {
    assert.equal(formatThreshold(0.99999), "0.99999");
  });

  test("genuine endpoints still print plainly", () => {
    assert.equal(formatThreshold(0), "0");
    assert.equal(formatThreshold(1), "1");
  });

  test("a derived threshold is shortened", () => {
    assert.equal(formatThreshold(0.5090393198284318), "0.509");
  });

  test("a manual threshold is unchanged", () => {
    assert.equal(formatThreshold(0.5), "0.5");
    assert.equal(formatThreshold(0.7), "0.7");
  });
});

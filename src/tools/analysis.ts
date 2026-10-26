import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { z } from "zod";
import { apiFetch, apiFetchRaw } from "../client.js";
import { config } from "../config.js";
import { formatThreshold } from "../json.js";
import { registerTool, textResult, errorResult } from "./registry.js";
import { parseResults } from "./results-format.js";
import type { ExperimentResultsResponse, SampleImageResponse } from "../types.js";

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

registerTool({
  name: "analyze_score_distribution",
  description:
    "Compute summary statistics over an experiment's per-sample poisoning scores: " +
    "mean, median, std, min, max, quartiles, and counts above fixed cutoffs (0.3, " +
    "0.5, 0.7) plus a chosen threshold. per_sample_scores covers only the suspect " +
    "set with no clean/suspect ground-truth label, so these statistics describe the " +
    "suspect score population only -- a clean-vs-suspect separation isn't computable " +
    "from this data. Useful for tuning the detection threshold.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    experiment_id: z.number().int(),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Threshold to report the above/below split for; defaults to the experiment's stored threshold"),
  }),
  handler: async (args) => {
    const { experiment_id, threshold: thresholdArg } = args as {
      experiment_id: number;
      threshold?: number;
    };
    const data = await apiFetch<ExperimentResultsResponse>(`/api/experiments/${experiment_id}/results`);
    const parsed = parseResults(data.results_json);
    const scores = (parsed.per_sample_scores ?? []).map((s) => s.score);

    if (scores.length === 0) {
      return errorResult(
        `Experiment #${experiment_id} has no per-sample scores to analyze (status: ${data.status}).`
      );
    }

    const threshold = thresholdArg ?? parsed.summary?.threshold ?? 0.5;
    const sorted = [...scores].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const median = quantile(sorted, 0.5);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);

    const countAbove = (cutoff: number) => scores.filter((s) => s >= cutoff).length;

    const lines = [
      `Experiment #${experiment_id}: ${n} suspect samples scored`,
      `Mean: ${mean.toFixed(4)}  Median: ${median.toFixed(4)}  Std: ${std.toFixed(4)}`,
      `Min: ${sorted[0].toFixed(4)}  Q1: ${q1.toFixed(4)}  Q3: ${q3.toFixed(4)}  Max: ${sorted[n - 1].toFixed(4)}`,
      "",
      `>= 0.3: ${countAbove(0.3)} (${((countAbove(0.3) / n) * 100).toFixed(1)}%)`,
      `>= 0.5: ${countAbove(0.5)} (${((countAbove(0.5) / n) * 100).toFixed(1)}%)`,
      `>= 0.7: ${countAbove(0.7)} (${((countAbove(0.7) / n) * 100).toFixed(1)}%)`,
      `>= ${formatThreshold(threshold)} (${thresholdArg !== undefined ? "requested" : "stored"} threshold): ${countAbove(threshold)} (${((countAbove(threshold) / n) * 100).toFixed(1)}%)`,
    ];

    return textResult(lines.join("\n"));
  },
});

registerTool({
  name: "get_sample_image",
  description:
    "Fetch a single sample from an experiment's suspect dataset as a PNG image, for " +
    "visually inspecting a flagged sample.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  schema: z.object({
    experiment_id: z.number().int(),
    sample_index: z.number().int().min(0),
  }),
  handler: async (args) => {
    const { experiment_id, sample_index } = args as { experiment_id: number; sample_index: number };
    const data = await apiFetch<SampleImageResponse>(`/api/experiments/${experiment_id}/sample/${sample_index}`);
    return {
      content: [
        { type: "text", text: `Sample ${data.sample_index} (${data.width}x${data.height}):` },
        { type: "image", data: data.image, mimeType: "image/png" },
      ],
    };
  },
});

function escapesBase(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/**
 * Resolve a user-supplied output path against `baseDir`, refusing anything
 * that escapes it.
 *
 * A lexical `path.relative` check alone is not enough: a symlink (or, on
 * Windows, a directory junction) inside the base directory can point anywhere,
 * so `base/link/file.npz` passes a string comparison while writing outside the
 * base. The real containment check therefore walks up to the deepest component
 * that already exists, resolves it with realpath, and verifies *that* is inside
 * the real base -- so only directories we have confirmed to be inside the base
 * are ever created or written to.
 *
 * `baseDir` is a parameter (rather than reading config.outputDir directly) so
 * the guard is unit-testable without depending on the frozen config singleton.
 */
export async function resolveOutputPath(
  baseDir: string,
  outputPath: string | undefined,
  defaultName: string
): Promise<string> {
  const base = path.resolve(baseDir);
  const candidate = outputPath
    ? path.isAbsolute(outputPath)
      ? path.resolve(outputPath)
      : path.resolve(base, outputPath)
    : path.resolve(base, defaultName);

  const refuse = (resolved: string): never => {
    throw new Error(
      `Refusing to write outside POISONDASH_OUTPUT_DIR (${base}). Resolved path was: ${resolved}`
    );
  };

  await fs.mkdir(base, { recursive: true });
  const realBase = await fs.realpath(base);

  // Cheap lexical rejection first: "../" traversal and absolute paths pointing
  // elsewhere never need a filesystem probe. `rel === ""` means the candidate
  // is the base directory itself, which is not a file we can write. The
  // candidate may be spelled against either the configured base or its real
  // path -- they differ under a symlinked base, or a Windows 8.3 short name
  // such as C:\Users\RUNNER~1 -- so it only has to sit inside one of them.
  // This is a fast path, not the guard: the realpath check below decides.
  const lexicallyInside = (root: string) =>
    path.relative(root, candidate) !== "" && !escapesBase(root, candidate);
  if (!lexicallyInside(base) && !lexicallyInside(realBase)) {
    refuse(candidate);
  }

  // Walk up from the intended parent to the nearest component that exists.
  // Everything below it will be created by us, so it cannot already be a link.
  const missing: string[] = [];
  let probe = path.dirname(candidate);
  for (;;) {
    try {
      await fs.stat(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        refuse(candidate);
      }
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }

  const realProbe = await fs.realpath(probe);
  if (realProbe !== realBase && escapesBase(realBase, realProbe)) {
    refuse(realProbe);
  }

  const realParent = path.join(realProbe, ...missing);
  await fs.mkdir(realParent, { recursive: true });
  return path.join(realParent, path.basename(candidate));
}

registerTool({
  name: "get_sanitized_dataset",
  description:
    "Download the experiment's suspect dataset with flagged poisoned samples removed, " +
    "as a .npz file suitable for re-training. Requires the experiment to be completed " +
    "with per-sample scores present. The saved file always lands inside " +
    "POISONDASH_OUTPUT_DIR (the user's Downloads folder by default) -- output_path is " +
    "resolved relative to that directory and any attempt to escape it, including via a " +
    "symlink, is refused. Won't overwrite an existing file unless overwrite=true.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  schema: z.object({
    experiment_id: z.number().int(),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Override the poisoning-score threshold; defaults to the experiment's stored threshold"),
    output_path: z
      .string()
      .optional()
      .describe("Where to save the file, relative to POISONDASH_OUTPUT_DIR (or an absolute path inside it)"),
    overwrite: z.boolean().default(false),
  }),
  handler: async (args) => {
    const { experiment_id, threshold, output_path, overwrite } = args as {
      experiment_id: number;
      threshold?: number;
      output_path?: string;
      overwrite: boolean;
    };

    let destination: string;
    try {
      destination = await resolveOutputPath(
        config.outputDir,
        output_path,
        `experiment_${experiment_id}_sanitized.npz`
      );
    } catch (err) {
      return errorResult((err as Error).message);
    }

    // Reserve the destination with an exclusive create before spending a
    // download on it. This both fails fast and closes the gap between an
    // existence check and the write, where a file could appear in between.
    let reserved = false;
    if (!overwrite) {
      try {
        const handle = await fs.open(destination, "wx");
        await handle.close();
        reserved = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          return errorResult(
            `${destination} already exists. Pass overwrite=true to replace it, or choose a different output_path.`
          );
        }
        return errorResult(`Cannot write to ${destination}: ${(err as Error).message}`);
      }
    }

    const cleanupReservation = async () => {
      if (reserved) await fs.unlink(destination).catch(() => {});
    };

    let response: Response;
    try {
      response = await apiFetchRaw(`/api/experiments/${experiment_id}/sanitized-dataset`, {
        query: { threshold },
      });
    } catch (err) {
      await cleanupReservation();
      throw err;
    }

    if (!response.body) {
      await cleanupReservation();
      return errorResult("The backend returned an empty response body for the sanitized dataset.");
    }

    // Stream to a sibling temp file, then rename into place. A sanitized export
    // can legitimately reach gigabytes (1 GB per-user quota, 5 GB system cap),
    // so buffering the whole body in memory would take the server down; the
    // rename also means an interrupted download never replaces a good file.
    //
    // The temp name is randomised and created with "wx" rather than "w".
    // A predictable name opened with "w" is a hole: the open follows symlinks,
    // so anything able to pre-create <destination>.part as a link writes
    // through to the link's target -- outside the directory the guard above
    // just confirmed -- and the rename then leaves the destination as that
    // link. "wx" maps to O_CREAT|O_EXCL, which refuses to follow a symlink and
    // fails outright if the name already exists.
    const temporary = `${destination}.${randomBytes(6).toString("hex")}.part`;
    try {
      const handle = await fs.open(temporary, "wx");
      try {
        await pipeline(Readable.fromWeb(response.body as ReadableStream), handle.createWriteStream());
      } finally {
        await handle.close().catch(() => {});
      }
      await fs.rename(temporary, destination);
    } catch (err) {
      await fs.unlink(temporary).catch(() => {});
      await cleanupReservation();
      return errorResult(`Failed to save the sanitized dataset: ${(err as Error).message}`);
    }

    const { size } = await fs.stat(destination);
    const original = response.headers.get("X-Original-Sample-Count");
    const removed = response.headers.get("X-Removed-Sample-Count");
    const kept = response.headers.get("X-Kept-Sample-Count");
    const effectiveThreshold = response.headers.get("X-Threshold");

    return textResult(
      [
        `Saved sanitized dataset to ${destination} (${size} bytes)`,
        `Original samples: ${original ?? "?"}`,
        `Removed (score >= threshold): ${removed ?? "?"}`,
        `Kept: ${kept ?? "?"}`,
        `Effective threshold: ${effectiveThreshold ?? "?"}`,
      ].join("\n")
    );
  },
});

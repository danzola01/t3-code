// @effect-diagnostics nodeBuiltinImport:off - exercises native transcript append and replacement semantics.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { parseGeminiRecord, geminiUsageFormat } from "@t3tools/provider-gemini/server/usage";
import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";
import { decodeScanCache, dedupeWithinFile, encodeScanCache } from "./usageScanCache.ts";
import {
  cacheSavingsUsd,
  createOverrideRateTable,
  parseRateTable,
  priceUsage,
} from "./usagePricing.ts";

let dir: string;
beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-usage-"));
});
afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

const message = (id = "response-one", output = 30) => ({
  id,
  type: "gemini",
  model: "gemini-2.5-pro",
  timestamp: "2026-10-08T12:00:00Z",
  content: "conversation content is not needed for accounting",
  tokens: { input: 100, cached: 40, output, thoughts: 20, tool: 10, total: 160 },
});
const line = (value: unknown) => JSON.stringify(value) + "\n";

describe("Gemini native usage", () => {
  it("normalizes cached, tool-use and thinking tokens without counting reasoning twice", () => {
    const [record] = parseGeminiRecord(message(), "native-session");
    expect(record).toMatchObject({
      provider: "gemini",
      sessionId: "native-session",
      model: "gemini-2.5-pro",
      totals: {
        uncachedInputTokens: 70,
        cachedInputTokens: 40,
        cacheCreationTokens: 0,
        outputTokens: 50,
        reasoningTokens: 20,
      },
    });
    expect(parseGeminiRecord({ ...message(), tokens: null }, "session")).toEqual([]);
    expect(parseGeminiRecord({ ...message(), model: "" }, "session")).toEqual([]);
    expect(parseGeminiRecord({ ...message(), timestamp: "bad" }, "session")).toEqual([]);
  });

  it("reads legacy JSON and current JSONL identically while projecting out message content", async () => {
    const legacy = NodePath.join(dir, "session-legacy.json");
    const current = NodePath.join(dir, "session-current.jsonl");
    await NodeFSP.writeFile(
      legacy,
      JSON.stringify({ sessionId: "native-session", messages: [message()] }, null, 2),
    );
    await NodeFSP.writeFile(current, line({ sessionId: "native-session" }) + line(message()));
    const old = await readTranscriptRecords(legacy, geminiUsageFormat);
    const fresh = await readTranscriptRecords(current, geminiUsageFormat, undefined, {
      streamingThresholdBytes: 16,
    });
    expect(old?.records).toEqual(fresh?.records);
    expect(old?.records).toHaveLength(1);
    expect(fresh?.records[0]?.sessionId).toBe("native-session");
  });

  it("resumes appends with native session identity and replaces repeated message snapshots", async () => {
    const file = NodePath.join(dir, "session.jsonl");
    await NodeFSP.writeFile(file, line({ sessionId: "native-session" }) + line(message()));
    const first = await readTranscriptRecords(file, geminiUsageFormat);
    expect(first).not.toBeNull();
    const saved = decodeScanCache(
      encodeScanCache(
        new Map([
          [
            file,
            {
              provider: "gemini",
              size: (await NodeFSP.stat(file)).size,
              mtimeMs: 1,
              records: first!.records,
              tailRecords: first!.tailRecords,
              malformedRecords: first!.malformedRecords,
              position: first!.position,
            },
          ],
        ]),
      ),
      new Map([["gemini", geminiUsageFormat]]),
    );
    expect(saved.get(file)?.position.state).toEqual({ sessionId: "native-session" });
    await NodeFSP.appendFile(
      file,
      line(message("response-one", 80)) + line(message("response-two")),
    );
    const appended = await readTranscriptRecords(
      file,
      geminiUsageFormat,
      saved.get(file)?.position,
    );
    expect(appended?.resumed).toBe(true);
    const records = dedupeWithinFile([...first!.records, ...appended!.records]);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.sessionId === "native-session")).toBe(true);
    expect(records[0]?.totals.outputTokens).toBe(100);
  });

  it("retains historical records from the previous fork cache layout", async () => {
    const file = NodePath.join(dir, "session.jsonl");
    await NodeFSP.writeFile(file, line({ sessionId: "native-session" }) + line(message()));
    const first = await readTranscriptRecords(file, geminiUsageFormat);
    expect(first).not.toBeNull();
    const current = encodeScanCache(
      new Map([
        [
          file,
          {
            provider: "gemini",
            size: (await NodeFSP.stat(file)).size,
            mtimeMs: 1,
            records: first!.records,
            tailRecords: first!.tailRecords,
            malformedRecords: first!.malformedRecords,
            position: first!.position,
          },
        ],
      ]),
    );
    const previous = {
      ...current,
      files: { [file]: { ...current.files[file]!, cs: null, gs: "native-session" } },
    };
    const saved = decodeScanCache(previous, new Map([["gemini", geminiUsageFormat]]));
    expect(saved.get(file)?.records).toEqual(first!.records);
    await NodeFSP.appendFile(file, line(message("response-two")));
    const refreshed = await readTranscriptRecords(
      file,
      geminiUsageFormat,
      saved.get(file)?.position,
    );
    expect(refreshed?.resumed).toBe(false);
    expect(refreshed?.records).toHaveLength(2);
    expect(refreshed?.records.every((record) => record.sessionId === "native-session")).toBe(true);
  });

  it("handles partial tails, rewinds, and metadata snapshots without losing consumed usage", async () => {
    const file = NodePath.join(dir, "session.jsonl");
    const tail = line(message("response-two"));
    await NodeFSP.writeFile(
      file,
      line({ sessionId: "session" }) + line(message()) + tail.slice(0, -12),
    );
    const first = await readTranscriptRecords(file, geminiUsageFormat);
    expect(first?.records).toHaveLength(1);
    expect(first?.tailRecords).toHaveLength(0);
    await NodeFSP.appendFile(file, tail.slice(-12) + line({ $set: { messages: [message()] } }));
    const appended = await readTranscriptRecords(file, geminiUsageFormat, first!.position);
    expect(dedupeWithinFile([...first!.records, ...appended!.records])).toHaveLength(2);
    await NodeFSP.writeFile(file, line({ sessionId: "replaced" }) + line(message("replacement")));
    const replaced = await readTranscriptRecords(file, geminiUsageFormat, appended!.position);
    expect(replaced?.resumed).toBe(false);
    expect(replaced?.records[0]?.sessionId).toBe("replaced");
  });

  it("discovers main and subagent chat histories and ignores logs and tool artifacts", async () => {
    for (const relative of [
      "project/chats/session-main.jsonl",
      "project/chats/session-old.json",
      "project/chats/parent/subagent-id.jsonl",
      "project/logs/session-main.jsonl",
      "project/tool-outputs/response.json",
    ]) {
      const file = NodePath.join(dir, relative);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, line(message()));
    }
    expect(
      (await listTranscriptFiles(dir, 0, { acceptsFile: geminiUsageFormat.acceptsFile })).files
        .map((file) => NodePath.relative(dir, file.path))
        .sort(),
    ).toEqual([
      "project/chats/parent/subagent-id.jsonl",
      "project/chats/session-main.jsonl",
      "project/chats/session-old.json",
    ]);
  });

  it("keeps consumed 0.64 usage through content patches, removals and rewinds", async () => {
    // Source format: Gemini v0.64.0 ChatRecordingService and chatRecordingTypes.
    const native = await NodeFSP.readFile(
      new URL("./fixtures/gemini-0.64-session.jsonl", import.meta.url),
      "utf8",
    );
    const file = NodePath.join(dir, "session.jsonl");
    const split = native.indexOf('{"$patch"');
    await NodeFSP.writeFile(file, native.slice(0, split));
    const initial = await readTranscriptRecords(file, geminiUsageFormat);
    expect(initial).not.toBeNull();
    await NodeFSP.appendFile(file, native.slice(split));
    const appended = await readTranscriptRecords(file, geminiUsageFormat, initial!.position, {
      streamingThresholdBytes: 16,
    });
    expect(appended?.resumed).toBe(true);
    const incremental = dedupeWithinFile([...initial!.records, ...appended!.records]);
    const cold = await readTranscriptRecords(file, geminiUsageFormat, undefined, {
      streamingThresholdBytes: 16,
    });
    expect(incremental).toEqual(dedupeWithinFile(cold!.records));
    expect(
      incremental.map((record) => ({ sessionId: record.sessionId, totals: record.totals })),
    ).toEqual([
      {
        sessionId: "gemini-064-fixture",
        totals: {
          uncachedInputTokens: 70,
          cachedInputTokens: 40,
          cacheCreationTokens: 0,
          outputTokens: 50,
          reasoningTokens: 20,
        },
      },
      {
        sessionId: "gemini-064-fixture",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 100,
          cacheCreationTokens: 0,
          outputTokens: 50,
          reasoningTokens: 10,
        },
      },
    ]);
  });

  it("uses per-response long-context rates at the 200k boundary and respects overrides", () => {
    const rates = parseRateTable({
      "gemini-2.5-pro": {
        input_cost_per_token: 1.25e-6,
        output_cost_per_token: 10e-6,
        cache_read_input_token_cost: 0.125e-6,
        input_cost_per_token_above_200k_tokens: 2.5e-6,
        output_cost_per_token_above_200k_tokens: 15e-6,
        cache_read_input_token_cost_above_200k_tokens: 0.25e-6,
      },
    });
    const [native] = parseGeminiRecord(message(), "session");
    const record = {
      ...native!,
      totals: { ...native!.totals, uncachedInputTokens: 100_000, cachedInputTokens: 100_000 },
    };
    expect(priceUsage(rates, record).costUsd).toBeCloseTo(0.1375 + 50 * 10e-6);
    const long = { ...record, totals: { ...record.totals, uncachedInputTokens: 100_001 } };
    expect(priceUsage(rates, long).costUsd).toBeCloseTo(0.2750025 + 50 * 15e-6);
    expect(cacheSavingsUsd(rates, long)).toBeCloseTo(0.225);
    const overrides = createOverrideRateTable({
      "gemini-2.5-pro": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 },
    });
    expect(priceUsage(rates, long, overrides).costUsd).toBeCloseTo(0.200001 + 50 * 2e-6);
    expect(priceUsage(rates, { ...record, model: "gemini-unknown" }).costSource).toBe("unpriced");
  });
});

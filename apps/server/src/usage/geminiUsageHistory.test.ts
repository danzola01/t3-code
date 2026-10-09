// @effect-diagnostics nodeBuiltinImport:off - exercises native transcript append and replacement semantics.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { parseGeminiRecord } from "./usageTranscripts.ts";
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
    const old = await readTranscriptRecords(legacy, "gemini");
    const fresh = await readTranscriptRecords(current, "gemini", undefined, {
      streamingThresholdBytes: 16,
    });
    expect(old?.records).toEqual(fresh?.records);
    expect(old?.records).toHaveLength(1);
    expect(fresh?.records[0]?.sessionId).toBe("native-session");
  });

  it("resumes appends with native session identity and replaces repeated message snapshots", async () => {
    const file = NodePath.join(dir, "session.jsonl");
    await NodeFSP.writeFile(file, line({ sessionId: "native-session" }) + line(message()));
    const first = await readTranscriptRecords(file, "gemini");
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
              position: first!.position,
            },
          ],
        ]),
      ),
    );
    expect(saved.get(file)?.position.geminiSessionId).toBe("native-session");
    await NodeFSP.appendFile(
      file,
      line(message("response-one", 80)) + line(message("response-two")),
    );
    const appended = await readTranscriptRecords(file, "gemini", saved.get(file)?.position);
    expect(appended?.resumed).toBe(true);
    const records = dedupeWithinFile([...first!.records, ...appended!.records]);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.sessionId === "native-session")).toBe(true);
    expect(records[0]?.totals.outputTokens).toBe(100);
  });

  it("handles partial tails, rewinds, and metadata snapshots without losing consumed usage", async () => {
    const file = NodePath.join(dir, "session.jsonl");
    const tail = line(message("response-two"));
    await NodeFSP.writeFile(
      file,
      line({ sessionId: "session" }) + line(message()) + tail.slice(0, -12),
    );
    const first = await readTranscriptRecords(file, "gemini");
    expect(first?.records).toHaveLength(1);
    expect(first?.tailRecords).toHaveLength(0);
    await NodeFSP.appendFile(file, tail.slice(-12) + line({ $set: { messages: [message()] } }));
    const appended = await readTranscriptRecords(file, "gemini", first!.position);
    expect(dedupeWithinFile([...first!.records, ...appended!.records])).toHaveLength(2);
    await NodeFSP.writeFile(file, line({ sessionId: "replaced" }) + line(message("replacement")));
    const replaced = await readTranscriptRecords(file, "gemini", appended!.position);
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
      (await listTranscriptFiles(dir, 0, { gemini: true }))
        .map((file) => NodePath.relative(dir, file.path))
        .sort(),
    ).toEqual([
      "project/chats/parent/subagent-id.jsonl",
      "project/chats/session-main.jsonl",
      "project/chats/session-old.json",
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

import type { GeminiSettings, UsageTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  tokenCount as int,
  parseTimestampMs,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import { resolveGeminiConfigDir, resolveGeminiRuntimeDir } from "./GeminiHome.ts";

/** Native Gemini message snapshots; repeated IDs replace earlier token snapshots. */
export function parseGeminiRecord(value: unknown, sessionId: string): readonly UsageRecord[] {
  if (!Predicate.isObject(value)) return [];
  const nativeSession = typeof value.sessionId === "string" ? value.sessionId : sessionId;
  if (Array.isArray(value.messages)) {
    return value.messages.flatMap((message) => parseGeminiRecord(message, nativeSession));
  }
  if (Predicate.isObject(value.$set) && Array.isArray(value.$set.messages)) {
    return value.$set.messages.flatMap((message) => parseGeminiRecord(message, nativeSession));
  }
  if (
    value.type !== "gemini" ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    typeof value.id !== "string" ||
    !Predicate.isObject(value.tokens)
  )
    return [];
  const timestampMs = parseTimestampMs(value.timestamp);
  if (timestampMs === null) return [];
  const input = int(value.tokens.input);
  const cached = Math.min(input, int(value.tokens.cached));
  const thoughts = int(value.tokens.thoughts);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: input - cached + int(value.tokens.tool),
    cachedInputTokens: cached,
    cacheCreationTokens: 0,
    outputTokens: int(value.tokens.output) + thoughts,
    reasoningTokens: thoughts,
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "gemini",
      timestampMs,
      model: value.model.trim(),
      sessionId: nativeSession,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `gemini:${value.id}`,
    },
  ];
}

interface GeminiUsageState {
  sessionId: string;
}
const messageFields = { id: true, type: true, timestamp: true, model: true, tokens: true } as const;
export const geminiUsageFormat: TranscriptUsageFormat<GeminiUsageState> = {
  selectFields: {
    ...messageFields,
    sessionId: true,
    messages: messageFields,
    $set: { sessionId: true, messages: messageFields },
  },
  usageMarkers: ['"tokens"', '"sessionId"'],
  state: {
    initial: () => ({ sessionId: "" }),
    schema: Schema.Struct({ sessionId: Schema.String }),
  },
  parseLine: (line, state) => {
    try {
      return geminiUsageFormat.parseProjected(JSON.parse(line), state);
    } catch {
      return [];
    }
  },
  parseProjected: (value, state) => {
    if (Predicate.isObject(value)) {
      const metadata = Predicate.isObject(value.$set) ? value.$set : value;
      if (typeof metadata.sessionId === "string") state.sessionId = metadata.sessionId;
    }
    return parseGeminiRecord(value, state.sessionId);
  },
  acceptsFile: (relativePath) =>
    relativePath.split(/[\\/]/u).includes("chats") && /\.jsonl?$/u.test(relativePath),
  newestFilesFirst: true,
  documentExtensions: [".json"],
  replacesRepeatedRecords: true,
  sharedSessionsAcrossFiles: true,
};

export const geminiUsageReader: ProviderUsageReader<GeminiSettings, Path.Path> = {
  kind: "transcripts",
  provider: "gemini",
  format: geminiUsageFormat,
  directories: Effect.fn("geminiUsageReader.directories")(function* (instance) {
    if (!instance.config || !instance.configured) return [];
    const path = yield* Path.Path;
    const runtimeDir = yield* resolveGeminiRuntimeDir(instance.config, instance.environment);
    const configDir = yield* resolveGeminiConfigDir(instance.config, instance.environment);
    // Older CLI versions kept history in the config directory, including under Seatbelt.
    return [...new Set([runtimeDir, configDir])].map((directory) => ({
      dir: path.join(directory, "tmp"),
    }));
  }),
};

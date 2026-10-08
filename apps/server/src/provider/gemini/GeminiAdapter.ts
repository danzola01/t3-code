import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import {
  type GeminiSettings,
  type ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";
import { makeProviderFailure } from "../../orchestration-v2/ProviderFailure.ts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { UsageService } from "../../usage/UsageService.ts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { ServerConfig } from "../../config.ts";
import { IdAllocatorV2 } from "../../orchestration-v2/IdAllocator.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
} from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import {
  applyGeminiAcpModelSelection,
  currentGeminiModelIdFromSessionSetup,
  makeGeminiAcpRuntime,
  resolveGeminiAcpBaseModelId,
} from "./GeminiAcpSupport.ts";
import { geminiApprovalOptions, geminiPermissionOptionId } from "./GeminiPermissions.ts";
import { expandGeminiCustomCommand, expandGeminiSkillMentions } from "./GeminiCatalog.ts";
const decodeUnknownJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const GeminiPromptQuota = Schema.Struct({
  quota: Schema.Struct({
    token_count: Schema.Struct({
      input_tokens: Schema.Number,
      output_tokens: Schema.Number,
    }),
    model_usage: Schema.Array(
      Schema.Struct({
        model: Schema.String,
        token_count: Schema.Struct({
          input_tokens: Schema.Number,
          output_tokens: Schema.Number,
        }),
      }),
    ),
  }),
});
const decodeGeminiPromptQuota = Schema.decodeUnknownOption(GeminiPromptQuota);

interface GeminiMcpToolIdentity {
  readonly server: string;
  readonly tool: string;
}

const GEMINI_UPDATE_TOPIC_TITLE_PATTERN = /^Update topic to: "(?<title>.+)"$/u;

function geminiThreadTitleFromTopicToolCall(toolCall: AcpToolCallState): string | undefined {
  const match = GEMINI_UPDATE_TOPIC_TITLE_PATTERN.exec(toolCall.title ?? "");
  return match?.groups?.title?.trim() || undefined;
}

function parseGeminiMcpToolTitle(
  title: string | null | undefined,
): GeminiMcpToolIdentity | undefined {
  const match = /^(?<tool>.+) \((?<server>.+) MCP Server\)$/u.exec(title ?? "");
  const tool = match?.groups?.tool?.trim();
  const server = match?.groups?.server?.trim();
  return tool && server ? { server, tool } : undefined;
}

function textFromAcpToolContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const entryValue of value) {
    if (!isRecord(entryValue) || entryValue.type !== "content") {
      continue;
    }
    const content = isRecord(entryValue.content) ? entryValue.content : undefined;
    const text = typeof content?.text === "string" ? content.text.trim() : "";
    if (content?.type === "text" && text.length > 0) {
      chunks.push(text);
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function geminiMcpArguments(rawInput: unknown, content: unknown): unknown | undefined {
  if (rawInput !== undefined) {
    return rawInput;
  }
  const text = textFromAcpToolContent(content);
  return text ? Option.getOrUndefined(decodeUnknownJsonString(text)) : undefined;
}

export function normalizeGeminiMcpToolCall(
  toolCall: AcpToolCallState,
  rememberedArguments?: unknown,
): AcpToolCallState {
  const identity = parseGeminiMcpToolTitle(toolCall.title);
  if (!identity) {
    return toolCall;
  }

  const { content, initialContent, rawInput, rawOutput, ...retainedData } = toolCall.data;
  const inferredArguments = geminiMcpArguments(rawInput, initialContent ?? content);
  const argumentsValue =
    rememberedArguments !== undefined ? rememberedArguments : inferredArguments;
  const terminal = toolCall.status === "completed" || toolCall.status === "failed";
  const outputText = terminal ? textFromAcpToolContent(content) : undefined;
  const result =
    rawOutput !== undefined
      ? rawOutput
      : outputText
        ? { content: [{ type: "text", text: outputText }] }
        : undefined;

  return {
    ...toolCall,
    itemType: "mcp_tool_call",
    data: {
      ...retainedData,
      item: {
        type: "mcpToolCall",
        id: toolCall.toolCallId,
        server: identity.server,
        tool: identity.tool,
        ...(toolCall.status ? { status: toolCall.status } : {}),
        ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
        ...(result !== undefined ? { result } : {}),
      },
    },
  };
}

export function usageFromGeminiPromptResponse(response: EffectAcpSchema.PromptResponse) {
  if (response.usage) return response.usage;
  const meta = Option.getOrUndefined(decodeGeminiPromptQuota(response._meta));
  if (!meta) return undefined;
  const inputTokens = Math.max(0, Math.trunc(meta.quota.token_count.input_tokens));
  const outputTokens = Math.max(0, Math.trunc(meta.quota.token_count.output_tokens));
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  } satisfies EffectAcpSchema.Usage;
}

export function modelUsageFromGeminiPromptResponse(response: EffectAcpSchema.PromptResponse) {
  const meta = Option.getOrUndefined(decodeGeminiPromptQuota(response._meta));
  if (!meta) return undefined;
  return Object.fromEntries(
    meta.quota.model_usage.map((usage) => [
      usage.model,
      {
        inputTokens: Math.max(0, Math.trunc(usage.token_count.input_tokens)),
        outputTokens: Math.max(0, Math.trunc(usage.token_count.output_tokens)),
      },
    ]),
  );
}

export const makeGeminiAdapter = Effect.fn("makeGeminiAdapter")(function* (
  settings: GeminiSettings,
  options: {
    readonly instanceId: ProviderInstanceId;
    readonly nativeEventLogger?: EventNdjsonLogger | undefined;
    readonly environment: NodeJS.ProcessEnv;
    readonly onAvailableCommands?: (
      commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
      cwd: string,
    ) => Effect.Effect<void>;
    readonly onSessionStarted?: (started: AcpSessionRuntimeStartResult) => Effect.Effect<void>;
  },
) {
  const usageService = yield* UsageService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const idAllocator = yield* IdAllocatorV2;
  const serverConfig = yield* ServerConfig;
  const selfInvocation = yield* resolveSelfInvocation();
  const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    crypto,
    fileSystem,
    idAllocator,
    serverConfig,
    selfInvocation,
    nativeLogging: (threadId) =>
      makeNativeLogger({
        provider: ProviderDriverKind.make("gemini"),
        threadId,
        nativeEventLogger: options.nativeEventLogger,
      }),
    flavor: {
      driver: ProviderDriverKind.make("gemini"),
      runtimeHarness: "Gemini",
      interruptPromptOnCancel: false,
      promptFailure: (cause) =>
        makeProviderFailure({
          cause,
          ...(Schema.is(EffectAcpErrors.AcpRequestError)(cause)
            ? {
                message: /no capacity available|model is overloaded/iu.test(cause.errorMessage)
                  ? "Gemini is temporarily out of capacity. T3 Code retried the request, but the model is still unavailable. Try again shortly or choose another model."
                  : cause.errorMessage,
              }
            : {}),
          class: "provider_error",
        }),
      prepareMessage: ({ text, cwd }) =>
        Effect.gen(function* () {
          const expanded = yield* expandGeminiCustomCommand(
            settings,
            cwd,
            text,
            options.environment,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
          const prepared = yield* expandGeminiSkillMentions(
            settings,
            cwd,
            expanded.text,
            options.environment,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
          return { text: prepared, resources: expanded.resources };
        }),
      promptSettlement: (response, metadata) =>
        Effect.gen(function* () {
          const usage = usageFromGeminiPromptResponse(response);
          if (
            !usage ||
            !Number.isSafeInteger(usage.inputTokens) ||
            !Number.isSafeInteger(usage.outputTokens)
          )
            return undefined;
          const costUsd = yield* usageService.priceGeminiTurn(
            modelUsageFromGeminiPromptResponse(response) ?? {},
          );
          const previous = metadata?.geminiUsage;
          const totals = {
            inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
            outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
            costUsd:
              costUsd === null || previous?.costUsd === null
                ? null
                : (previous?.costUsd ?? 0) + costUsd,
          };
          const cost = (value: number | null) =>
            value === null
              ? ""
              : ` · ${value < 0.01 ? `$${value.toFixed(6)}` : formatUsd(value)} API estimate`;
          return {
            usage: {
              usageStatus: "complete" as const,
              usageScope: "main_agent" as const,
              hasSubagents: false,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            },
            metadata: { ...metadata, geminiUsage: totals },
            summary: `Gemini used ${formatTokens(usage.inputTokens + usage.outputTokens)} tokens${cost(costUsd)} · thread ${formatTokens(totals.inputTokens + totals.outputTokens)}${cost(totals.costUsd)}`,
          };
        }),
      capabilities: {
        ...AcpProviderCapabilitiesV2,
        tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
      },
      normalizeToolCall: normalizeGeminiMcpToolCall,
      approvalOptions: geminiApprovalOptions,
      permissionOptionId: geminiPermissionOptionId,
      supportsImagePrompts: true,
      supportsCompaction: true,
      resolveModelId: (selection) => resolveGeminiAcpBaseModelId(selection.model),
      applyModelSelection: ({ runtime, startResult, modelSelection }) =>
        applyGeminiAcpModelSelection({
          runtime:
            startResult.initializeResult.protocolVersion === 1
              ? runtime
              : { setSessionModel: (model) => runtime.setModel(model).pipe(Effect.as({})) },
          currentModelId: currentGeminiModelIdFromSessionSetup(startResult.sessionSetupResult),
          requestedModelId: resolveGeminiAcpBaseModelId(modelSelection.model),
          mapError: (cause) => cause,
        }),
      makeRuntime: (input) =>
        Effect.gen(function* () {
          const runtime = yield* makeGeminiAcpRuntime({
            ...input,
            geminiSettings: settings,
            environment: { ...options.environment, ...input.processEnvironment },
            childProcessSpawner,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
          return {
            ...runtime,
            start: () =>
              runtime
                .start()
                .pipe(Effect.tap((started) => options.onSessionStarted?.(started) ?? Effect.void)),
            handleSessionUpdate: (handler) =>
              runtime.handleSessionUpdate((notification) =>
                Effect.gen(function* () {
                  if (notification.update.sessionUpdate === "available_commands_update")
                    yield* (
                      options.onAvailableCommands?.(
                        notification.update.availableCommands,
                        input.cwd,
                      ) ?? Effect.void
                    );
                  const tool = notification.update;
                  if (
                    tool.sessionUpdate === "tool_call" ||
                    tool.sessionUpdate === "tool_call_update"
                  ) {
                    const title = geminiThreadTitleFromTopicToolCall({
                      toolCallId: tool.toolCallId,
                      ...(tool.title ? { title: tool.title } : {}),
                      data: {},
                    });
                    if (title)
                      yield* handler({
                        sessionId: notification.sessionId,
                        update: { sessionUpdate: "session_info_update", title },
                      });
                  }
                  yield* handler(notification);
                }),
              ),
            prompt: (request) =>
              Effect.gen(function* () {
                const response = yield* runtime.prompt(request).pipe(
                  Effect.retry({
                    times: 2,
                    while: (error) =>
                      /no capacity available|model is overloaded/iu.test(error.message),
                    schedule: Schedule.spaced("1 second"),
                  }),
                );
                const usage = usageFromGeminiPromptResponse(response);
                return { ...response, ...(usage ? { usage } : {}) };
              }),
          };
        }),
    },
  });
});

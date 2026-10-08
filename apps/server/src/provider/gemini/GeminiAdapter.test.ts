import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  GeminiSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  ProjectId,
  MessageId,
  RunId,
  RunAttemptId,
  NodeId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import { UsageService } from "../../usage/UsageService.ts";
import { ServerConfig } from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2Event,
} from "../../orchestration-v2/ProviderAdapter.ts";
import {
  makeGeminiAdapter,
  normalizeGeminiMcpToolCall,
  usageFromGeminiPromptResponse,
} from "./GeminiAdapter.ts";
function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
  readonly ordinal?: number;
  readonly modelSelection?: ModelSelection;
  /** agent+provider marks a post-settle continuation attach (drains wakeBuffer). */
  readonly messageCreatedBy?: "user" | "agent";
  readonly messageCreationSource?: "web" | "mobile" | "mcp" | "provider" | "server";
  readonly messageText?: string;
}): ProviderAdapterV2TurnInput {
  const ordinal = input.ordinal ?? 1;
  const suffix = `${input.threadId}:${ordinal}`;
  const modelSelection =
    input.modelSelection ?? ({ instanceId: input.instanceId, model: "default" } as const);
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "ACP adapter test",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: input.messageText ?? "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
}

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "gemini-v2-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(
    Layer.succeed(UsageService, {
      readSummary: () => Effect.die("unused"),
      refreshRates: Effect.die("unused"),
      priceGeminiTurn: () => Effect.succeed(null),
    }),
  ),
);
it.layer(layer)("GeminiAdapter V2", (it) => {
  it.effect("runs a prompt through the shared ACP V2 adapter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-v2-" });
      const instanceId = ProviderInstanceId.make("gemini-test");
      const threadId = ThreadId.make("gemini-thread");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        cwd,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const modelSelection = { instanceId, model: "composer-2" };
      const adapter = yield* makeGeminiAdapter(
        yield* Schema.decodeEffect(GeminiSettings)({
          binaryPath: process.execPath,
          launchArgs: JSON.stringify(
            NodeURL.fileURLToPath(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
          ),
          authMethod: "oauth-personal",
          homePath: cwd,
        }),
        {
          instanceId,
          environment: {
            ...process.env,
            GEMINI_CLI_TRUST_WORKSPACE: "true",
            T3_ACP_EMIT_GEMINI_USAGE: "1",
          },
        },
      );
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("gemini-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const events: ProviderAdapterV2Event[] = [];
      const settled = yield* Deferred.make<void>();
      yield* Stream.runForEach(session.events, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.terminal") yield* Deferred.succeed(settled, undefined);
        }),
      ).pipe(Effect.forkChild);
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          modelSelection,
          now: yield* DateTime.now,
        }),
      );
      yield* Deferred.await(settled);
      assert.isTrue(events.some((event) => event.type === "turn.terminal"));
      const completed = events.find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.equal(
        completed?.type === "provider_turn.updated"
          ? completed.providerTurn.turnTokenUsage?.inputTokens
          : null,
        12,
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "system_notice" &&
            event.turnItem.message.includes("Gemini used"),
        ),
      );
    }),
  );
});

describe("Gemini tool and usage normalization", () => {
  it("keeps MCP arguments when a terminal update replaces tool content", () => {
    const call = normalizeGeminiMcpToolCall({
      toolCallId: "tool-1",
      title: "Search (atlassian MCP Server)",
      status: "completed",
      data: {
        initialContent: [{ type: "content", content: { type: "text", text: '{"query":"T3"}' } }],
        content: [{ type: "content", content: { type: "text", text: '{"issues":[]}' } }],
      },
    });
    assert.deepEqual(call.data.item, {
      type: "mcpToolCall",
      id: "tool-1",
      server: "atlassian",
      tool: "Search",
      status: "completed",
      arguments: { query: "T3" },
      result: { content: [{ type: "text", text: '{"issues":[]}' }] },
    });
  });
  it("reads Gemini quota metadata as token usage", () => {
    assert.deepEqual(
      usageFromGeminiPromptResponse({
        stopReason: "end_turn",
        _meta: { quota: { token_count: { input_tokens: 12, output_tokens: 8 }, model_usage: [] } },
      }),
      { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    );
  });
});

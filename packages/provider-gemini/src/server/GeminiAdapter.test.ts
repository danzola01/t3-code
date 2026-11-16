import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";
import * as Deferred from "effect/Deferred";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2Event,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { parseSessionUpdateEvent } from "@t3tools/provider-acp/server/runtimeModel";
import type * as Acp from "effect-acp/compat";
import {
  geminiCapacityRetrySchedule,
  makeGeminiAdapter,
  normalizeGeminiMcpToolCall,
} from "./GeminiAdapter.ts";
const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);

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

const layer = TestProviderHost.layer().pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);
it.layer(layer)("GeminiAdapter V2", (it) => {
  it.effect(
    "leaves an initial plan session and switches models without replacing the session",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-v2-" });
        const instanceId = ProviderInstanceId.make("gemini-test");
        const threadId = ThreadId.make("gemini-thread");
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          cwd,
          runtimeMode: "full-access",
          interactionMode: "plan",
        });
        const modelSelection = { instanceId, model: "composer-2" };
        const adapter = yield* makeGeminiAdapter(
          decodeGeminiSettings({
            binaryPath: process.execPath,
            launchArgs: JSON.stringify(
              NodeURL.fileURLToPath(
                new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
              ),
            ),
            authMethod: "oauth-personal",
            homePath: cwd,
          }),
          {
            instanceId,
            environment: {
              ...process.env,
              GEMINI_CLI_TRUST_WORKSPACE: "true",
              T3_ACP_GEMINI: "1",
              T3_ACP_REQUEST_LOG_PATH: `${cwd}/requests.ndjson`,
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
        const terminals = yield* Deferred.make<void>();
        const events: ProviderAdapterV2Event[] = [];
        let settled = terminals;
        yield* Stream.runForEach(session.events, (event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "turn.terminal") yield* Deferred.succeed(settled, undefined);
          }),
        ).pipe(Effect.forkChild);
        for (const ordinal of [1, 2, 3, 4, 5]) {
          if (ordinal > 1) settled = yield* Deferred.make<void>();
          yield* session.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              ordinal,
              runtimePolicy: {
                ...runtimePolicy,
                interactionMode: ordinal === 1 ? "plan" : "default",
                runtimeMode:
                  ordinal === 4
                    ? "auto-accept-edits"
                    : ordinal === 3 || ordinal === 5
                      ? "approval-required"
                      : "full-access",
              },
              modelSelection:
                ordinal === 1
                  ? modelSelection
                  : {
                      ...modelSelection,
                      model: "default",
                      options: [{ id: "mode", value: "yolo" }],
                    },
              now: yield* DateTime.now,
            }),
          );
          yield* Deferred.await(settled);
        }
        assert.equal(
          events.filter(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
          ).length,
          5,
        );
        const decodeRequest = Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              method: Schema.String,
              params: Schema.optional(
                Schema.Struct({
                  configId: Schema.optional(Schema.String),
                  value: Schema.optional(Schema.Unknown),
                }),
              ),
            }),
          ),
        );
        const requests = yield* Effect.forEach(
          (yield* fs.readFileString(`${cwd}/requests.ndjson`)).trim().split("\n"),
          (line) => decodeRequest(line),
        );
        assert.equal(requests.filter((request) => request.method === "session/new").length, 1);
        const modes = requests
          .filter(
            (request) =>
              request.method === "session/set_config_option" && request.params?.configId === "mode",
          )
          .map((request) => request.params?.value);
        assert.include(modes, "plan");
        assert.deepEqual(modes.slice(-3), ["default", "autoEdit", "default"]);
        assert.isTrue(
          requests.some(
            (request) =>
              request.method === "session/set_config_option" &&
              request.params?.configId === "model" &&
              request.params.value === "default",
          ),
        );
      }),
  );
});

it.effect("backs off capacity retries exponentially with jitter", () =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(geminiCapacityRetrySchedule);
    const [, first] = yield* step(0, undefined);
    const [, second] = yield* step(0, undefined);
    assert.isAtLeast(Duration.toMillis(first), 800);
    assert.isAtMost(Duration.toMillis(first), 1200);
    assert.isAtLeast(Duration.toMillis(second), 1600);
    assert.isAtMost(Duration.toMillis(second), 2400);
  }),
);

describe("Gemini tool normalization", () => {
  // 0.64 ACP emits display text, not the MCP server identity or raw arguments.
  it.each(["Search(query: T3)", "printf T3"])(
    "preserves the 0.64 generic tool card for %s without inventing MCP metadata",
    (title) => {
      const update: Acp.SessionNotification = {
        sessionId: "native-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-search",
          status: "pending",
          kind: "other",
          title,
          content: [
            {
              type: "content",
              content: { type: "text", text: "Search for the requested project" },
            },
          ],
        },
      };
      const started = parseSessionUpdateEvent(update).events.find(
        (event) => event._tag === "ToolCallUpdated",
      );
      assert.isDefined(started);
      if (started?._tag !== "ToolCallUpdated") throw new Error("Expected tool event");
      const pending = normalizeGeminiMcpToolCall(started.toolCall);
      assert.equal(pending.title, title);
      assert.isUndefined(pending.data.item);
      const completed = parseSessionUpdateEvent({
        ...update,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-search",
          title,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "Found T3" } }],
        },
      }).events.find((event) => event._tag === "ToolCallUpdated");
      assert.isDefined(completed);
      if (completed?._tag !== "ToolCallUpdated") throw new Error("Expected tool event");
      const terminal = normalizeGeminiMcpToolCall(completed.toolCall);
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.title, title);
      assert.deepEqual(terminal.data.content, [
        { type: "content", content: { type: "text", text: "Found T3" } },
      ]);
      assert.isUndefined(terminal.data.item);
    },
  );
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
});

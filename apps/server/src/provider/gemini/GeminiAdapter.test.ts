// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  GeminiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeGeminiAdapter } from "./GeminiAdapter.ts";

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockGeminiWrapper(extraEnv?: Record<string, string>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-acp-mock-"));
  const wrapperPath = NodePath.join(directory, "fake-gemini.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-gemini-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("GeminiAdapter", (it) => {
  it.effect("runs ACP turns and expands project custom commands", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-project-")),
      );
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_GEMINI_USAGE: "1",
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const commandPath = NodePath.join(workspace, ".gemini", "commands", "review.toml");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(commandPath), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          commandPath,
          'description = "Review a change"\nprompt = "Review this carefully: {{args}}"\n',
          "utf8",
        ),
      );

      const adapter = yield* makeGeminiAdapter(
        decodeGeminiSettings({ binaryPath: wrapperPath, authMethod: "oauth-personal" }),
      );
      const threadId = ThreadId.make("gemini-mock-thread");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("gemini"),
        cwd: workspace,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("gemini"),
          model: "grok-mock-alt",
        },
      });
      assert.equal(session.provider, "gemini");
      assert.equal(session.model, "grok-mock-alt");

      yield* adapter.sendTurn({ threadId, input: "/review the adapter", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventFiber);

      assert.includeMembers(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "turn.started",
          "content.delta",
          "thread.token-usage.updated",
          "turn.completed",
        ],
      );
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.deepInclude(completed.payload, {
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          modelUsage: { "grok-mock-alt": { inputTokens: 12, outputTokens: 8 } },
        });
      }
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompt = requests.find((request) => request.method === "session/prompt");
      assert.include(encodeUnknownJson(prompt?.params), "Review this carefully: the adapter");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("normalizes Gemini MCP calls into structured runtime items", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-mcp-tool-call-")),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({ T3_ACP_EMIT_GEMINI_MCP_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeGeminiAdapter(
        decodeGeminiSettings({ binaryPath: wrapperPath, authMethod: "oauth-personal" }),
      );
      const threadId = ThreadId.make("gemini-mcp-tool-call-thread");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("gemini"),
        cwd: workspace,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Search Jira", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventFiber);

      const completed = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && String(event.itemId) === "gemini-mcp-tool-call-1",
      );
      assert.isDefined(completed);
      if (completed?.type === "item.completed") {
        assert.equal(completed.payload.itemType, "mcp_tool_call");
        assert.deepInclude(completed.payload.data as Record<string, unknown>, {
          item: {
            type: "mcpToolCall",
            id: "gemini-mcp-tool-call-1",
            server: "atlassian",
            tool: "Search",
            status: "completed",
            arguments: { query: "project = T3" },
            result: {
              content: [
                {
                  type: "text",
                  text: '{\n  "issues": [\n    { "key": "T3-123" }\n  ]\n}',
                },
              ],
            },
          },
        });
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("retries transient Gemini capacity failures", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-capacity-retry-")),
      );
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_FAIL_PROMPT_ATTEMPTS: "1",
          T3_ACP_PROMPT_FAILURE_MESSAGE:
            "No capacity available for model gemini-3.5-flash on the server",
        }),
      );
      const adapter = yield* makeGeminiAdapter(
        decodeGeminiSettings({ binaryPath: wrapperPath, authMethod: "oauth-personal" }),
      );
      const threadId = ThreadId.make("gemini-capacity-retry-thread");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("gemini"),
        cwd: workspace,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Retry this prompt", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.lengthOf(
        requests.filter((request) => request.method === "session/prompt"),
        2,
      );

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not retry non-capacity prompt failures", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-prompt-failure-")),
      );
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_FAIL_PROMPT_ATTEMPTS: "3",
          T3_ACP_PROMPT_FAILURE_MESSAGE: "Mock non-capacity prompt failure",
        }),
      );
      const adapter = yield* makeGeminiAdapter(
        decodeGeminiSettings({ binaryPath: wrapperPath, authMethod: "oauth-personal" }),
      );
      const threadId = ThreadId.make("gemini-prompt-failure-thread");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("gemini"),
        cwd: workspace,
        runtimeMode: "full-access",
      });
      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "Do not retry this prompt", attachments: [] }),
      );
      assert.include(error.message, "Mock non-capacity prompt failure");

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.lengthOf(
        requests.filter((request) => request.method === "session/prompt"),
        1,
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reports a friendly error after capacity retries are exhausted", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-capacity-exhausted-")),
      );
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_FAIL_PROMPT_ATTEMPTS: "3",
          T3_ACP_PROMPT_FAILURE_MESSAGE: "The model is overloaded. Please try again later.",
        }),
      );
      const adapter = yield* makeGeminiAdapter(
        decodeGeminiSettings({ binaryPath: wrapperPath, authMethod: "oauth-personal" }),
      );
      const threadId = ThreadId.make("gemini-capacity-exhausted-thread");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("gemini"),
        cwd: workspace,
        runtimeMode: "full-access",
      });
      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "Retry until exhausted", attachments: [] }),
      );
      assert.include(error.message, "Gemini is temporarily out of capacity");
      assert.notInclude(error.message, "The model is overloaded");

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.lengthOf(
        requests.filter((request) => request.method === "session/prompt"),
        3,
      );

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});

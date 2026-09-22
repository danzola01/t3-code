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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
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
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockGeminiWrapper(extraEnv?: Record<string, string>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-acp-mock-"));
  const wrapperPath = NodePath.join(directory, "fake-gemini.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"
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

const makeFixture = Effect.fn(function* (environment: Record<string, string> = {}) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-regression-" });
  const requestLog = NodePath.join(cwd, "requests.ndjson");
  const adapter = yield* makeGeminiAdapter(
    decodeGeminiSettings({
      binaryPath: process.execPath,
      launchArgs: encodeUnknownJson(mockAgentPath),
      homePath: cwd,
      authMethod: "oauth-personal",
    }),
    {
      environment: {
        ...process.env,
        GEMINI_CLI_TRUST_WORKSPACE: "true",
        T3_ACP_REQUEST_LOG_PATH: requestLog,
        ...environment,
      },
    },
  );
  const threadId = ThreadId.make("gemini-regression");
  const events: ProviderRuntimeEvent[] = [];
  yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.sync(() => events.push(event)),
  ).pipe(Effect.forkChild);
  const session = yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
  return { adapter, cwd, requestLog, threadId, events, session };
});

it.layer(testLayer)("GeminiAdapter", (it) => {
  it.effect("retires a dead process and permits resuming its thread", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ T3_ACP_EXIT_ON_PROMPT: "1" });
      const exited = yield* Deferred.make<void>();
      yield* Stream.runForEach(f.adapter.streamEvents, (event) =>
        event.type === "session.exited" ? Deferred.succeed(exited, undefined) : Effect.void,
      ).pipe(Effect.forkChild);
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "exit" }).pipe(Effect.result);
      yield* Deferred.await(exited);
      assert.isFalse(yield* f.adapter.hasSession(f.threadId));
      assert.isEmpty(yield* f.adapter.listSessions());
      assert.lengthOf(
        f.events.filter((event) => event.type === "turn.completed"),
        1,
      );
      yield* f.adapter.startSession({
        threadId: f.threadId,
        cwd: f.cwd,
        runtimeMode: "approval-required",
        resumeCursor: f.session.resumeCursor,
      });
      assert.isTrue(yield* f.adapter.hasSession(f.threadId));
      const requests = yield* Effect.promise(() => readJsonLines(f.requestLog));
      assert.isTrue(requests.some((request) => request.method === "session/load"));
      yield* f.adapter.stopSession(f.threadId);
    }),
  );

  it.effect("hides unavailable session approvals while honoring approve once", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_OMIT_ALLOW_ALWAYS: "1" });
      const opened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      yield* Stream.runForEach(f.adapter.streamEvents, (event) =>
        event.type === "request.opened" ? Deferred.succeed(opened, event) : Effect.void,
      ).pipe(Effect.forkChild);
      const prompt = yield* f.adapter
        .sendTurn({ threadId: f.threadId, input: "request approval" })
        .pipe(Effect.forkChild);
      const event = yield* Deferred.await(opened);
      assert.deepEqual(
        event.payload.options?.map((option) => option.decision),
        ["accept", "decline", "cancel"],
      );
      yield* f.adapter.respondToRequest(
        f.threadId,
        ApprovalRequestId.make(event.requestId!),
        "accept",
      );
      yield* Fiber.join(prompt);
      yield* f.adapter.stopSession(f.threadId);
    }),
  );

  for (const steering of [false, true]) {
    it.effect(
      steering
        ? "steers by cancelling the native prompt before dispatching its replacement"
        : "drains cancellation before a new turn so stale updates cannot leak",
      () =>
        Effect.gen(function* () {
          const f = yield* makeFixture({
            T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1",
            T3_ACP_AUTO_FINISH_CANCEL: "1",
          });
          const started = yield* Deferred.make<void>();
          yield* Stream.runForEach(f.adapter.streamEvents, (event) =>
            event.type === "item.updated" && event.itemId === "native-cancel-tool"
              ? Deferred.succeed(started, undefined)
              : Effect.void,
          ).pipe(Effect.forkChild);
          const first = yield* f.adapter
            .sendTurn({ threadId: f.threadId, input: "long operation" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          if (steering) {
            yield* f.adapter
              .sendTurn({ threadId: f.threadId, input: "/mcp list" })
              .pipe(Effect.flip);
            assert.equal((yield* f.adapter.listSessions())[0]?.status, "running");
          }
          if (!steering) yield* f.adapter.interruptTurn(f.threadId);
          const second = yield* f.adapter.sendTurn({ threadId: f.threadId, input: "replacement" });
          const previous = yield* Fiber.join(first);
          assert.equal(previous.turnId === second.turnId, steering);
          const requests = yield* Effect.promise(() => readJsonLines(f.requestLog));
          assert.deepEqual(
            requests
              .filter((request) =>
                ["session/prompt", "session/cancel"].includes(request.method ?? ""),
              )
              .map((request) => request.method),
            ["session/prompt", "session/cancel", "session/prompt"],
          );
          const completions = f.events.filter((event) => event.type === "turn.completed");
          assert.lengthOf(completions, steering ? 1 : 2);
          if (!steering)
            assert.isFalse(
              f.events.some(
                (event) =>
                  event.type === "content.delta" &&
                  event.turnId === second.turnId &&
                  event.payload.delta.includes("cancelled"),
              ),
            );
          yield* f.adapter.stopSession(f.threadId);
        }),
    );
  }

  it.effect("explains unsupported /mcp instead of sending it to the model", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const error = yield* f.adapter
        .sendTurn({ threadId: f.threadId, input: "/mcp list" })
        .pipe(Effect.flip);
      assert.include(error.message, "gemini mcp list");
      const requests = yield* Effect.promise(() => readJsonLines(f.requestLog));
      assert.isFalse(requests.some((request) => request.method === "session/prompt"));
      yield* f.adapter.stopSession(f.threadId);
    }),
  );

  it.effect("publishes native commands received before any active turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-commands-" });
      const received = yield* Deferred.make<ReadonlyArray<string>>();
      const adapter = yield* makeGeminiAdapter(
        decodeGeminiSettings({
          binaryPath: process.execPath,
          launchArgs: encodeUnknownJson(mockAgentPath),
          homePath: cwd,
        }),
        {
          environment: { ...process.env, T3_ACP_ANTIGRAVITY: "1" },
          onAvailableCommands: (commands, workspace) => {
            assert.equal(workspace, cwd);
            return Deferred.succeed(
              received,
              commands.map((command) => command.name),
            ).pipe(Effect.asVoid);
          },
        },
      );
      const threadId = ThreadId.make("native-commands");
      yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
      assert.sameMembers([...(yield* Deferred.await(received))], ["plan", "logout"]);
      yield* adapter.stopSession(threadId);
    }),
  );
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
          'description = "Review a change"\nprompt = "Review this carefully: {{args}} with @{notes.txt}"\n',
          "utf8",
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(workspace, "notes.txt"), "PRIVATE_FILE_MARKER"),
      );

      const adapter = yield* makeGeminiAdapter(
        decodeGeminiSettings({
          binaryPath: wrapperPath,
          authMethod: "oauth-personal",
          homePath: workspace,
        }),
        { environment: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } },
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
        ["session.started", "turn.started", "content.delta", "turn.completed"],
      );
      assert.isFalse(runtimeEvents.some((event) => event.type === "thread.token-usage.updated"));
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.deepInclude(completed.payload, {
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          modelUsage: { "grok-mock-alt": { inputTokens: 12, outputTokens: 8 } },
        });
      }
      yield* adapter.sendTurn({
        threadId,
        input: "Switch model in this conversation",
        modelSelection: { instanceId: ProviderInstanceId.make("gemini"), model: "grok-4.6" },
      });
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompt = requests.find((request) => request.method === "session/prompt");
      assert.include(encodeUnknownJson(prompt?.params), "Review this carefully: the adapter");
      assert.notInclude(encodeUnknownJson(prompt?.params), "PRIVATE_FILE_MARKER");
      assert.include(encodeUnknownJson(prompt?.params), '"type":"resource_link"');
      assert.lengthOf(
        requests.filter((request) => request.method === "session/new"),
        1,
      );
      assert.deepEqual(
        requests
          .filter((request) => request.method === "session/set_model")
          .map((request) => request.params?.modelId),
        ["grok-mock-alt", "grok-4.6"],
      );

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
        decodeGeminiSettings({
          binaryPath: wrapperPath,
          authMethod: "oauth-personal",
          homePath: workspace,
        }),
        { environment: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } },
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

  it.effect("maps Gemini topic updates to authoritative thread titles once per tool call", () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gemini-topic-update-")),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGeminiWrapper({ T3_ACP_EMIT_GEMINI_TOPIC_UPDATE: "1" }),
      );
      const adapter = yield* makeGeminiAdapter(
        decodeGeminiSettings({
          binaryPath: wrapperPath,
          authMethod: "oauth-personal",
          homePath: workspace,
        }),
        { environment: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } },
      );
      const threadId = ThreadId.make("gemini-topic-update-thread");
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
      yield* adapter.sendTurn({ threadId, input: "Improve thread titles", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventFiber);

      const titleUpdates = runtimeEvents.filter(
        (event) => event.type === "thread.metadata.updated",
      );
      assert.lengthOf(titleUpdates, 1);
      const titleUpdate = titleUpdates[0];
      assert.equal(titleUpdate?.type, "thread.metadata.updated");
      if (titleUpdate?.type === "thread.metadata.updated") {
        assert.deepEqual(titleUpdate.payload, {
          name: "Improving Gemini titles",
          replaceExistingTitle: true,
          metadata: {
            source: "gemini.update_topic",
            toolCallId: "gemini-update-topic-1",
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
        decodeGeminiSettings({
          binaryPath: wrapperPath,
          authMethod: "oauth-personal",
          homePath: workspace,
        }),
        { environment: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } },
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
        decodeGeminiSettings({
          binaryPath: wrapperPath,
          authMethod: "oauth-personal",
          homePath: workspace,
        }),
        { environment: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } },
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
        decodeGeminiSettings({
          binaryPath: wrapperPath,
          authMethod: "oauth-personal",
          homePath: workspace,
        }),
        { environment: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } },
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

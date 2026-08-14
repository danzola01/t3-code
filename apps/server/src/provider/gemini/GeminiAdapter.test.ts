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
});

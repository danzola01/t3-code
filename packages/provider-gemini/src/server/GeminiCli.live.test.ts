// @effect-diagnostics nodeBuiltinImport:off -- exercises a real CLI against a loopback model endpoint.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GeminiSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as Acp from "effect-acp/compat";
import { geminiPermissionOptionId } from "./GeminiPermissions.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe } from "vite-plus/test";
import { applyGeminiAcpModelSelection, makeGeminiAcpRuntime } from "./GeminiAcpSupport.ts";
import { checkGeminiProviderStatus } from "./GeminiProvider.ts";

const binaryPath = process.env.GEMINI_CLI_BIN;
const expectedVersion = process.env.GEMINI_CLI_VERSION;
const decodeSettings = Schema.decodeSync(GeminiSettings);
const decodeModelRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      tools: Schema.optional(
        Schema.Array(
          Schema.Struct({
            functionDeclarations: Schema.optional(
              Schema.Array(Schema.Struct({ name: Schema.String })),
            ),
          }),
        ),
      ),
    }),
  ),
);

/** Run with GEMINI_CLI_BIN pointing to a pinned CLI; no Google login or remote model is used. */
describe.runIf(binaryPath !== undefined)("Gemini CLI compatibility", () => {
  it.live(
    "authenticates, switches models, runs MCP approvals and cancellation against a local model",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-cli-compat-" });
        const cwd = path.join(home, "project");
        yield* fs.makeDirectory(cwd);
        const requests: string[] = [];
        const holding = yield* Deferred.make<void>();
        let useTool = false;
        let sawImage = false;
        let holdNextStream = false;
        const mcpPath = path.join(home, "fixture-mcp.mjs");
        yield* fs.writeFileString(
          mcpPath,
          `import * as readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.method === "initialize"
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Echo a fixture value", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
      : message.method === "tools/call"
        ? { content: [{ type: "text", text: message.params.arguments.text }] }
        : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`,
        );
        yield* fs.makeDirectory(path.join(home, ".gemini"));
        yield* fs.writeFileString(
          path.join(home, ".gemini", "settings.json"),
          JSON.stringify({
            general: { disableAutoUpdate: true },
            telemetry: { enabled: false },
            mcpServers: { fixture: { command: process.execPath, args: [mcpPath] } },
          }),
        );
        const server = NodeHttp.createServer((request, response) => {
          requests.push(request.url ?? "");
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            if (body.includes('"inlineData"')) sawImage = true;
            if (request.url?.includes("streamGenerateContent") && holdNextStream) {
              holdNextStream = false;
              response.writeHead(200, { "Content-Type": "text/event-stream" });
              response.write(
                `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "WAIT_FOR_CANCEL" }] }, index: 0 }] })}\n\n`,
              );
              return;
            }
            let parts: Array<
              { text: string } | { functionCall: { name: string; args: { text: string } } }
            > = [{ text: "GEMINI_COMPAT_OK" }];
            if (request.url?.includes("streamGenerateContent") && useTool) {
              useTool = false;
              const decoded = decodeModelRequest(body);
              const name = decoded.tools
                ?.flatMap((tool) => tool.functionDeclarations ?? [])
                .find((tool) => tool.name.includes("fixture") && tool.name.endsWith("echo"))?.name;
              if (!name) {
                response.writeHead(500);
                response.end("Missing fixture MCP tool");
                return;
              }
              parts = [{ functionCall: { name, args: { text: "MCP_FIXTURE_OK" } } }];
            }
            const result = {
              candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
              usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 5,
                cachedContentTokenCount: 4,
                thoughtsTokenCount: 2,
                totalTokenCount: 27,
              },
            };
            if (request.url?.includes("streamGenerateContent")) {
              response.writeHead(200, { "Content-Type": "text/event-stream" });
              response.end(`data: ${JSON.stringify(result)}\n\n`);
            } else {
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(
                JSON.stringify(request.url?.includes("countTokens") ? { totalTokens: 20 } : result),
              );
            }
          });
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
        );
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const address = server.address();
        assert.isNotNull(address);
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("Expected loopback listener");
        const environment = {
          PATH: process.env.PATH,
          HOME: home,
          GEMINI_CLI_HOME: home,
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, "system.json"),
          GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(home, "defaults.json"),
          GEMINI_CLI_TRUST_WORKSPACE: "true",
          GEMINI_TELEMETRY_ENABLED: "false",
          GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}`,
          GEMINI_API_KEY: "local-compatibility-fixture",
          NO_COLOR: "1",
        };
        const settings = decodeSettings({ binaryPath, homePath: home, authMethod: "gateway" });
        const status = yield* checkGeminiProviderStatus(settings, environment);
        assert.equal(status.status, "ready");
        if (expectedVersion) assert.equal(status.version, expectedVersion);
        const nativeScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(nativeScope, exit));
        let runtime = yield* makeGeminiAcpRuntime({
          geminiSettings: settings,
          environment,
          childProcessSpawner: spawner,
          cwd,
          cancelTimeout: "250 millis",
          clientInfo: { name: "t3-gemini-compatibility-test", version: "1.0.0" },
        }).pipe(Effect.provideService(Scope.Scope, nativeScope));
        const text: string[] = [];
        const permissions: Acp.RequestPermissionRequest[] = [];
        const notifications: Acp.SessionNotification[] = [];
        let allow = true;
        yield* runtime.handleRequestPermission((request) =>
          Effect.sync(() => {
            permissions.push(request);
            const optionId = geminiPermissionOptionId(request, allow ? "accept" : "decline");
            return optionId
              ? { outcome: { outcome: "selected" as const, optionId } }
              : { outcome: { outcome: "cancelled" as const } };
          }),
        );
        const handleUpdate = (notification: Acp.SessionNotification) =>
          Effect.gen(function* () {
            notifications.push(notification);
            const update = notification.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
              text.push(update.content.text);
              if (update.content.text.includes("WAIT_FOR_CANCEL"))
                yield* Deferred.succeed(holding, undefined);
            }
          });
        yield* runtime.handleSessionUpdate(handleUpdate);
        const started = yield* runtime.start();
        assert.equal(started.initializeResult.protocolVersion, 1);
        assert.isNotEmpty(started.sessionId);
        const available = started.sessionSetupResult.models?.availableModels ?? [];
        const selected =
          available.find(
            (model) => model.modelId.startsWith("gemini-") && model.modelId.includes("flash"),
          ) ?? available.find((model) => model.modelId !== "auto");
        assert.isDefined(selected);
        if (!selected) return yield* Effect.die("Expected advertised model");
        yield* runtime.setSessionModel(selected.modelId);
        const response = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Say GEMINI_COMPAT_OK" }],
        });
        assert.equal(response.stopReason, "end_turn");
        if (status.version === "0.64.0") {
          assert.deepInclude(response.usage, {
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
            cachedReadTokens: 4,
            thoughtTokens: 2,
          });
        }
        assert.include(text.join(""), "GEMINI_COMPAT_OK");
        assert.isTrue(
          requests.some(
            (url) =>
              url.includes("streamGenerateContent") &&
              (!selected.modelId.startsWith("gemini-") || url.includes(selected.modelId)),
          ),
          JSON.stringify(requests),
        );
        yield* runtime.prompt({
          prompt: [
            { type: "text", text: "Read this image" },
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3K0AAAAASUVORK5CYII=",
            },
          ],
        });
        assert.isTrue(sawImage);
        useTool = true;
        yield* runtime.prompt({ prompt: [{ type: "text", text: "Call the fixture echo tool" }] });
        assert.lengthOf(permissions, 1);
        assert.isTrue(
          notifications.some(
            ({ update }) =>
              update.sessionUpdate === "tool_call_update" &&
              update.status === "completed" &&
              JSON.stringify(update.content).includes("MCP_FIXTURE_OK"),
          ),
        );
        allow = false;
        useTool = true;
        yield* runtime.prompt({
          prompt: [{ type: "text", text: "Call the fixture echo tool again" }],
        });
        assert.lengthOf(permissions, 2);
        // 0.64 fixes native session lookup, including sessions the older picker rejects.
        if (status.version === "0.64.0") {
          const loaded = yield* runtime.loadSession(started.sessionId);
          assert.equal(loaded.sessionId, started.sessionId);
          yield* applyGeminiAcpModelSelection({
            runtime,
            currentModelId: loaded.sessionSetupResult.models?.currentModelId,
            requestedModelId: selected.modelId,
            mapError: (cause) => cause,
          });
          yield* runtime.prompt({
            prompt: [{ type: "text", text: "Continue the resumed session" }],
          });
          assert.isTrue(
            notifications.some(({ update }) => update.sessionUpdate === "usage_update"),
          );
        }
        if (status.version === "0.64.0") {
          yield* Scope.close(nativeScope, Exit.void);
          runtime = yield* makeGeminiAcpRuntime({
            geminiSettings: settings,
            environment,
            childProcessSpawner: spawner,
            cwd,
            resumeSessionId: started.sessionId,
            cancelTimeout: "250 millis",
            clientInfo: { name: "t3-gemini-compatibility-test", version: "1.0.0" },
          });
          yield* runtime.handleSessionUpdate(handleUpdate);
          const resumed = yield* runtime.start();
          assert.equal(resumed.sessionId, started.sessionId);
          yield* applyGeminiAcpModelSelection({
            runtime,
            currentModelId: resumed.sessionSetupResult.models?.currentModelId,
            requestedModelId: selected.modelId,
            mapError: (cause) => cause,
          });
          text.length = 0;
          const continued = yield* runtime.prompt({
            prompt: [{ type: "text", text: "Continue after restart" }],
          });
          assert.equal(continued.stopReason, "end_turn");
          assert.include(text.join(""), "GEMINI_COMPAT_OK");
        }
        holdNextStream = true;
        const pending = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "Wait until cancelled" }] })
          .pipe(Effect.forkChild);
        yield* Deferred.await(holding);
        // A stalled SDK stream can ignore cancellation. T3 must retire the process
        // instead of dispatching a replacement prompt while the native turn runs.
        const failure = yield* runtime.cancel.pipe(Effect.flip);
        assert.equal(failure._tag, "AcpTransportError");
        const settled = yield* Fiber.await(pending);
        assert.isTrue(Exit.isFailure(settled) || settled.value.stopReason === "cancelled");
        const retired = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "Must not dispatch" }] })
          .pipe(Effect.flip);
        assert.equal(retired._tag, "AcpTransportError");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  );
});

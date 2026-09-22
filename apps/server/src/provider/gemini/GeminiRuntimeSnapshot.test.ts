import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GeminiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { buildInitialGeminiProviderSnapshot } from "./GeminiProvider.ts";
import { makeGeminiRuntimeSnapshot } from "./GeminiRuntimeSnapshot.ts";

const decodeSettings = Schema.decodeEffect(GeminiSettings);

it.layer(NodeServices.layer)("Gemini runtime snapshots", (it) => {
  it.effect(
    "publishes project catalogs and native commands to connected clients without leaking between workspaces",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "gemini-catalog-publish-" });
        const cwd = path.join(root, "project");
        yield* fs.makeDirectory(path.join(cwd, ".gemini", "commands"), { recursive: true });
        yield* fs.writeFileString(
          path.join(cwd, ".gemini", "commands", "review.toml"),
          'prompt = "Review the project"',
        );
        yield* fs.makeDirectory(path.join(cwd, ".agents", "skills", "review"), { recursive: true });
        yield* fs.writeFileString(
          path.join(cwd, ".agents", "skills", "review", "SKILL.md"),
          "---\nname: review\n---\n",
        );
        const settings = yield* decodeSettings({
          homePath: root,
          customModels: ["company-model"],
        });
        const runtime = yield* makeGeminiRuntimeSnapshot(settings, {
          GEMINI_CLI_TRUST_WORKSPACE: "true",
        });
        const base: ServerProvider = {
          ...(yield* buildInitialGeminiProviderSnapshot(settings)),
          instanceId: ProviderInstanceId.make("gemini"),
          driver: ProviderDriverKind.make("gemini"),
        };
        const snapshot = runtime.wrap({
          getSnapshot: Effect.succeed(base),
          refresh: Effect.succeed(base),
          streamChanges: Stream.make(base),
          resolveMaintenance: () => Effect.die("unused"),
          applyUsageLimits: () => Effect.void,
        });
        const subscribed = yield* Deferred.make<void>();
        const published = yield* Deferred.make<ServerProvider>();
        yield* Stream.runForEach(snapshot.streamChanges, (current) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(subscribed, undefined);
            if (
              current.workspaceSnapshots?.some((entry) =>
                entry.slashCommands.some((command) => command.name === "memory list"),
              )
            )
              yield* Deferred.succeed(published, current);
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(subscribed);
        const project = yield* runtime.snapshotForCwd(base, cwd);
        assert.isTrue(project.slashCommands.some((command) => command.name === "review"));
        assert.deepEqual(
          project.skills.map((skill) => skill.name),
          ["review"],
        );
        yield* runtime.onAvailableCommands(
          [{ name: "memory list", description: "List memory files" }],
          cwd,
        );
        const broadcast = yield* Deferred.await(published);
        assert.sameMembers(
          broadcast.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name) ?? [],
          ["review", "memory list"],
        );
        const other = yield* runtime.snapshotForCwd(base, path.join(root, "other"));
        assert.isFalse(
          other.slashCommands.some(
            (command) => command.name === "review" || command.name === "memory list",
          ),
        );
        yield* runtime.onAvailableCommands([], cwd);
        assert.deepEqual(
          (yield* runtime.snapshotForCwd(base, cwd)).slashCommands.map((command) => command.name),
          ["review"],
        );

        yield* runtime.onSessionStarted({
          sessionId: "session",
          modelConfigId: undefined,
          initializeResult: { protocolVersion: 1 },
          sessionSetupResult: {
            sessionId: "session",
            models: {
              currentModelId: "auto",
              availableModels: [
                { modelId: "auto", name: "Auto" },
                { modelId: "gemini-test", name: "Gemini test" },
              ],
            },
          },
        });
        const updated = yield* snapshot.getSnapshot;
        assert.sameMembers(
          updated.models.map((model) => model.slug),
          ["auto", "gemini-test", "company-model"],
        );
        assert.isFalse(updated.requiresNewThreadForModelChange);
        yield* fs.remove(path.join(cwd, ".gemini", "commands", "review.toml"));
        const refreshed = yield* snapshot.refresh;
        assert.isFalse(
          refreshed.workspaceSnapshots
            ?.find((entry) => entry.cwd === cwd)
            ?.slashCommands.some((command) => command.name === "review"),
        );
      }),
  );
});

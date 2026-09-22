import type {
  GeminiSettings,
  ServerProvider,
  ServerProviderWorkspaceSnapshot,
  ServerProviderSlashCommand,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Acp from "effect-acp/schema";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { buildGeminiDiscoveredModelsFromSessionModelState } from "./GeminiProvider.ts";
import { discoverGeminiCatalog } from "./GeminiCatalog.ts";

export const makeGeminiRuntimeSnapshot = Effect.fn("makeGeminiRuntimeSnapshot")(function* (
  settings: GeminiSettings,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = yield* SubscriptionRef.make<ReadonlyArray<ServerProviderWorkspaceSnapshot>>(
    [],
  );
  const models = yield* SubscriptionRef.make<ReadonlyArray<ServerProviderModel> | undefined>(
    undefined,
  );
  const commandsByCwd = new Map<string, ReadonlyArray<ServerProviderSlashCommand>>();
  const discover = Effect.fn(function* (cwd: string) {
    const catalog = yield* discoverGeminiCatalog(
      settings,
      cwd,
      environment,
      commandsByCwd.get(cwd),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const workspace = { cwd, checkedAt: DateTime.formatIso(yield* DateTime.now), ...catalog };
    yield* SubscriptionRef.update(workspaces, (entries) =>
      [...entries.filter((entry) => entry.cwd !== cwd), workspace].slice(-32),
    );
    return catalog;
  });
  const onAvailableCommands = Effect.fn(function* (
    commands: ReadonlyArray<Acp.AvailableCommand>,
    cwd: string,
  ) {
    commandsByCwd.delete(cwd);
    commandsByCwd.set(
      cwd,
      commands.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input ? { input: command.input } : {}),
      })),
    );
    if (commandsByCwd.size > 32) commandsByCwd.delete(commandsByCwd.keys().next().value!);
    yield* discover(cwd);
  });
  const merge = (
    snapshot: ServerProvider,
    entries: ReadonlyArray<ServerProviderWorkspaceSnapshot>,
    nativeModels: ReadonlyArray<ServerProviderModel> | undefined,
  ): ServerProvider => ({
    ...snapshot,
    workspaceSnapshots: entries,
    ...(nativeModels?.length
      ? {
          models: [
            ...nativeModels,
            ...snapshot.models.filter(
              (model) =>
                model.isCustom && !nativeModels.some((native) => native.slug === model.slug),
            ),
          ],
        }
      : {}),
  });
  return {
    onAvailableCommands,
    onSessionStarted: (started: AcpSessionRuntimeStartResult) =>
      SubscriptionRef.set(
        models,
        buildGeminiDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models),
      ),
    snapshotForCwd: (snapshot: ServerProvider, cwd: string) =>
      discover(cwd).pipe(Effect.map((catalog) => ({ ...snapshot, ...catalog }))),
    wrap: (snapshot: ServerProviderShape): ServerProviderShape => ({
      ...snapshot,
      getSnapshot: Effect.all([
        snapshot.getSnapshot,
        SubscriptionRef.get(workspaces),
        SubscriptionRef.get(models),
      ]).pipe(
        Effect.map(([current, entries, nativeModels]) => merge(current, entries, nativeModels)),
      ),
      refresh: Effect.gen(function* () {
        const current = yield* snapshot.refresh;
        for (const workspace of yield* SubscriptionRef.get(workspaces))
          yield* discover(workspace.cwd);
        return merge(
          current,
          yield* SubscriptionRef.get(workspaces),
          yield* SubscriptionRef.get(models),
        );
      }),
      streamChanges: Stream.zipLatestAll(
        snapshot.streamChanges,
        SubscriptionRef.changes(workspaces),
        SubscriptionRef.changes(models),
      ).pipe(
        Stream.map(([current, entries, nativeModels]) => merge(current, entries, nativeModels)),
      ),
    }),
  };
});

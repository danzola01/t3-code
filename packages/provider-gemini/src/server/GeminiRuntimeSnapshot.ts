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
import type * as Acp from "effect-acp/compat";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import type { AcpSessionRuntimeStartResult } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  findModelConfigOption,
  parseSessionModeState,
  type AcpSessionModeState,
} from "@t3tools/provider-acp/server/runtimeModel";
import {
  acpProviderOptionDescriptors,
  flattenSelectChoices,
} from "@t3tools/provider-acp/server/sessionConfig";
import { buildGeminiDiscoveredModelsFromSessionModelState } from "./GeminiProvider.ts";
import { discoverGeminiCatalog } from "./GeminiCatalog.ts";

interface GeminiNativeConfiguration {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly supportsPlan: boolean;
}

export const makeGeminiRuntimeSnapshot = Effect.fn("makeGeminiRuntimeSnapshot")(function* (
  settings: GeminiSettings,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = yield* SubscriptionRef.make<ReadonlyArray<ServerProviderWorkspaceSnapshot>>(
    [],
  );
  const configuration = yield* SubscriptionRef.make<GeminiNativeConfiguration | undefined>(
    undefined,
  );
  const onSessionConfigurationUpdate = Effect.fn(
    "GeminiRuntimeSnapshot.onSessionConfigurationUpdate",
  )(function* (
    configOptions: ReadonlyArray<Acp.SessionConfigOption>,
    modeState: AcpSessionModeState | undefined,
    modelState: Acp.SessionModelState | null | undefined,
  ) {
    const modelOption = findModelConfigOption(configOptions);
    const resolvedModelState = modelOption
      ? {
          currentModelId: modelOption.currentValue,
          availableModels: flattenSelectChoices(modelOption.options).map((model) => ({
            modelId: model.value,
            name: model.name,
          })),
        }
      : modelState;
    const capabilities = createModelCapabilities({
      optionDescriptors: acpProviderOptionDescriptors({ configOptions, modeState }),
    });
    const models = buildGeminiDiscoveredModelsFromSessionModelState(resolvedModelState).map(
      (model) => ({ ...model, capabilities }),
    );
    const supportsPlan =
      modeState?.availableModes.some((mode) => mode.id === "plan") === true ||
      configOptions.some(
        (option) =>
          option.type === "select" &&
          (option.category === "mode" || option.category === "collaboration_mode") &&
          flattenSelectChoices(option.options).some((choice) => choice.value === "plan"),
      );
    yield* SubscriptionRef.set(configuration, { models, supportsPlan });
  });
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
    native: GeminiNativeConfiguration | undefined,
  ): ServerProvider => ({
    ...snapshot,
    workspaceSnapshots: entries,
    ...(native === undefined ? {} : { showInteractionModeToggle: native.supportsPlan }),
    ...(native?.models.length
      ? {
          models: [
            ...native.models,
            ...snapshot.models.filter(
              (model) =>
                model.isCustom && !native.models.some((native) => native.slug === model.slug),
            ),
          ],
        }
      : {}),
  });
  return {
    onAvailableCommands,
    onSessionConfigurationUpdate,
    onSessionStarted: (started: AcpSessionRuntimeStartResult) =>
      onSessionConfigurationUpdate(
        started.sessionSetupResult.configOptions ?? [],
        parseSessionModeState(started.sessionSetupResult),
        started.sessionSetupResult.models,
      ),
    snapshotForCwd: Effect.fn("GeminiRuntimeSnapshot.snapshotForCwd")(function* (
      snapshot: ServerProvider,
      cwd: string,
    ) {
      const catalog = yield* discover(cwd);
      return merge(
        { ...snapshot, ...catalog },
        yield* SubscriptionRef.get(workspaces),
        yield* SubscriptionRef.get(configuration),
      );
    }),
    wrap: (snapshot: ManagedServerProvider): ManagedServerProvider => ({
      ...snapshot,
      getSnapshot: Effect.all([
        snapshot.getSnapshot,
        SubscriptionRef.get(workspaces),
        SubscriptionRef.get(configuration),
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
          yield* SubscriptionRef.get(configuration),
        );
      }),
      streamChanges: Stream.zipLatestAll(
        snapshot.streamChanges,
        SubscriptionRef.changes(workspaces),
        SubscriptionRef.changes(configuration),
      ).pipe(
        Stream.map(([current, entries, nativeModels]) => merge(current, entries, nativeModels)),
      ),
    }),
  };
});

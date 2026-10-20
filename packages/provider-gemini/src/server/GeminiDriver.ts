import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { GeminiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { geminiUsageReader } from "./usage.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { makeGeminiAdapter } from "./GeminiAdapter.ts";
import { makeGeminiEnvironment } from "./GeminiHome.ts";
import {
  buildInitialGeminiProviderSnapshot,
  checkGeminiProviderStatus,
  enrichGeminiSnapshot,
} from "./GeminiProvider.ts";
import { makeGeminiTextGeneration } from "./GeminiTextGeneration.ts";
import { makeGeminiRuntimeSnapshot } from "./GeminiRuntimeSnapshot.ts";
import { makeGeminiUsageReader } from "./GeminiUsageLimits.ts";
const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);

const DRIVER_KIND = ProviderDriverKind.make("gemini");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type GeminiDriverEnv =
  | ProviderLatestVersions.ProviderLatestVersions
  | ProviderHost.ProviderHost
  | McpProviderSessions.McpProviderSessions
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | IdAllocatorV2;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const GeminiDriver: ProviderDriver<GeminiSettings, GeminiDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Gemini",
    supportsMultipleInstances: true,
  },
  configSchema: GeminiSettings,
  defaultConfig: (): GeminiSettings => decodeGeminiSettings({}),
  usage: geminiUsageReader,
  create: Effect.fn("GeminiDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const eventLoggers = yield* ProviderEventLoggers;
    const processEnv = yield* makeGeminiEnvironment(
      config,
      yield* mergeProviderInstanceEnvironment(environment),
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies GeminiSettings;
    const runtimeSnapshot = yield* makeGeminiRuntimeSnapshot(effectiveConfig, processEnv);
    const adapter = yield* makeGeminiAdapter(effectiveConfig, {
      nativeEventLogger: eventLoggers.native,
      onAvailableCommands: runtimeSnapshot.onAvailableCommands,
      onSessionStarted: runtimeSnapshot.onSessionStarted,
      environment: processEnv,
      instanceId,
    });
    const textGeneration = yield* makeGeminiTextGeneration(effectiveConfig, processEnv);
    const usageReader = yield* makeGeminiUsageReader(effectiveConfig, processEnv);

    const checkProvider = checkGeminiProviderStatus(effectiveConfig, processEnv).pipe(
      Effect.flatMap((current) =>
        effectiveConfig.enabled && current.installed && current.status === "ready"
          ? usageReader.read.pipe(
              Effect.map(({ email, plan, usageLimits }) => ({
                ...current,
                auth: email
                  ? { status: "authenticated" as const, email, ...(plan ? { label: plan } : {}) }
                  : current.auth,
                usageLimits,
              })),
            )
          : Effect.succeed(current),
      ),
      Effect.map(stampIdentity),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GeminiSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialGeminiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        enrichGeminiSnapshot({
          snapshot: currentSnapshot,
          maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
          enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          publishSnapshot,
          httpClient,
        }).pipe(
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Gemini snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: runtimeSnapshot.wrap(snapshot),
      snapshotForCwd: (cwd) =>
        snapshot.getSnapshot.pipe(
          Effect.flatMap((current) => runtimeSnapshot.snapshotForCwd(current, cwd)),
        ),
      orchestrationAdapter: adapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};

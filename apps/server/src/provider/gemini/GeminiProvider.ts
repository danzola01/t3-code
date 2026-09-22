import {
  type GeminiSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeGeminiAcpRuntime, resolveGeminiAcpBaseModelId } from "./GeminiAcpSupport.ts";
import { discoverGeminiCatalog } from "./GeminiCatalog.ts";

const GEMINI_PRESENTATION = {
  displayName: "Gemini",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const GEMINI_ACP_INITIALIZE_TIMEOUT_MS = 20_000;

const GEMINI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialGeminiProviderSnapshot(
  geminiSettings: GeminiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = geminiModelsFromSettings(geminiSettings.customModels);

    if (!geminiSettings.enabled) {
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Gemini is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Gemini CLI availability...",
      },
    });
  });
}

function geminiModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GEMINI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildGeminiDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveGeminiAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

const initializeGeminiAcp = (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    // Installation readiness must not authenticate, start MCP servers or read
    // project configuration from whichever directory launched the T3 server.
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gemini-probe-" });
    const acp = yield* makeGeminiAcpRuntime({
      geminiSettings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* acp.initialize();
  }).pipe(Effect.scoped);

const runGeminiVersionCommand = (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = geminiSettings.binaryPath || "gemini";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = geminiModelsFromSettings(geminiSettings.customModels);
  const catalog = yield* discoverGeminiCatalog(geminiSettings, undefined, environment);

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      ...catalog,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runGeminiVersionCommand(geminiSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Gemini CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      ...catalog,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Gemini CLI (`gemini`) is not installed or not on PATH."
          : "Failed to execute Gemini CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      ...catalog,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Gemini CLI is installed but timed out while running `gemini --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Gemini CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      ...catalog,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Gemini CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* initializeGeminiAcp(geminiSettings, environment).pipe(
    Effect.timeoutOption(GEMINI_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Gemini ACP initialization failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      ...catalog,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Gemini CLI is installed but ACP initialization failed. Verify the configured executable supports --acp (tested with 0.59.0). Run it from the project's terminal to see its startup diagnostic.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Gemini ACP initialization timed out after ${GEMINI_ACP_INITIALIZE_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      ...catalog,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Gemini CLI is installed but ACP initialization timed out after ${GEMINI_ACP_INITIALIZE_TIMEOUT_MS}ms. Run the configured executable with --acp from the project's terminal to inspect startup.`,
      },
    });
  }

  return buildServerProvider({
    presentation: GEMINI_PRESENTATION,
    enabled: geminiSettings.enabled,
    checkedAt,
    models: fallbackModels,
    ...catalog,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichGeminiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Gemini version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
